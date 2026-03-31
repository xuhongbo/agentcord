import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleOutputStream = vi.fn();
const getSession = vi.fn();
const setMonitorGoal = vi.fn();
const updateWorkflowState = vi.fn();
const sendPrompt = vi.fn();
const continueSession = vi.fn();
const sendMonitorPrompt = vi.fn();
const consumeAbortReason = vi.fn();
const updateSessionState = vi.fn();
const queueDigest = vi.fn();
const handleResultEvent = vi.fn();
const handleAwaitingHuman = vi.fn();

vi.mock('../src/output-handler.ts', () => ({
  handleOutputStream,
}));

vi.mock('../src/panel-adapter.ts', () => ({
  updateSessionState,
  queueDigest,
  handleResultEvent,
  handleAwaitingHuman,
}));

vi.mock('../src/thread-manager.ts', () => ({
  getSession,
  setMonitorGoal,
  updateWorkflowState,
  sendPrompt,
  continueSession,
  sendMonitorPrompt,
  consumeAbortReason,
  abortSessionWithReason: vi.fn(),
}));

const { executeSessionPrompt } = await import('../src/session-executor.ts');

describe('executeSessionPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
  });

  it('persists the first monitor goal from the initial prompt', async () => {
    const session = {
      id: 'monitor-1',
      mode: 'monitor',
      monitorGoal: undefined,
      workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    };

    getSession.mockImplementation(() => session);
    handleOutputStream.mockResolvedValue({
      text: 'Completed the requested change.',
      askedUser: false,
      hadError: false,
      success: true,
      commandCount: 1,
      fileChangeCount: 3,
      recentCommands: [],
      changedFiles: ['src/file.ts'],
    });
    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          status: 'complete',
          confidence: 'high',
          rationale: 'Done',
          steering: '',
          completionSummary: 'Done',
          acceptedEvidence: ['Completed the requested change.'],
          missingEvidence: [],
          requiredNextProof: [],
          disallowedDrift: [],
          blockingReason: '',
        }),
      };
    });
    consumeAbortReason.mockReturnValue(undefined);

    const channel = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    await executeSessionPrompt(
      session as Parameters<typeof executeSessionPrompt>[0],
      channel as Parameters<typeof executeSessionPrompt>[1],
      'Fix the failing workflow.',
    );

    expect(setMonitorGoal).toHaveBeenCalledWith('monitor-1', 'Fix the failing workflow.');
  });

  it('monitor 完成时通过 panel-adapter 收尾而不是直接发频道消息', async () => {
    const session = {
      id: 'monitor-2',
      mode: 'monitor',
      monitorGoal: 'Fix the failing workflow.',
      workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    };

    getSession.mockImplementation(() => session);
    handleOutputStream.mockResolvedValue({
      text: 'Completed the requested change.',
      askedUser: false,
      hadError: false,
      success: true,
      commandCount: 1,
      fileChangeCount: 1,
      recentCommands: [],
      changedFiles: ['src/file.ts'],
    });
    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          status: 'complete',
          confidence: 'high',
          rationale: 'Done',
          steering: '',
          completionSummary: 'Done',
          acceptedEvidence: ['Completed the requested change.'],
          missingEvidence: [],
          requiredNextProof: [],
          disallowedDrift: [],
          blockingReason: '',
        }),
      };
    });
    consumeAbortReason.mockReturnValue(undefined);

    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    await executeSessionPrompt(session as never, channel as never, 'Fix the failing workflow.');

    expect(handleResultEvent).toHaveBeenCalled();
    const call = handleResultEvent.mock.calls.at(-1);
    expect(call?.[0]).toBe('monitor-2');
    expect(call?.[2]).toBe('Done');
    expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('Monitor: completion bar met'));
  });

  it('monitor 认为 ask_user 需要人工时会挂出交互卡', async () => {
    const session = {
      id: 'monitor-ask',
      mode: 'monitor',
      monitorGoal: 'Finish the task',
      provider: 'codex',
      workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    };

    getSession.mockImplementation(() => session);
    handleOutputStream.mockResolvedValue({
      text: 'Need human input',
      askedUser: true,
      askUserQuestionsJson: JSON.stringify({ questions: [{ question: 'Continue?' }] }),
      hadError: false,
      success: true,
      commandCount: 0,
      fileChangeCount: 0,
      recentCommands: [],
      changedFiles: [],
    });
    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          shouldAskHuman: true,
          rationale: 'Human approval required.',
          autoResponse: '',
        }),
      };
    });
    consumeAbortReason.mockReturnValue(undefined);

    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    await executeSessionPrompt(session as never, channel as never, 'Finish the task');

    expect(handleAwaitingHuman).toHaveBeenCalledWith(
      'monitor-ask',
      JSON.stringify({ questions: [{ question: 'Continue?' }] }),
      expect.objectContaining({ source: 'codex' }),
    );
  });

  it('monitor 判断 blocked 时会挂出交互卡', async () => {
    const session = {
      id: 'monitor-blocked',
      mode: 'monitor',
      monitorGoal: 'Finish the task',
      provider: 'codex',
      workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    };

    getSession.mockImplementation(() => session);
    handleOutputStream.mockResolvedValue({
      text: 'Worker stalled',
      askedUser: false,
      hadError: false,
      success: true,
      commandCount: 1,
      fileChangeCount: 1,
      recentCommands: [],
      changedFiles: ['src/file.ts'],
    });
    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          status: 'blocked',
          confidence: 'high',
          rationale: 'Need human help',
          steering: '',
          completionSummary: '',
          acceptedEvidence: [],
          missingEvidence: ['Manual decision'],
          requiredNextProof: ['Human decision'],
          disallowedDrift: [],
          blockingReason: 'Need human help',
        }),
      };
    });
    consumeAbortReason.mockReturnValue(undefined);

    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    await executeSessionPrompt(session as never, channel as never, 'Finish the task');

    expect(handleAwaitingHuman).toHaveBeenCalledWith(
      'monitor-blocked',
      'Need human help',
      expect.objectContaining({ source: 'codex' }),
    );
  });
});
