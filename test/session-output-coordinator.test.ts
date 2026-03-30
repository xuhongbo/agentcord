import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
vi.mock('../src/thread-manager.ts', () => ({ getSession }));

const {
  registerSessionStatusMessage,
  updateSessionStatus,
  queueSessionDigest,
  flushSessionDigest,
  finalizeSessionPresentation,
  resetSessionPresentationState,
} = await import('../src/session-output-coordinator.ts');

function createMessage(content = '') {
  return {
    content,
    components: [{ id: 'controls' }],
    pin: vi.fn(async () => undefined),
    edit: vi.fn(async (payload) => payload),
  };
}

function createChannel() {
  return {
    send: vi.fn(async (payload) => createMessage(payload?.content ?? '')),
  };
}

const session = {
  id: 's1',
  mode: 'auto',
  provider: 'codex',
  agentLabel: 'demo',
  claudePermissionMode: undefined,
  workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
};

describe('session-output-coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionPresentationState();
    getSession.mockReturnValue(session);
    vi.useRealTimers();
  });

  it('注册状态消息时会执行 pin', async () => {
    const channel = createChannel();
    const message = createMessage();

    await registerSessionStatusMessage(session as never, channel as never, message as never);

    expect(message.pin).toHaveBeenCalled();
  });

  it('状态更新通过 edit 常驻消息而不是新发消息', async () => {
    const channel = createChannel();
    const message = createMessage();
    await registerSessionStatusMessage(session as never, channel as never, message as never);

    await updateSessionStatus(session as never, channel as never, {
      state: 'running',
      phase: '验证中',
      summary: '正在执行回归测试',
    });

    expect(message.edit).toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('摘要只维护一条消息并通过 edit 刷新', async () => {
    const channel = createChannel();
    const message = createMessage();
    await registerSessionStatusMessage(session as never, channel as never, message as never);

    queueSessionDigest(session.id, '已运行 2 个命令');
    await flushSessionDigest(session as never, channel as never, true);
    queueSessionDigest(session.id, '已修改 3 个文件');
    await flushSessionDigest(session as never, channel as never, true);

    expect(channel.send).toHaveBeenCalledTimes(1);
  });



  it('首次摘要刷新会创建摘要消息，后续只编辑不重复新发', async () => {
    const channel = createChannel();
    const message = createMessage();
    await registerSessionStatusMessage(session as never, channel as never, message as never);

    queueSessionDigest(session.id, '第一条摘要');
    await flushSessionDigest(session as never, channel as never, true);
    queueSessionDigest(session.id, '第二条摘要');
    await flushSessionDigest(session as never, channel as never, true);

    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('非强制摘要刷新遵守时间窗节流', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-30T10:00:00Z'));
    const channel = createChannel();
    const message = createMessage();
    await registerSessionStatusMessage(session as never, channel as never, message as never);

    queueSessionDigest(session.id, '第一条摘要');
    await flushSessionDigest(session as never, channel as never, false);

    queueSessionDigest(session.id, '第二条摘要');
    await flushSessionDigest(session as never, channel as never, false);
    expect(channel.send).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-03-30T10:00:16Z'));
    await flushSessionDigest(session as never, channel as never, false);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });



  it('会把命令、文件、错误按类别聚合成更可读的摘要', async () => {
    const channel = createChannel();
    const message = createMessage();
    await registerSessionStatusMessage(session as never, channel as never, message as never);

    queueSessionDigest(session.id, { kind: 'command', text: 'pnpm test' });
    queueSessionDigest(session.id, { kind: 'file', text: 'src/config.ts' });
    queueSessionDigest(session.id, { kind: 'error', text: '测试失败' });
    await flushSessionDigest(session as never, channel as never, true);

    const payload = channel.send.mock.calls[0][0];
    const embed = payload.embeds[0];
    expect(embed.data.description).toContain('最近进展');
    expect(embed.data.description).toContain('命令');
    expect(embed.data.description).toContain('文件');
    expect(embed.data.description).toContain('风险');
  });

  it('同类高频事件会折叠而不是无限堆叠', async () => {
    const channel = createChannel();
    const message = createMessage();
    await registerSessionStatusMessage(session as never, channel as never, message as never);

    queueSessionDigest(session.id, { kind: 'command', text: 'npm test' });
    queueSessionDigest(session.id, { kind: 'command', text: 'pnpm lint' });
    queueSessionDigest(session.id, { kind: 'command', text: 'pnpm typecheck' });
    await flushSessionDigest(session as never, channel as never, true);

    const payload = channel.send.mock.calls[0][0];
    const desc = payload.embeds[0].data.description;
    expect(desc).toContain('命令');
    expect(desc).toContain('另有');
  });





  it('本轮总结与结束总结语义分离：本轮完成不应叫结束总结', async () => {
    const channel = createChannel();
    const message = createMessage();
    await registerSessionStatusMessage(session as never, channel as never, message as never);

    await finalizeSessionPresentation(session as never, channel as never, {
      outcome: 'completed',
      summary: '本轮已经完成检查',
      terminal: false,
    });

    const finalPayload = channel.send.mock.calls.at(-1)?.[0];
    const finalEmbed = finalPayload.embeds[0];
    expect(finalEmbed.data.title).toContain('本轮总结');
    expect(finalEmbed.data.title).not.toContain('结束总结');
  });

  it('本轮完成后状态卡回到待命而不是已结束', async () => {
    const channel = createChannel();
    const message = createMessage();
    await registerSessionStatusMessage(session as never, channel as never, message as never);

    await finalizeSessionPresentation(session as never, channel as never, {
      outcome: 'completed',
      summary: '本轮已经完成检查',
      terminal: false,
    });

    const editPayload = message.edit.mock.calls.at(-1)?.[0];
    const statusEmbed = editPayload.embeds[0];
    expect(statusEmbed.data.title).toContain('待命');
    expect(statusEmbed.data.description).toBe('等待下一条消息');
  });

  it('结束收尾时状态卡只更新状态短语，不写入长总结内容', async () => {
    const channel = createChannel();
    const message = createMessage();
    await registerSessionStatusMessage(session as never, channel as never, message as never);

    await finalizeSessionPresentation(session as never, channel as never, {
      outcome: 'completed',
      summary: '这里是一大段详细结果，只应该出现在结束总结消息里，而不应该进入状态卡',
    });

    const editPayload = message.edit.mock.calls.at(-1)?.[0];
    const statusEmbed = editPayload.embeds[0];
    expect(statusEmbed.data.description).toBe('任务已结束');
    expect(statusEmbed.data.description).not.toContain('详细结果');

    const finalPayload = channel.send.mock.calls.at(-1)?.[0];
    const finalEmbed = finalPayload.embeds[0];
    expect(finalEmbed.data.description).toContain('详细结果');
  });



  it('本轮总结超长时会拆成多段消息而不是截断', async () => {
    const channel = createChannel();
    const message = createMessage();
    await registerSessionStatusMessage(session as never, channel as never, message as never);
    const longSummary = 'A'.repeat(5000) + 'B'.repeat(5000);

    await finalizeSessionPresentation(session as never, channel as never, {
      outcome: 'completed',
      summary: longSummary,
      terminal: false,
    });

    expect(channel.send).toHaveBeenCalledTimes(3);
    const parts = channel.send.mock.calls.map((call) => call[0].embeds[0].data.description).join('');
    expect(parts.includes('A'.repeat(200))).toBe(true);
    expect(parts.includes('B'.repeat(200))).toBe(true);
    expect(parts.includes('…')).toBe(false);
  });

  it('结束总结只发送一次', async () => {
    const channel = createChannel();
    const message = createMessage();
    await registerSessionStatusMessage(session as never, channel as never, message as never);

    await finalizeSessionPresentation(session as never, channel as never, {
      outcome: 'completed',
      summary: '任务已完成',
    });
    await finalizeSessionPresentation(session as never, channel as never, {
      outcome: 'completed',
      summary: '任务已完成',
    });

    expect(channel.send).toHaveBeenCalledTimes(1);
  });
});
