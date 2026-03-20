import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as sessions from '../src/session-manager.ts';
import { executeSessionPrompt } from '../src/session-executor.ts';

const directory = process.env.MONITOR_E2E_DIR || '/Users/manuelatravajo/Documents/agentcord-monitor-e2e';
const projectName = process.env.MONITOR_E2E_PROJECT || 'agentcord-monitor-e2e';
const sessionName = process.env.MONITOR_E2E_SESSION || 'monitor-e2e';
const prompt = process.env.MONITOR_E2E_PROMPT || `Create a robust, difficult, hard-to-pass memory benchmark in this repository.

Requirements:
- Produce the benchmark as concrete files in the repo, not just a description.
- Include at least one benchmark spec, one grading rubric, and one adversarial-case section.
- Make it difficult for a shallow model to pass by tightening the scoring criteria.
- Do not stop at the first draft; strengthen weak spots until the benchmark is genuinely hard to game.
- When complete, summarize what changed and why the final result is robust.`;

mkdirSync(directory, { recursive: true });

const session = await sessions.createSession(
  sessionName,
  directory,
  'pending',
  projectName,
  'codex',
);

sessions.setMode(session.id, 'monitor');

const sentMessages: string[] = [];
const channel = {
  topic: null as string | null,
  async send(payload: any) {
    const text = typeof payload === 'string'
      ? payload
      : payload?.content
        ? String(payload.content)
        : payload?.embeds?.map((e: any) => `${e.data?.title || ''}\n${e.data?.description || ''}`).join('\n')
          || JSON.stringify(payload);
    sentMessages.push(text);
    process.stdout.write(`\n--- CHANNEL SEND ---\n${text}\n`);
    return payload;
  },
  async sendTyping() {
    return;
  },
  async setTopic(nextTopic: string) {
    this.topic = nextTopic;
    process.stdout.write(`\n--- CHANNEL TOPIC ---\n${nextTopic}\n`);
    return this;
  },
};

try {
  await executeSessionPrompt(sessions.getSession(session.id)!, channel as any, prompt, {
    updateMonitorGoal: true,
  });

  const monitorPasses = sentMessages.filter(msg => msg.includes('Monitor: pass')).length;
  const completion = sentMessages.find(msg => msg.includes('completion bar met')) || '(none)';
  const result = {
    sessionId: session.id,
    directory,
    monitorPasses,
    completion,
    messages: sentMessages,
  };
  writeFileSync(join(directory, 'monitor-e2e-result.json'), JSON.stringify(result, null, 2), 'utf-8');
  process.stdout.write(`\n=== SUMMARY ===\n${JSON.stringify(result, null, 2)}\n`);
} finally {
  await sessions.endSession(session.id).catch(() => {});
}
