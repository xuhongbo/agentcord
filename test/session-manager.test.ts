import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

type ProviderStub = {
  supports: ReturnType<typeof vi.fn>;
  sendPrompt: ReturnType<typeof vi.fn>;
  continueSession: ReturnType<typeof vi.fn>;
};

const ensureProviderMock = vi.fn();

vi.mock('../src/providers/index.ts', () => ({
  ensureProvider: ensureProviderMock,
}));

vi.mock('../src/agents.ts', () => ({
  getAgent: () => undefined,
}));

vi.mock('../src/project-manager.ts', () => ({
  getPersonality: () => undefined,
}));

function makeProviderStub(): ProviderStub {
  return {
    supports: vi.fn().mockReturnValue(false),
    sendPrompt: vi.fn(),
    continueSession: vi.fn(),
  };
}

function setBaseEnv(): void {
  process.env.DISCORD_TOKEN = 'test-token';
  process.env.DISCORD_CLIENT_ID = '123456789012345678';
  process.env.ALLOW_ALL_USERS = 'true';
  process.env.ALLOWED_USERS = '';
  process.env.DEFAULT_DIRECTORY = process.cwd();
  process.env.ALLOWED_PATHS = '';
}

describe('session-manager', () => {
  const originalCwd = process.cwd();
  const envSnapshot = { ...process.env };
  let tmpCwd = '';

  beforeEach(() => {
    vi.resetModules();
    tmpCwd = mkdtempSync(join(tmpdir(), 'agentcord-session-test-'));
    process.chdir(tmpCwd);
    process.env = { ...envSnapshot };
    setBaseEnv();
    ensureProviderMock.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...envSnapshot };
    vi.clearAllMocks();
  });

  it('does not persist placeholder channels and only persists after linking', async () => {
    const provider = makeProviderStub();
    ensureProviderMock.mockResolvedValue(provider);
    const sessions = await import('../src/session-manager.ts');

    const session = await sessions.createSession('feature', tmpCwd, 'pending', 'project-x', 'codex');
    const storePath = join(tmpCwd, '.discord-friends', 'sessions.json');

    expect(existsSync(storePath)).toBe(false);
    expect(sessions.getSessionByChannel('pending')).toBeUndefined();

    await sessions.linkChannel(session.id, '12345');
    expect(sessions.getSessionByChannel('12345')?.id).toBe(session.id);

    const persisted = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].channelId).toBe('12345');
  });

  it('skips malformed persisted sessions (pending and duplicate channels) on load', async () => {
    const provider = makeProviderStub();
    ensureProviderMock.mockResolvedValue(provider);

    const storeDir = join(tmpCwd, '.discord-friends');
    const storePath = join(storeDir, 'sessions.json');
    mkdirSync(storeDir, { recursive: true });

    const now = Date.now();
    writeFileSync(storePath, JSON.stringify([
      {
        id: 'bad-pending',
        channelId: 'pending',
        directory: tmpCwd,
        projectName: 'proj',
        provider: 'codex',
        createdAt: now,
        lastActivity: now,
        messageCount: 0,
        totalCost: 0,
      },
      {
        id: 'good-1',
        channelId: 'chan-1',
        directory: tmpCwd,
        projectName: 'proj',
        provider: 'codex',
        createdAt: now,
        lastActivity: now,
        messageCount: 1,
        totalCost: 0,
      },
      {
        id: 'dup-chan',
        channelId: 'chan-1',
        directory: tmpCwd,
        projectName: 'proj',
        provider: 'codex',
        createdAt: now,
        lastActivity: now,
        messageCount: 2,
        totalCost: 1,
      },
    ], null, 2), 'utf-8');

    const sessions = await import('../src/session-manager.ts');
    await sessions.loadSessions();

    const all = sessions.getAllSessions();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('good-1');
    expect(sessions.getSessionByChannel('chan-1')?.id).toBe('good-1');

    const persisted = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe('good-1');
  });

  it('applies codex policy defaults from env when not passed explicitly', async () => {
    process.env.CODEX_SANDBOX_MODE = 'danger-full-access';
    process.env.CODEX_APPROVAL_POLICY = 'never';
    process.env.CODEX_NETWORK_ACCESS_ENABLED = 'true';

    const provider = makeProviderStub();
    ensureProviderMock.mockResolvedValue(provider);
    const sessions = await import('../src/session-manager.ts');

    const session = await sessions.createSession('policy', tmpCwd, 'pending', 'project-x', 'codex');
    expect(session.sandboxMode).toBe('danger-full-access');
    expect(session.approvalPolicy).toBe('never');
    expect(session.networkAccessEnabled).toBe(true);
  });

  it('forwards session codex policy to provider sendPrompt', async () => {
    process.env.CODEX_SANDBOX_MODE = 'workspace-write';
    process.env.CODEX_APPROVAL_POLICY = 'on-request';
    process.env.CODEX_NETWORK_ACCESS_ENABLED = 'false';

    let seenOptions: any;
    const provider = makeProviderStub();
    provider.sendPrompt.mockImplementation(async function* (_prompt: unknown, options: unknown) {
      seenOptions = options;
      yield { type: 'session_init', providerSessionId: 'thread_1' };
      yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    ensureProviderMock.mockResolvedValue(provider);

    const sessions = await import('../src/session-manager.ts');
    const session = await sessions.createSession('prompt', tmpCwd, 'pending', 'project-x', 'codex');

    const events: any[] = [];
    for await (const event of sessions.sendPrompt(session.id, 'hello')) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'session_init')).toBe(true);
    expect(events.some(e => e.type === 'result')).toBe(true);
    expect(seenOptions).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
  });

  it('does not throw when continueSession is aborted and always clears generating state', async () => {
    const provider = makeProviderStub();
    provider.continueSession.mockImplementation(async function* () {
      throw new Error('operation cancelled by user');
    });
    ensureProviderMock.mockResolvedValue(provider);

    const sessions = await import('../src/session-manager.ts');
    const session = await sessions.createSession('continue-abort', tmpCwd, 'pending', 'project-x', 'codex');

    const events: any[] = [];
    for await (const event of sessions.continueSession(session.id)) {
      events.push(event);
    }

    expect(events).toEqual([]);
    expect(sessions.getSession(session.id)?.isGenerating).toBe(false);
  });

  it('force-clears stuck generating state when aborting', async () => {
    const provider = makeProviderStub();
    ensureProviderMock.mockResolvedValue(provider);

    const sessions = await import('../src/session-manager.ts');
    const session = await sessions.createSession('stuck-state', tmpCwd, 'pending', 'project-x', 'codex');
    const live = sessions.getSession(session.id)!;

    live.isGenerating = true;
    const stopped = sessions.abortSession(session.id);

    expect(stopped).toBe(true);
    expect(live.isGenerating).toBe(false);
  });

  it('does not auto-dedupe recovered sessions', async () => {
    const provider = makeProviderStub();
    ensureProviderMock.mockResolvedValue(provider);
    const sessions = await import('../src/session-manager.ts');

    await sessions.createSession('fix-auth', tmpCwd, 'pending', 'project-x', 'codex');

    await expect(
      sessions.createSession('fix-auth', tmpCwd, 'pending', 'project-x', 'codex', undefined, { recoverExisting: true }),
    ).rejects.toThrow('Session "fix-auth" already exists');
  });

  it('persists monitor goal fields after linking', async () => {
    const provider = makeProviderStub();
    ensureProviderMock.mockResolvedValue(provider);
    const sessions = await import('../src/session-manager.ts');

    const session = await sessions.createSession('monitor-goal', tmpCwd, 'pending', 'project-x', 'codex');
    sessions.setMode(session.id, 'monitor');
    sessions.setMonitorGoal(session.id, 'Build a hard memory benchmark.');
    await sessions.linkChannel(session.id, 'chan-monitor');

    const storePath = join(tmpCwd, '.discord-friends', 'sessions.json');
    const persisted = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(persisted[0]).toMatchObject({
      channelId: 'chan-monitor',
      mode: 'monitor',
      monitorGoal: 'Build a hard memory benchmark.',
      workflowState: {
        status: 'idle',
        iteration: 0,
      },
    });
  });

  it('preserves previous monitor goal when entering monitor mode', async () => {
    const provider = makeProviderStub();
    ensureProviderMock.mockResolvedValue(provider);
    const sessions = await import('../src/session-manager.ts');

    const session = await sessions.createSession('monitor-reset', tmpCwd, 'pending', 'project-x', 'codex');
    sessions.setMonitorGoal(session.id, 'old goal');
    sessions.setMode(session.id, 'monitor');

    const live = sessions.getSession(session.id)!;
    expect(live.monitorGoal).toBe('old goal');
    expect(live.monitorProviderSessionId).toBeUndefined();
    expect(live.workflowState.status).toBe('idle');
    expect(live.workflowState.iteration).toBe(0);
  });

  it('updates and persists workflow state transitions', async () => {
    const provider = makeProviderStub();
    ensureProviderMock.mockResolvedValue(provider);
    const sessions = await import('../src/session-manager.ts');

    const session = await sessions.createSession('workflow-state', tmpCwd, 'pending', 'project-x', 'codex');
    sessions.updateWorkflowState(session.id, {
      status: 'monitor_review',
      iteration: 2,
      lastHook: 'after_worker_pass',
      lastWorkerSummary: 'Created draft artifacts.',
      lastWorkerReport: {
        originalGoal: 'Build the artifacts.',
        textualResponse: 'Created draft artifacts.',
        commandCount: 2,
        fileChangeCount: 1,
        meaningfulExecutionEvidence: true,
        providerReportedSuccess: 'yes',
        workerErrorsObserved: false,
        askedForHumanInput: false,
        claimedCompletedOutcomes: ['Created draft artifacts.'],
        artifacts: ['/tmp/project/artifact.md'],
        validationCommands: ['npm test -- artifact'],
        goalAssessment: 'Draft artifacts exist but validation is incomplete.',
        remainingGaps: ['Validation is still missing.'],
        blockers: [],
      },
      lastMonitorRationale: 'Validation is still missing.',
      lastMonitorDecision: {
        status: 'continue',
        confidence: 'medium',
        rationale: 'Validation is still missing.',
        steering: 'Run validation and report the result.',
        completionSummary: '',
        acceptedEvidence: ['Draft artifacts were created.'],
        missingEvidence: ['Validation results.'],
        requiredNextProof: ['Run validation and show the result.'],
        disallowedDrift: ['Do not add unrelated improvements before validation.'],
        blockingReason: '',
      },
    });
    await sessions.linkChannel(session.id, 'chan-workflow');

    const live = sessions.getSession(session.id)!;
    expect(live.workflowState).toMatchObject({
      status: 'monitor_review',
      iteration: 2,
      lastHook: 'after_worker_pass',
      lastWorkerSummary: 'Created draft artifacts.',
      lastWorkerReport: {
        originalGoal: 'Build the artifacts.',
        textualResponse: 'Created draft artifacts.',
      },
      lastMonitorRationale: 'Validation is still missing.',
      lastMonitorDecision: {
        status: 'continue',
        rationale: 'Validation is still missing.',
        requiredNextProof: ['Run validation and show the result.'],
      },
    });

    const storePath = join(tmpCwd, '.discord-friends', 'sessions.json');
    const persisted = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(persisted[0].workflowState).toMatchObject({
      status: 'monitor_review',
      iteration: 2,
      lastHook: 'after_worker_pass',
      lastWorkerSummary: 'Created draft artifacts.',
      lastWorkerReport: {
        originalGoal: 'Build the artifacts.',
        textualResponse: 'Created draft artifacts.',
      },
      lastMonitorRationale: 'Validation is still missing.',
      lastMonitorDecision: {
        status: 'continue',
        rationale: 'Validation is still missing.',
        requiredNextProof: ['Run validation and show the result.'],
      },
    });
  });

  it('uses a separate provider thread for monitor prompts', async () => {
    let promptCalls = 0;
    let seenOptions: any[] = [];
    const provider = makeProviderStub();
    provider.sendPrompt.mockImplementation(async function* (_prompt: unknown, options: unknown) {
      promptCalls++;
      seenOptions.push(options);
      yield { type: 'session_init', providerSessionId: promptCalls === 1 ? 'thread_worker' : 'thread_monitor' };
      yield { type: 'text_delta', text: promptCalls === 1 ? 'worker' : '{"status":"complete","confidence":"high","rationale":"done","steering":"","completionSummary":"done"}' };
      yield { type: 'result', success: true, costUsd: 0.1, durationMs: 1, numTurns: 1, errors: [] };
    });
    ensureProviderMock.mockResolvedValue(provider);

    const sessions = await import('../src/session-manager.ts');
    const session = await sessions.createSession('monitor-thread', tmpCwd, 'pending', 'project-x', 'codex');

    for await (const _event of sessions.sendPrompt(session.id, 'worker prompt')) {
      // consume
    }
    for await (const _event of sessions.sendMonitorPrompt(session.id, 'monitor prompt')) {
      // consume
    }

    const live = sessions.getSession(session.id)!;
    expect(live.providerSessionId).toBe('thread_worker');
    expect(live.monitorProviderSessionId).toBe('thread_monitor');
    expect(seenOptions[0]).toMatchObject({ providerSessionId: undefined });
    expect(seenOptions[1]).toMatchObject({ providerSessionId: undefined });
    expect(seenOptions[1].systemPromptParts.some((part: string) => part.includes('monitor agent'))).toBe(true);
  });
});
