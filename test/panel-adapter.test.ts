import { beforeEach, describe, expect, it, vi } from 'vitest';

const statusInitialize = vi.fn();
const statusUpdate = vi.fn();
const statusGetMessageId = vi.fn(() => 'status-1');
const statusAdopt = vi.fn();
const sendTurnSummary = vi.fn();
const sendTurnFailure = vi.fn();
const sendEndingSummary = vi.fn();
const sendDigestSummary = vi.fn();
const interactionShow = vi.fn();
const interactionHide = vi.fn();
const getSession = vi.fn();
const updateSession = vi.fn();
const setStatusCardBinding = vi.fn();
const setCurrentInteractionMessage = vi.fn();

vi.mock('../src/discord/status-card.ts', () => ({
  StatusCard: class {
    adopt = statusAdopt;
    initialize = statusInitialize;
    update = statusUpdate;
    getMessageId = statusGetMessageId;
  },
}));

vi.mock('../src/discord/summary-handler.ts', () => ({
  SummaryHandler: class {
    sendTurnSummary = sendTurnSummary;
    sendTurnFailure = sendTurnFailure;
    sendEndingSummary = sendEndingSummary;
    sendDigestSummary = sendDigestSummary;
  },
}));

vi.mock('../src/discord/interaction-card.ts', () => ({
  InteractionCard: class {
    show = interactionShow;
    hide = interactionHide;
  },
}));

vi.mock('../src/thread-manager.ts', () => ({
  getSession,
  updateSession,
  setStatusCardBinding,
  setCurrentInteractionMessage,
}));

const { initializeSessionPanel, handleResultEvent } = await import('../src/panel-adapter.ts');

function createChannel() {
  return {
    send: vi.fn(async () => ({ id: 'message-1', pin: vi.fn(async () => undefined) })),
    messages: {
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
  };
}

describe('panel-adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockImplementation((sessionId: string) => ({
      id: sessionId,
      provider: 'codex',
      currentTurn: 3,
      humanResolved: false,
      statusCardMessageId: undefined,
    }));
  });

  it('失败结果使用失败总结并保留当前轮次', async () => {
    const channel = createChannel();
    await initializeSessionPanel('session-error', channel as never, { initialTurn: 3 });

    await handleResultEvent(
      'session-error',
      {
        type: 'result',
        success: false,
        costUsd: 0,
        durationMs: 10,
        numTurns: 1,
        errors: ['命令执行失败'],
      },
      '',
    );

    expect(sendTurnFailure).toHaveBeenCalledWith('命令执行失败', 3);
    expect(sendTurnSummary).not.toHaveBeenCalled();
    expect(statusUpdate).toHaveBeenLastCalledWith(
      'error',
      expect.objectContaining({ turn: 3 }),
    );
    expect(updateSession).not.toHaveBeenCalledWith(
      'session-error',
      expect.objectContaining({ currentTurn: 4 }),
    );
  });
});
