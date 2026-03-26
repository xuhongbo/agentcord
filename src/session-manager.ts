import { existsSync } from 'node:fs';
import { ensureProvider, type ProviderEvent, type ProviderName, type ContentBlock } from './providers/index.ts';
import type { CodexApprovalPolicy, CodexSandboxMode } from './providers/types.ts';
import { Store } from './persistence.ts';
import { getAgent } from './agents.ts';
import { getPersonality } from './project-manager.ts';
import { sanitizeSessionName, resolvePath, isPathAllowed, isAbortError } from './utils.ts';
import type { Session, SessionPersistData, SessionMode, SessionWorkflowState } from './types.ts';
import { config } from './config.ts';

const MODE_PROMPTS: Record<SessionMode, string> = {
  auto: '',
  plan: 'You MUST use EnterPlanMode at the start of every task. Present your plan for user approval before making any code changes. Do not write or edit files until the user approves the plan.',
  normal: 'Before performing destructive or significant operations (deleting files, running dangerous commands, making large refactors, writing to many files), use AskUserQuestion to confirm with the user first. Ask for explicit approval before proceeding with changes.',
  monitor: 'This session is running in monitored autonomy mode. Treat the active user request as the task objective and keep working until it is fully satisfied. Do not stop at a partial implementation or ask the user for follow-up direction unless you are truly blocked by missing permissions, credentials, or required external information that you cannot obtain yourself. When you believe the task is complete, explain concretely what was finished and why it satisfies the request.',
};

const MONITOR_SYSTEM_PROMPT = `You are a monitor agent supervising another coding agent.

Your job is to judge progress against the user's original request and decide whether the worker should continue.

Return JSON only in this schema:
{
  "status": "complete" | "continue" | "blocked",
  "confidence": "high" | "medium" | "low",
  "rationale": "Short explanation tied to the original request",
  "steering": "Concrete next instructions for the worker. Empty string only when status is complete.",
  "completionSummary": "Short summary of what is complete. Empty string unless status is complete."
}

Rules:
- Favor continuing unless the task clearly satisfies the original request.
- Judge against robustness, completeness, and the user's stated quality bar, not just whether some code changed.
- If the worker stopped early, ask for the next concrete step instead of accepting the output.
- Use "blocked" only for true blockers the worker cannot resolve autonomously.
- Never ask the human for optional next steps.
- Output valid JSON and nothing else.`;
const sessionStore = new Store<SessionPersistData[]>('sessions.json');

const sessions = new Map<string, Session>();
const channelToSession = new Map<string, string>();
let saveQueue: Promise<void> = Promise.resolve();

function createDefaultWorkflowState(): SessionWorkflowState {
  return {
    status: 'idle',
    iteration: 0,
    updatedAt: Date.now(),
  };
}


function isPlaceholderChannelId(channelId: string | undefined): boolean {
  return !channelId || channelId === 'pending';
}

// Persistence

export async function loadSessions(): Promise<void> {
  const data = await sessionStore.read();
  if (!data) return;

  let cleaned = false;
  for (const s of data) {
    if (isPlaceholderChannelId(s.channelId)) {
      cleaned = true;
      console.warn(`Skipping invalid persisted session "${s.id}" (missing channel ID).`);
      continue;
    }
    if (channelToSession.has(s.channelId)) {
      cleaned = true;
      console.warn(`Skipping duplicate persisted session "${s.id}" (channel ${s.channelId} already linked).`);
      continue;
    }

    // Migration: handle old claudeSessionId field and missing provider
    const provider: ProviderName = s.provider ?? 'claude';
    const providerSessionId = s.providerSessionId ?? (s as any).claudeSessionId;

    sessions.set(s.id, {
      ...s,
      provider,
      providerSessionId,
      verbose: s.verbose ?? false,
      mode: s.mode ?? 'auto',
      monitorGoal: s.monitorGoal,
      monitorProviderSessionId: s.monitorProviderSessionId,
      workflowState: s.workflowState ?? createDefaultWorkflowState(),
      isGenerating: false,
    });
    channelToSession.set(s.channelId, s.id);
  }

  if (cleaned) {
    await saveSessions();
  }

  console.log(`Restored ${sessions.size} session(s)`);
}

async function persistSessionsNow(): Promise<void> {
  const data: SessionPersistData[] = [];
  for (const [, s] of sessions) {
    if (isPlaceholderChannelId(s.channelId)) continue;
    data.push({
      id: s.id,
      channelId: s.channelId,
      directory: s.directory,
      projectName: s.projectName,
      provider: s.provider,
      providerSessionId: s.providerSessionId,
      model: s.model,
      sandboxMode: s.sandboxMode,
      approvalPolicy: s.approvalPolicy,
      networkAccessEnabled: s.networkAccessEnabled,
      agentPersona: s.agentPersona,
      verbose: s.verbose || undefined,
      mode: s.mode !== 'auto' ? s.mode : undefined,
      monitorGoal: s.monitorGoal,
      monitorProviderSessionId: s.monitorProviderSessionId,
      workflowState: s.workflowState,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      messageCount: s.messageCount,
      totalCost: s.totalCost,
    });
  }
  await sessionStore.write(data);
}

function saveSessions(): Promise<void> {
  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      try {
        await persistSessionsNow();
      } catch (err: unknown) {
        console.error(`Failed to persist sessions: ${(err as Error).message}`);
      }
    });
  return saveQueue;
}

export interface CreateSessionOptions {
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  networkAccessEnabled?: boolean;
  recoverExisting?: boolean;
}

// Session CRUD

export async function createSession(
  name: string,
  directory: string,
  channelId: string,
  projectName: string,
  provider: ProviderName = 'claude',
  providerSessionId?: string,
  options: CreateSessionOptions = {},
): Promise<Session> {
  const resolvedDir = resolvePath(directory);
  const effectiveOptions: CreateSessionOptions = provider === 'codex'
    ? {
        sandboxMode: options.sandboxMode ?? config.codexSandboxMode,
        approvalPolicy: options.approvalPolicy ?? config.codexApprovalPolicy,
        networkAccessEnabled: options.networkAccessEnabled ?? config.codexNetworkAccessEnabled,
      }
    : options;

  if (!isPathAllowed(resolvedDir, config.allowedPaths)) {
    throw new Error(`Directory not in allowed paths: ${resolvedDir}`);
  }
  if (!existsSync(resolvedDir)) {
    throw new Error(`Directory does not exist: ${resolvedDir}`);
  }

  // Validate the provider is available
  await ensureProvider(provider);

  // Auto-deduplicate: append -2, -3, etc. if name is taken
  let id = sanitizeSessionName(name);
  if (options.recoverExisting) {
    if (sessions.has(id)) {
      throw new Error(`Session "${id}" already exists`);
    }
  } else {
    let suffix = 1;
    while (sessions.has(id)) {
      suffix++;
      id = sanitizeSessionName(`${name}-${suffix}`);
    }
  }

  const session: Session = {
    id,
    channelId,
    directory: resolvedDir,
    projectName,
    provider,
    providerSessionId,
    sandboxMode: effectiveOptions.sandboxMode,
    approvalPolicy: effectiveOptions.approvalPolicy,
    networkAccessEnabled: effectiveOptions.networkAccessEnabled,
    verbose: false,
    mode: 'auto',
    monitorGoal: undefined,
    monitorProviderSessionId: undefined,
    workflowState: createDefaultWorkflowState(),
    isGenerating: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    totalCost: 0,
  };

  sessions.set(id, session);
  if (!isPlaceholderChannelId(channelId)) {
    channelToSession.set(channelId, id);
    await saveSessions();
  }

  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function getSessionByChannel(channelId: string): Session | undefined {
  const id = channelToSession.get(channelId);
  return id ? sessions.get(id) : undefined;
}

export function getAllSessions(): Session[] {
  return Array.from(sessions.values());
}

export async function endSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) throw new Error(`Session "${id}" not found`);

  // Abort if generating
  if (session.isGenerating && (session as any)._controller) {
    (session as any)._controller.abort();
  }

  if (!isPlaceholderChannelId(session.channelId)) {
    channelToSession.delete(session.channelId);
  }
  sessions.delete(id);
  await saveSessions();
}

export async function linkChannel(sessionId: string, channelId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found`);
  }

  if (!isPlaceholderChannelId(session.channelId)) {
    channelToSession.delete(session.channelId);
  }
  session.channelId = channelId;
  channelToSession.set(channelId, sessionId);
  await saveSessions();
}

export async function unlinkChannel(channelId: string): Promise<void> {
  let sessionId = channelToSession.get(channelId);
  if (!sessionId) {
    for (const [id, session] of sessions) {
      if (session.channelId === channelId) {
        sessionId = id;
        break;
      }
    }
  }

  if (!sessionId) return;

  channelToSession.delete(channelId);
  sessions.delete(sessionId);
  await saveSessions();
}

// Model management

export function setModel(sessionId: string, model: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.model = model;
    saveSessions();
  }
}

// Agent persona management

export function setVerbose(sessionId: string, verbose: boolean): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.verbose = verbose;
    saveSessions();
  }
}

export function setMode(sessionId: string, mode: SessionMode): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.mode = mode;
    if (mode === 'monitor') {
      session.monitorProviderSessionId = undefined;
    }
    session.workflowState = createDefaultWorkflowState();
    saveSessions();
  }
}

export function setMonitorGoal(sessionId: string, goal: string | undefined): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.monitorGoal = goal;
    if (!goal) {
      session.monitorProviderSessionId = undefined;
    }
    session.workflowState = createDefaultWorkflowState();
    saveSessions();
  }
}

export function updateWorkflowState(
  sessionId: string,
  patch: Partial<SessionWorkflowState> | ((current: SessionWorkflowState) => SessionWorkflowState),
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  const next = typeof patch === 'function'
    ? patch(session.workflowState)
    : {
        ...session.workflowState,
        ...patch,
      };

  session.workflowState = {
    ...next,
    updatedAt: Date.now(),
  };
  saveSessions();
}

export function resetWorkflowState(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.workflowState = createDefaultWorkflowState();
  saveSessions();
}

export function setAgentPersona(sessionId: string, persona: string | undefined): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.agentPersona = persona;
    saveSessions();
  }
}

// Build system prompt parts from project personality + agent persona + mode

function buildSystemPromptParts(session: Session): string[] {
  const parts: string[] = [];

  const personality = getPersonality(session.projectName);
  if (personality) parts.push(personality);

  if (session.agentPersona) {
    const agent = getAgent(session.agentPersona);
    if (agent?.systemPrompt) parts.push(agent.systemPrompt);
  }

  const modePrompt = MODE_PROMPTS[session.mode];
  if (modePrompt) parts.push(modePrompt);

  return parts;
}

function buildMonitorSystemPromptParts(session: Session): string[] {
  const parts: string[] = [];

  const personality = getPersonality(session.projectName);
  if (personality) parts.push(personality);

  parts.push(MONITOR_SYSTEM_PROMPT);
  return parts;
}

export function resetProviderSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.providerSessionId = undefined;
    saveSessions();
  }
}

// Provider-delegated prompt sending

export async function* sendPrompt(
  sessionId: string,
  prompt: string | ContentBlock[],
): AsyncGenerator<ProviderEvent> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  (session as any)._controller = controller;
  session.isGenerating = true;
  session.lastActivity = Date.now();

  const provider = await ensureProvider(session.provider);
  const systemPromptParts = buildSystemPromptParts(session);

  try {
    const stream = provider.sendPrompt(prompt, {
      directory: session.directory,
      providerSessionId: session.providerSessionId,
      model: session.model,
      sandboxMode: session.sandboxMode,
      approvalPolicy: session.approvalPolicy,
      networkAccessEnabled: session.networkAccessEnabled,
      systemPromptParts,
      abortController: controller,
    });

    for await (const event of stream) {
      // Capture provider session ID
      if (event.type === 'session_init') {
        session.providerSessionId = event.providerSessionId || undefined;
        await saveSessions();
      }
      // Track cost
      if (event.type === 'result') {
        session.totalCost += event.costUsd;
      }
      yield event;
    }

    session.messageCount++;
  } catch (err: unknown) {
    if (isAbortError(err)) {
      // User cancelled — that's fine
    } else {
      throw err;
    }
  } finally {
    session.isGenerating = false;
    session.lastActivity = Date.now();
    delete (session as any)._controller;
    await saveSessions();
  }
}

export async function* continueSession(
  sessionId: string,
): AsyncGenerator<ProviderEvent> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  (session as any)._controller = controller;
  session.isGenerating = true;
  session.lastActivity = Date.now();

  const provider = await ensureProvider(session.provider);
  const systemPromptParts = buildSystemPromptParts(session);

  try {
    const stream = provider.continueSession({
      directory: session.directory,
      providerSessionId: session.providerSessionId,
      model: session.model,
      sandboxMode: session.sandboxMode,
      approvalPolicy: session.approvalPolicy,
      networkAccessEnabled: session.networkAccessEnabled,
      systemPromptParts,
      abortController: controller,
    });

    for await (const event of stream) {
      if (event.type === 'session_init') {
        session.providerSessionId = event.providerSessionId || undefined;
        await saveSessions();
      }
      if (event.type === 'result') {
        session.totalCost += event.costUsd;
      }
      yield event;
    }

    session.messageCount++;
  } catch (err: unknown) {
    if (isAbortError(err)) {
      // cancelled
    } else {
      throw err;
    }
  } finally {
    session.isGenerating = false;
    session.lastActivity = Date.now();
    delete (session as any)._controller;
    await saveSessions();
  }
}

export async function* sendMonitorPrompt(
  sessionId: string,
  prompt: string,
): AsyncGenerator<ProviderEvent> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  const provider = await ensureProvider(session.provider);
  const systemPromptParts = buildMonitorSystemPromptParts(session);
  session.lastActivity = Date.now();

  const stream = provider.sendPrompt(prompt, {
    directory: session.directory,
    providerSessionId: session.monitorProviderSessionId,
    model: session.model,
    sandboxMode: session.sandboxMode,
    approvalPolicy: session.approvalPolicy,
    networkAccessEnabled: session.networkAccessEnabled,
    systemPromptParts,
    abortController: new AbortController(),
  });

  for await (const event of stream) {
    if (event.type === 'session_init') {
      session.monitorProviderSessionId = event.providerSessionId || undefined;
      await saveSessions();
    }
    if (event.type === 'result') {
      session.totalCost += event.costUsd;
    }
    yield event;
  }

  session.lastActivity = Date.now();
  await saveSessions();
}

export function abortSession(sessionId: string): boolean {
  return abortSessionWithReason(sessionId, 'user');
}

export function abortSessionWithReason(sessionId: string, reason: 'user' | 'watchdog'): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  const controller = (session as any)._controller as AbortController | undefined;
  (session as any)._abortReason = reason;
  if (controller) {
    controller.abort();
  }
  // Force-clear generating state — the SDK may not throw AbortError reliably
  if (session.isGenerating) {
    session.isGenerating = false;
    delete (session as any)._controller;
    saveSessions();
    return true;
  }
  return !!controller;
}

export function consumeAbortReason(sessionId: string): 'user' | 'watchdog' | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  const reason = (session as any)._abortReason as 'user' | 'watchdog' | undefined;
  delete (session as any)._abortReason;
  return reason;
}

// Session info for /session attach

export function getAttachInfo(sessionId: string): { sessionId?: string } | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return {
    sessionId: session.providerSessionId,
  };
}
