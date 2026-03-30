import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent } from '../src/providers/types.ts';

const mocks = vi.hoisted(() => ({
  updateSessionStatus: vi.fn(),
  queueSessionDigest: vi.fn(),
  flushSessionDigest: vi.fn(),
  finalizeSessionPresentation: vi.fn(),
  incrementSessionCounters: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../src/session-output-coordinator.ts', () => ({
  updateSessionStatus: mocks.updateSessionStatus,
  queueSessionDigest: mocks.queueSessionDigest,
  flushSessionDigest: mocks.flushSessionDigest,
  finalizeSessionPresentation: mocks.finalizeSessionPresentation,
  incrementSessionCounters: mocks.incrementSessionCounters,
}));
vi.mock('../src/thread-manager.ts', () => ({
  getSession: mocks.getSession,
  getSessionByChannel: vi.fn(),
  updateWorkflowState: vi.fn(),
  setMode: vi.fn(),
}));

const { handleOutputStream } = await import('../src/output-handler.ts');

function createFakeChannel() {
  const sent: unknown[] = [];
  return {
    sent,
    async send(payload: unknown) {
      sent.push(payload);
      return {
        content:
          typeof payload === 'object' && payload && 'content' in (payload as Record<string, unknown>)
            ? String((payload as Record<string, unknown>).content ?? '')
            : '',
        components: [],
        pin: vi.fn(async () => undefined),
        edit: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      };
    },
    async sendTyping() {},
  };
}

async function* streamEvents(events: ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('handleOutputStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockReturnValue({
      id: 'session-1',
      agentLabel: 'demo',
      provider: 'codex',
      mode: 'auto',
      workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    });
  });

  it('高频命令与文件事件进入聚合器而不是逐条发消息', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'Completed the requested change.' },
        {
          type: 'command_execution',
          command: 'pnpm test',
          output: 'ok',
          exitCode: 0,
          status: 'completed',
        },
        {
          type: 'file_change',
          changes: [{ filePath: 'src/file.ts', changeKind: 'update' }],
        },
        { type: 'result', success: true, costUsd: 0, durationMs: 25, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.queueSessionDigest).toHaveBeenCalled();
    expect(mocks.finalizeSessionPresentation).toHaveBeenCalled();
    expect(channel.sent).toEqual([]);
  });

  it('ask_user 仍会直接发送交互问题', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        {
          type: 'ask_user',
          questionsJson: JSON.stringify({
            questions: [{ header: 'Question', question: 'Continue?', options: [{ label: 'Yes' }] }],
          }),
        },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-2',
    );

    expect(channel.sent.length).toBe(1);
    expect(mocks.updateSessionStatus).toHaveBeenCalled();
  });
});
