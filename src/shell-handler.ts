import { execa } from 'execa';
import type { TextChannel, AnyThreadChannel } from 'discord.js';
import type { ShellProcess } from './types.ts';
import {
  finalizeSessionPresentation,
  flushSessionDigest,
  queueSessionDigest,
  updateSessionStatus,
} from './session-output-coordinator.ts';
import { truncate } from './utils.ts';

type SessionChannel = TextChannel | AnyThreadChannel;

const runningProcesses = new Map<number, ShellProcess>();
const execaProcesses = new Map<number, ReturnType<typeof execa>>();
let pidCounter = 0;

const TIMEOUT_MS = 60_000;
const DISCORD_OP_TIMEOUT_MS = 5_000;

async function withDiscordTimeout<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DISCORD_OP_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

function renderShellOutput(command: string, output: string): string {
  const display = truncate(output || '(no output)', 1900);
  return `\`\`\`\n$ ${command}\n${display}\n\`\`\``;
}

export async function executeShellCommand(
  command: string,
  cwd: string,
  channel: SessionChannel,
): Promise<void> {
  const pid = ++pidCounter;

  const child = execa('bash', ['-lc', command], {
    cwd,
    env: process.env,
    reject: false,
    timeout: TIMEOUT_MS,
    all: true,
  });

  const shellProcess: ShellProcess = {
    pid,
    command,
    startedAt: Date.now(),
    process: child as unknown as ShellProcess['process'],
  };

  runningProcesses.set(pid, shellProcess);
  execaProcesses.set(pid, child);
  await updateSessionStatus(
    {
      id: `shell-${pid}`,
      agentLabel: 'shell',
      provider: 'codex',
      mode: 'normal',
      workflowState: { status: 'worker_running', iteration: 1, updatedAt: Date.now() },
    },
    channel,
    {
      state: 'running',
      phase: '执行 shell 命令',
      summary: `正在执行：${truncate(command, 120)}`,
    },
  );
  queueSessionDigest(`shell-${pid}`, {
    kind: 'command',
    text: `执行命令：${truncate(command, 120)}`,
  });

  const result = await child;
  const output = [
    result.all?.trim() || '',
    result.timedOut ? '[Timed out after 60s]' : '',
    `[Exit code: ${result.exitCode ?? 'killed'}]`,
  ]
    .filter(Boolean)
    .join('\n');

  runningProcesses.delete(pid);
  execaProcesses.delete(pid);
  queueSessionDigest(`shell-${pid}`, {
    kind: 'command',
    text: `命令结束：退出码 ${result.exitCode ?? 'killed'}`,
  });
  await flushSessionDigest({ id: `shell-${pid}`, agentLabel: 'shell' }, channel, true);
  await finalizeSessionPresentation(
    {
      id: `shell-${pid}`,
      agentLabel: 'shell',
      provider: 'codex',
      mode: 'normal',
      workflowState: { status: 'completed', iteration: 1, updatedAt: Date.now() },
    },
    channel,
    {
      outcome: result.exitCode === 0 ? 'completed' : 'error',
      summary: renderShellOutput(command, output),
      terminal: false,
    },
  );
}

export function listProcesses(): ShellProcess[] {
  return Array.from(runningProcesses.values());
}

export function killProcess(pid: number): boolean {
  const proc = execaProcesses.get(pid);
  if (!proc) return false;
  proc.kill('SIGTERM');
  execaProcesses.delete(pid);
  runningProcesses.delete(pid);
  return true;
}
