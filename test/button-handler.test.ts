import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const updateSession = vi.fn();
const executeSessionContinue = vi.fn();
const executeSessionPrompt = vi.fn();
const updateSessionState = vi.fn();

vi.mock('../src/config.ts', () => ({
  config: {
    allowedUsers: [],
    allowAllUsers: true,
  },
}));

vi.mock('../src/utils.ts', () => ({
  isUserAllowed: () => true,
  truncate: (text: string) => text,
}));

vi.mock('../src/thread-manager.ts', () => ({
  getSession,
  updateSession,
  abortSession: vi.fn(() => false),
  setMode: vi.fn(),
}));

vi.mock('../src/output-handler.ts', () => ({
  getExpandableContent: vi.fn(),
  makeModeButtons: vi.fn(() => []),
  setPendingAnswer: vi.fn(),
  getPendingAnswers: vi.fn(),
  clearPendingAnswers: vi.fn(),
  getQuestionCount: vi.fn(() => 0),
}));

vi.mock('../src/session-executor.ts', () => ({
  executeSessionContinue,
  executeSessionPrompt,
}));

vi.mock('../src/panel-adapter.ts', () => ({
  updateSessionState,
}));

const { handleButton } = await import('../src/button-handler.ts');

function createInteraction(customId: string) {
  return {
    customId,
    user: { id: 'u1', tag: 'tester#1000' },
    channel: { id: 'c1', send: vi.fn(), messages: {} },
    message: { id: 'msg-active', embeds: [{ title: '等待人工处理' }] },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  };
}

describe('button-handler awaiting_human', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockReturnValue({
      id: 's1',
      currentTurn: 2,
      humanResolved: false,
      provider: 'codex',
      currentInteractionMessageId: 'msg-active',
    });
  });

  it('approve 会清理交互状态、同步状态并继续会话', async () => {
    const interaction = createInteraction('awaiting_human:s1:2:approve');

    await handleButton(interaction as never);

    expect(updateSession).toHaveBeenCalledWith('s1', {
      humanResolved: true,
      currentInteractionMessageId: undefined,
    });
    expect(updateSessionState).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ type: 'human_resolved', source: 'codex' }),
    );
    expect(executeSessionContinue).toHaveBeenCalled();
  });

  it('deny 会清理交互状态并回落到 idle，不继续会话', async () => {
    const interaction = createInteraction('awaiting_human:s1:2:deny');

    await handleButton(interaction as never);

    expect(updateSession).toHaveBeenCalledWith('s1', {
      humanResolved: true,
      currentInteractionMessageId: undefined,
    });
    expect(updateSessionState).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ type: 'session_idle', source: 'codex' }),
    );
    expect(executeSessionContinue).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it('当前消息不是有效交互消息时拒绝处理', async () => {
    const interaction = createInteraction('awaiting_human:s1:2:approve');
    interaction.message.id = 'msg-stale';

    await handleButton(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '此请求已过期', ephemeral: true }),
    );
    expect(executeSessionContinue).not.toHaveBeenCalled();
    expect(updateSessionState).not.toHaveBeenCalled();
  });

  it('旧问题卡按钮已废弃，返回提示', async () => {
    const interaction = createInteraction('answer:s1:0:Yes');

    await handleButton(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '⚠️ 此交互方式已废弃，请使用最新的交互卡',
        ephemeral: true,
      }),
    );
    expect(updateSession).not.toHaveBeenCalled();
    expect(updateSessionState).not.toHaveBeenCalled();
    expect(executeSessionPrompt).not.toHaveBeenCalled();
  });
});
