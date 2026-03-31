// Codex 日志监控器：增量读取 JSONL 日志
// 直接移植自 clawd-on-desk/agents/codex-log-monitor.js

import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const APPROVAL_HEURISTIC_MS = 2000;
const POLL_INTERVAL_MS = 1500;
const STALE_CLEANUP_MS = 300000; // 5 分钟

interface TrackedFile {
  offset: number;
  sessionId: string;
  cwd: string;
  lastEventTime: number;
  lastState: string | null;
  partial: string;
  hadToolUse: boolean;
  approvalTimer?: NodeJS.Timeout;
}

type StateChangeCallback = (
  sessionId: string,
  state: string,
  event: string,
  extra: { cwd: string; permissionDetail?: { command: string } },
) => void;

export class CodexLogMonitor {
  private tracked = new Map<string, TrackedFile>();
  private interval: NodeJS.Timeout | null = null;
  private baseDir: string;
  private onStateChange: StateChangeCallback;

  constructor(baseDir: string, onStateChange: StateChangeCallback) {
    this.baseDir = baseDir.startsWith('~')
      ? join(homedir(), baseDir.slice(1))
      : baseDir;
    this.onStateChange = onStateChange;
  }

  start(): void {
    if (this.interval) return;
    this.poll();
    this.interval = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    for (const tracked of this.tracked.values()) {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
    }
    this.tracked.clear();
  }

  private poll(): void {
    const dirs = this.getSessionDirs();
    for (const dir of dirs) {
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
        const filePath = join(dir, file);
        if (!this.tracked.has(filePath)) {
          try {
            const mtime = statSync(filePath).mtimeMs;
            if (now - mtime > 120000) continue;
          } catch {
            continue;
          }
        }
        this.pollFile(filePath, file);
      }
    }
    this.cleanStaleFiles();
  }

  private getSessionDirs(): string[] {
    const dirs: string[] = [];
    const now = new Date();
    for (let daysAgo = 0; daysAgo <= 7; daysAgo++) {
      const d = new Date(now);
      d.setDate(d.getDate() - daysAgo);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      dirs.push(join(this.baseDir, String(yyyy), mm, dd));
    }
    return dirs;
  }

  private pollFile(filePath: string, fileName: string): void {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return;
    }

    let tracked = this.tracked.get(filePath);
    if (!tracked) {
      const sessionId = this.extractSessionId(fileName);
      if (!sessionId) return;
      tracked = {
        offset: 0,
        sessionId: 'codex:' + sessionId,
        cwd: '',
        lastEventTime: Date.now(),
        lastState: null,
        partial: '',
        hadToolUse: false,
      };
      this.tracked.set(filePath, tracked);
    }

    if (stat.size <= tracked.offset) return;

    let buf: Buffer;
    try {
      const fd = openSync(filePath, 'r');
      const readLen = stat.size - tracked.offset;
      buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, tracked.offset);
      closeSync(fd);
    } catch {
      return;
    }
    tracked.offset = stat.size;

    const text = tracked.partial + buf.toString('utf8');
    const lines = text.split('\n');
    tracked.partial = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      this.processLine(line, tracked);
    }
  }

  private extractSessionId(fileName: string): string | null {
    const base = fileName.replace('.jsonl', '');
    const parts = base.split('-');
    if (parts.length < 10) return null;
    return parts.slice(-5).join('-');
  }

  private processLine(line: string, tracked: TrackedFile): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }

    const type = typeof obj.type === 'string' ? obj.type : '';
    const payload =
      obj.payload && typeof obj.payload === 'object'
        ? (obj.payload as Record<string, unknown>)
        : undefined;
    const subtype = typeof payload?.type === 'string' ? payload.type : '';
    const key = subtype ? `${type}:${subtype}` : type;

    if (type === 'session_meta' && payload) {
      tracked.cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    }

    if (key === 'event_msg:exec_command_end' || key === 'response_item:function_call_output') {
      if (tracked.approvalTimer) {
        clearTimeout(tracked.approvalTimer);
        tracked.approvalTimer = undefined;
      }
    }

    const state = this.mapEventToState(key);
    if (state === undefined) return;
    if (state === null) return;

    if (key === 'event_msg:task_started') tracked.hadToolUse = false;
    if (key === 'response_item:function_call') tracked.hadToolUse = true;

    if (state === 'codex-turn-end') {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
      const resolved = tracked.hadToolUse ? 'attention' : 'idle';
      tracked.hadToolUse = false;
      tracked.lastState = resolved;
      tracked.lastEventTime = Date.now();
      this.onStateChange(tracked.sessionId, resolved, key, { cwd: tracked.cwd });
      return;
    }

    if (key === 'response_item:function_call') {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
      const cmd = this.extractShellCommand(payload);
      if (cmd) {
        tracked.approvalTimer = setTimeout(() => {
          tracked.approvalTimer = undefined;
          tracked.lastEventTime = Date.now();
          this.onStateChange(tracked.sessionId, 'codex-permission', key, {
            cwd: tracked.cwd,
            permissionDetail: { command: cmd },
          });
        }, APPROVAL_HEURISTIC_MS);
      }
    }

    if (state === tracked.lastState && state === 'working') return;
    tracked.lastState = state;
    tracked.lastEventTime = Date.now();
    this.onStateChange(tracked.sessionId, state, key, { cwd: tracked.cwd });
  }

  private mapEventToState(key: string): string | null | undefined {
    const map: Record<string, string | null> = {
      'session_meta': 'idle',
      'event_msg:task_started': 'thinking',
      'event_msg:user_message': 'thinking',
      'event_msg:agent_message': null,
      'response_item:function_call': 'working',
      'response_item:custom_tool_call': 'working',
      'response_item:web_search_call': 'working',
      'event_msg:exec_command_start': 'working',
      'event_msg:task_complete': 'codex-turn-end',
      'event_msg:context_compacted': 'sweeping',
      'event_msg:turn_aborted': 'idle',
      'event_msg:error': 'error',
    };
    return map[key];
  }

  private extractShellCommand(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return '';
    if (!('name' in payload) || payload.name !== 'shell_command') return '';
    try {
      const rawArgs =
        'arguments' in payload
          ? payload.arguments
          : undefined;
      const args =
        typeof rawArgs === 'string'
          ? (JSON.parse(rawArgs) as Record<string, unknown>)
          : rawArgs;
      if (args && typeof args === 'object' && 'command' in args && args.command) {
        return String(args.command);
      }
    } catch {
      return '';
    }
    return '';
  }

  private cleanStaleFiles(): void {
    const now = Date.now();
    for (const [filePath, tracked] of this.tracked) {
      const age = now - tracked.lastEventTime;
      if (age > STALE_CLEANUP_MS) {
        if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
        this.onStateChange(tracked.sessionId, 'sleeping', 'stale-cleanup', { cwd: tracked.cwd });
        this.tracked.delete(filePath);
      }
    }
  }
}
