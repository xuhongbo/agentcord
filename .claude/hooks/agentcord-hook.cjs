#!/usr/bin/env node
// agentcord Hook - 实时同步 Claude Code 会话状态到 Discord
// 基于 clawd-on-desk/hooks/clawd-hook.js

const http = require('http');

// 事件到状态的映射
const EVENT_TO_STATE = {
  SessionStart: 'session_started',
  SessionEnd: 'session_ended',
  UserPromptSubmit: 'thinking_started',
  PreToolUse: 'work_started',
  PostToolUse: 'work_started',
  PostToolUseFailure: 'errored',
  Stop: 'completed',
  StopFailure: 'errored',
  SubagentStart: 'work_started',
  SubagentStop: 'work_started',
  PreCompact: 'compaction_started',
  PostCompact: 'completed',
};

const event = process.argv[2];
const state = EVENT_TO_STATE[event];
if (!state) process.exit(0);

// 读取 stdin 获取 session_id
const chunks = [];
let sent = false;

process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let sessionId = 'default';
  let cwd = '';
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    sessionId = payload.session_id || 'default';
    cwd = payload.cwd || '';
  } catch {}
  send(sessionId, cwd);
});

// 超时保护
setTimeout(() => send('default', ''), 400);

function send(sessionId, cwd) {
  if (sent) return;
  sent = true;

  const body = JSON.stringify({
    type: state,
    sessionId,
    source: 'claude',
    confidence: 'high',
    timestamp: Date.now(),
    metadata: {
      hookEvent: event,
      cwd,
    },
  });

  // 发送到 agentcord bot 的本地端点
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 48760, // agentcord bot 监听端口
      path: '/hook-event',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 100,
    },
    (res) => {
      res.resume();
      process.exit(0);
    }
  );

  req.on('error', () => process.exit(0));
  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });
  req.end(body);
}
