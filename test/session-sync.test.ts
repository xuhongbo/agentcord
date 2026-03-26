import { beforeEach, describe, expect, it, vi } from 'vitest';

const listCodexSessionsForProjectsMock = vi.fn();
const getAllRegisteredProjectsMock = vi.fn();
const updateProjectDiscordMock = vi.fn();
const getAllSessionsMock = vi.fn();
const createSyncedSessionMock = vi.fn();
const listSessionsMock = vi.fn();

vi.mock('../src/codex-session-discovery.ts', () => ({
  listCodexSessionsForProjects: listCodexSessionsForProjectsMock,
}));

vi.mock('../src/project-registry.ts', () => ({
  getAllRegisteredProjects: getAllRegisteredProjectsMock,
  updateProjectDiscord: updateProjectDiscordMock,
}));

vi.mock('../src/session-manager.ts', () => ({
  getAllSessions: getAllSessionsMock,
  createSyncedSession: createSyncedSessionMock,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions: listSessionsMock,
}));

function makeClient() {
  const create = vi.fn()
    .mockResolvedValueOnce({ id: 'cat-1', type: 4 })
    .mockResolvedValueOnce({ id: 'chan-1' });
  const guild = {
    channels: {
      cache: {
        get: vi.fn().mockReturnValue(undefined),
        find: vi.fn().mockReturnValue(undefined),
      },
      create,
    },
  };

  return {
    client: {
      guilds: {
        cache: {
          first: () => guild,
        },
      },
    },
    create,
  };
}

describe('session-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllSessionsMock.mockReturnValue([]);
    listSessionsMock.mockResolvedValue([]);
    listCodexSessionsForProjectsMock.mockReturnValue([]);
    getAllRegisteredProjectsMock.mockReturnValue([
      { name: 'proj', path: '/repo/proj', discordCategoryId: undefined, discordLogChannelId: undefined },
    ]);
  });

  it('syncs new Claude sessions', async () => {
    const { startSync, stopSync } = await import('../src/session-sync.ts');
    const { client } = makeClient();
    listSessionsMock.mockResolvedValue([{ sessionId: 'claude-1', summary: 'Fix auth' }]);

    startSync(client as any);
    await new Promise(res => setTimeout(res, 20));
    stopSync();

    expect(createSyncedSessionMock).toHaveBeenCalledWith(
      'claude-claude-1',
      'chan-1',
      '/repo/proj',
      'proj',
      'claude',
      'claude-1',
    );
  });

  it('does not duplicate already-synced provider session', async () => {
    const { startSync, stopSync } = await import('../src/session-sync.ts');
    const { client } = makeClient();
    getAllSessionsMock.mockReturnValue([{ providerSessionId: 'codex-1' }]);
    listCodexSessionsForProjectsMock.mockReturnValue([
      { id: 'codex-1', threadName: 'Thread', projectPath: '/repo/proj', cwd: '/repo/proj' },
    ]);

    startSync(client as any);
    await new Promise(res => setTimeout(res, 20));
    stopSync();

    expect(createSyncedSessionMock).not.toHaveBeenCalled();
  });
});
