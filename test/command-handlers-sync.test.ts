import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';

const createSessionMock = vi.fn();
const listTmuxSessionsMock = vi.fn();
const getAllSessionsMock = vi.fn();
const getSessionByChannelMock = vi.fn();
const setModeMock = vi.fn();
const setMonitorGoalMock = vi.fn();
const linkChannelMock = vi.fn();
const makeModeButtonsMock = vi.fn(() => ({ components: [] }));

const getOrCreateProjectMock = vi.fn();
const getProjectByCategoryIdMock = vi.fn();
const getProjectMock = vi.fn();
const updateProjectCategoryMock = vi.fn();

vi.mock('../src/session-manager.ts', () => ({
  createSession: createSessionMock,
  listTmuxSessions: listTmuxSessionsMock,
  getAllSessions: getAllSessionsMock,
  getSessionByChannel: getSessionByChannelMock,
  getSession: vi.fn(),
  sendPrompt: vi.fn(),
  continueSession: vi.fn(),
  endSession: vi.fn(),
  abortSession: vi.fn(),
  setModel: vi.fn(),
  setVerbose: vi.fn(),
  setMode: setModeMock,
  setMonitorGoal: setMonitorGoalMock,
  getAttachInfo: vi.fn(),
  linkChannel: linkChannelMock,
}));

vi.mock('../src/project-manager.ts', () => ({
  getOrCreateProject: getOrCreateProjectMock,
  getProjectByCategoryId: getProjectByCategoryIdMock,
  getProject: getProjectMock,
  updateProjectCategory: updateProjectCategoryMock,
  setPersonality: vi.fn(),
  getPersonality: vi.fn(),
  clearPersonality: vi.fn(),
  addSkill: vi.fn(),
  removeSkill: vi.fn(),
  getSkills: vi.fn(),
  executeSkill: vi.fn(),
  addMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  listMcpServers: vi.fn(),
}));

vi.mock('../src/plugin-manager.ts', () => ({
  listAvailable: vi.fn(),
  installPlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
  listInstalled: vi.fn(),
  getPluginDetail: vi.fn(),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
  updatePlugin: vi.fn(),
  listMarketplaces: vi.fn(),
  addMarketplace: vi.fn(),
  removeMarketplace: vi.fn(),
  updateMarketplaces: vi.fn(),
}));

vi.mock('../src/agents.ts', () => ({
  listAgents: vi.fn(() => []),
  getAgent: vi.fn(),
}));

vi.mock('../src/output-handler.ts', () => ({
  handleOutputStream: vi.fn(),
  makeModeButtons: makeModeButtonsMock,
}));

vi.mock('../src/shell-handler.ts', () => ({
  executeShellCommand: vi.fn(),
  listProcesses: vi.fn(() => []),
  killProcess: vi.fn(),
}));

describe('/session sync codex recovery', () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    createSessionMock.mockReset();
    listTmuxSessionsMock.mockReset();
    getAllSessionsMock.mockReset();
    getSessionByChannelMock.mockReset();
    setModeMock.mockReset();
    setMonitorGoalMock.mockReset();
    linkChannelMock.mockReset();
    makeModeButtonsMock.mockClear();
    getOrCreateProjectMock.mockReset();
    getProjectByCategoryIdMock.mockReset();
    getProjectMock.mockReset();
    updateProjectCategoryMock.mockReset();

    process.env = { ...envSnapshot };
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.DISCORD_CLIENT_ID = '123456789012345678';
    process.env.ALLOW_ALL_USERS = 'true';
    process.env.ALLOWED_USERS = '';
    process.env.DEFAULT_DIRECTORY = '/tmp/default-project';
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
    vi.clearAllMocks();
  });

  it('recovers orphaned codex channels into in-memory sessions', async () => {
    getAllSessionsMock.mockReturnValue([]);
    listTmuxSessionsMock.mockResolvedValue([]);
    createSessionMock.mockResolvedValue({ id: 'fix-auth', channelId: 'chan-1' });

    const codexChannel = {
      id: 'chan-1',
      type: ChannelType.GuildText,
      name: 'codex-fix-auth',
      topic: 'OpenAI Codex session | Dir: /tmp/work-repo | Provider Session: thr_abc123',
      parentId: 'cat-1',
    };

    const guild = {
      channels: {
        cache: {
          values: () => [codexChannel][Symbol.iterator](),
        },
      },
    };

    const interaction = {
      user: { id: 'user-1' },
      options: {
        getSubcommand: () => 'sync',
      },
      guild,
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleSession } = await import('../src/command-handlers.ts');
    await handleSession(interaction as any);

    expect(createSessionMock).toHaveBeenCalledWith(
      'fix-auth',
      '/tmp/work-repo',
      'chan-1',
      'work-repo',
      'codex',
      'thr_abc123',
      { recoverExisting: true },
    );
    expect(getOrCreateProjectMock).toHaveBeenCalledWith('work-repo', '/tmp/work-repo', 'cat-1');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Synced 1 orphaned session(s)'));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('(1 channel)'));
  });

  it('falls back to default directory when channel topic has no Dir metadata', async () => {
    getAllSessionsMock.mockReturnValue([]);
    listTmuxSessionsMock.mockResolvedValue([]);
    createSessionMock.mockResolvedValue({ id: 'orphan', channelId: 'chan-2' });

    const codexChannel = {
      id: 'chan-2',
      type: ChannelType.GuildText,
      name: 'codex-orphan',
      topic: 'OpenAI Codex session | Provider Session: thr_fallback',
      parentId: 'cat-2',
    };

    const guild = {
      channels: {
        cache: {
          values: () => [codexChannel][Symbol.iterator](),
        },
      },
    };

    const interaction = {
      user: { id: 'user-1' },
      options: {
        getSubcommand: () => 'sync',
      },
      guild,
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleSession } = await import('../src/command-handlers.ts');
    await handleSession(interaction as any);

    expect(createSessionMock).toHaveBeenCalledWith(
      'orphan',
      '/tmp/default-project',
      'chan-2',
      'default-project',
      'codex',
      'thr_fallback',
      { recoverExisting: true },
    );
    expect(getOrCreateProjectMock).toHaveBeenCalledWith('default-project', '/tmp/default-project', 'cat-2');
  });

  it('applies the requested initial mode when creating a new session', async () => {
    getProjectMock.mockReturnValue(undefined);
    getOrCreateProjectMock.mockReturnValue({ categoryId: 'cat-1', logChannelId: 'log-1' });
    createSessionMock.mockResolvedValue({
      id: 'bench-run',
      directory: '/tmp/work-repo',
      tmuxName: '',
      mode: 'auto',
    });

    const createdChannel = {
      id: 'chan-new',
      send: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const guild = {
      channels: {
        cache: {
          get: vi.fn().mockReturnValue(undefined),
          find: vi.fn().mockReturnValue(undefined),
        },
        create: vi.fn()
          .mockResolvedValueOnce({ id: 'cat-1', children: { cache: { find: vi.fn().mockReturnValue(undefined) } } })
          .mockResolvedValueOnce({ id: 'log-1' })
          .mockResolvedValueOnce(createdChannel),
      },
    };

    const interaction = {
      user: { id: 'user-1', tag: 'user#0001' },
      guild,
      channel: { parentId: null },
      options: {
        getSubcommand: () => 'new',
        getString: (name: string, required?: boolean) => {
          if (name === 'name') return 'bench-run';
          if (name === 'provider') return 'codex';
          if (name === 'mode') return 'monitor';
          if (name === 'directory') return '/tmp/work-repo';
          if (name === 'sandbox-mode' || name === 'approval-policy') return null;
          if (required) throw new Error(`Unexpected required option: ${name}`);
          return null;
        },
        getBoolean: () => null,
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleSession } = await import('../src/command-handlers.ts');
    await handleSession(interaction as any);

    expect(setModeMock).toHaveBeenCalledWith('bench-run', 'monitor');
    expect(linkChannelMock).toHaveBeenCalledWith('bench-run', 'chan-new');
    expect(makeModeButtonsMock).toHaveBeenCalledWith('bench-run', 'monitor');
    expect(createdChannel.send).toHaveBeenCalledWith(expect.objectContaining({
      components: [expect.anything()],
    }));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      embeds: [expect.anything()],
    }));
  });

  it('normalizes stale monitor mode values when changing an active session mode', async () => {
    getSessionByChannelMock.mockReturnValue({
      id: 'sess-1',
      mode: 'auto',
    });

    const interaction = {
      user: { id: 'user-1' },
      channelId: 'chan-1',
      options: {
        getSubcommand: () => 'mode',
        getString: (name: string) => {
          if (name === 'mode') return 'Monitor — keep steering until complete';
          return null;
        },
      },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleSession } = await import('../src/command-handlers.ts');
    await handleSession(interaction as any);

    expect(setModeMock).toHaveBeenCalledWith('sess-1', 'monitor');
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining('Monitor'),
      ephemeral: true,
    });
    expect(interaction.reply).not.toHaveBeenCalledWith({
      content: expect.stringContaining('undefined'),
      ephemeral: true,
    });
  });

  it('shows the current saved monitor goal for a session', async () => {
    getSessionByChannelMock.mockReturnValue({
      id: 'sess-1',
      mode: 'monitor',
      monitorGoal: 'Build a stricter benchmark pack.',
    });

    const interaction = {
      user: { id: 'user-1' },
      channelId: 'chan-1',
      options: {
        getSubcommand: () => 'goal',
        getString: () => null,
        getBoolean: () => null,
      },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleSession } = await import('../src/command-handlers.ts');
    await handleSession(interaction as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Current monitor goal:\n> Build a stricter benchmark pack.',
      ephemeral: true,
    });
  });

  it('updates the monitor goal explicitly during a session', async () => {
    getSessionByChannelMock.mockReturnValue({
      id: 'sess-1',
      mode: 'monitor',
      monitorGoal: 'old goal',
    });

    const interaction = {
      user: { id: 'user-1' },
      channelId: 'chan-1',
      options: {
        getSubcommand: () => 'goal',
        getString: (name: string) => name === 'goal' ? 'Make the benchmark harder against contradiction attacks.' : null,
        getBoolean: () => null,
      },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleSession } = await import('../src/command-handlers.ts');
    await handleSession(interaction as any);

    expect(setMonitorGoalMock).toHaveBeenCalledWith('sess-1', 'Make the benchmark harder against contradiction attacks.');
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Monitor goal updated:\n> Make the benchmark harder against contradiction attacks.',
      ephemeral: true,
    });
  });

  it('clears the monitor goal explicitly during a session', async () => {
    getSessionByChannelMock.mockReturnValue({
      id: 'sess-1',
      mode: 'monitor',
      monitorGoal: 'old goal',
    });

    const interaction = {
      user: { id: 'user-1' },
      channelId: 'chan-1',
      options: {
        getSubcommand: () => 'goal',
        getString: () => null,
        getBoolean: (name: string) => name === 'clear' ? true : null,
      },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleSession } = await import('../src/command-handlers.ts');
    await handleSession(interaction as any);

    expect(setMonitorGoalMock).toHaveBeenCalledWith('sess-1', undefined);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Monitor goal cleared for this session.',
      ephemeral: true,
    });
  });
});
