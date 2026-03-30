import { beforeEach, describe, expect, it, vi } from 'vitest';

const execa = vi.fn();
const updateSessionStatus = vi.fn();
const queueSessionDigest = vi.fn();
const flushSessionDigest = vi.fn();
const finalizeSessionPresentation = vi.fn();

vi.mock('execa', () => ({ execa }));
vi.mock('../src/session-output-coordinator.ts', () => ({
  updateSessionStatus,
  queueSessionDigest,
  flushSessionDigest,
  finalizeSessionPresentation,
}));

const { executeShellCommand } = await import('../src/shell-handler.ts');

describe('shell-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execa.mockReturnValue({
      all: 'done',
      exitCode: 0,
      timedOut: false,
      kill: vi.fn(),
      then: undefined,
    });
  });

  it('通过协调器展示 shell 执行状态与结束总结', async () => {
    const child = Promise.resolve({ all: 'done', exitCode: 0, timedOut: false });
    child.kill = vi.fn();
    execa.mockReturnValue(child);
    const channel = { send: vi.fn() };

    await executeShellCommand('pwd', '/repo', channel as never);

    expect(updateSessionStatus).toHaveBeenCalled();
    expect(queueSessionDigest).toHaveBeenCalled();
    expect(flushSessionDigest).toHaveBeenCalled();
    expect(finalizeSessionPresentation).toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });
});
