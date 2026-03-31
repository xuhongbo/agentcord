import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const endSession = vi.fn();
const getAllSessions = vi.fn();

vi.mock('../src/thread-manager.ts', () => ({
  getSession,
  endSession,
  getAllSessions,
}));

const { cleanupSessionsById, reconcileSessionRecordsWithGuild } = await import(
  '../src/session-housekeeping.ts'
);

function makeGuild(channels: Record<string, { id: string; delete: ReturnType<typeof vi.fn> } | null>) {
  return {
    channels: {
      cache: {
        get: vi.fn((id: string) => channels[id] ?? undefined),
      },
      fetch: vi.fn(async (id: string) => channels[id] ?? null),
    },
  };
}

describe('session-housekeeping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes existing channels and ends matching sessions', async () => {
    const deleteChannel = vi.fn(async () => undefined);
    const guild = makeGuild({
      'channel-1': { id: 'channel-1', delete: deleteChannel },
    });
    getSession.mockReturnValue({ id: 'session-1', channelId: 'channel-1' });
    endSession.mockResolvedValue(undefined);

    const result = await cleanupSessionsById(
      guild as never,
      ['session-1'],
      'cleanup smoke sessions',
    );

    expect(deleteChannel).toHaveBeenCalledWith('cleanup smoke sessions');
    expect(endSession).toHaveBeenCalledWith('session-1');
    expect(result).toEqual(
      expect.objectContaining({
        deletedChannels: 1,
        missingChannels: 0,
        endedSessions: 1,
      }),
    );
  });

  it('ends sessions even when the Discord channel is already missing', async () => {
    const guild = makeGuild({});
    getSession.mockReturnValue({ id: 'session-2', channelId: 'channel-2' });
    endSession.mockResolvedValue(undefined);

    const result = await cleanupSessionsById(guild as never, ['session-2']);

    expect(endSession).toHaveBeenCalledWith('session-2');
    expect(result).toEqual(
      expect.objectContaining({
        deletedChannels: 0,
        missingChannels: 1,
        endedSessions: 1,
      }),
    );
  });

  it('reconciles persisted sessions whose channels no longer exist', async () => {
    const deleteChannel = vi.fn(async () => undefined);
    const guild = makeGuild({
      'channel-1': { id: 'channel-1', delete: deleteChannel },
      'channel-2': null,
    });
    getAllSessions.mockReturnValue([
      { id: 'session-1', channelId: 'channel-1' },
      { id: 'session-2', channelId: 'channel-2' },
    ]);
    endSession.mockResolvedValue(undefined);

    const result = await reconcileSessionRecordsWithGuild(guild as never);

    expect(endSession).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledWith('session-2');
    expect(result).toEqual({ checkedSessions: 2, endedMissingSessions: 1 });
  });
});
