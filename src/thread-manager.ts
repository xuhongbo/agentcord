import { existsSync } from 'node:fs';
import { ensureProvider, type ProviderEvent, type ContentBlock } from './providers/index.ts';
import { Store } from './persistence.ts';
import { getAgent } from './agents.ts';
import { getPersonality } from './project-manager.ts';
import { sanitizeName, resolvePath, isAbortError } from './utils.ts';
import type {
  ThreadSession,
  SessionPersistData,
  SessionMode,
  SessionWorkflowState,
  ProviderName,
} from './types.ts';
import { config } from './config.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

const MODE_PROMPTS: Record<SessionMode, string> = {
  auto: '',
  plan: 'You MUST use EnterPlanMode at the start of every task. Present your plan for user approval before making any code changes. Do not write or edit files until the user approves the plan.',
  normal: 'Before performing destructive or significant operations (deleting files, running dangerous commands, making large refactors, writing to many files), use AskUserQuestion to confirm with the user first. Ask for explicit approval before proceeding with changes.',
  monitor: 'This session is running in monitored autonomy mode. Treat the active user request as the task objective and keep working until it is fully satisfied. Do not stop at a partial implementation or ask the user for follow-up direction unless you are truly blocked by missing permissions, credentials, or required external information that you cannot obtain yourself. When you believe the task is complete, explain concisely what was finished and why it satisfies the request.',
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

// ─── Storage ──────────────────────────────────────────────────────────────────

const sessionStore = new Store<SessionPersistData[]>('sessions.json');

// channelId (the session's own Discord channel or thread ID) → ThreadSession
const sessions = new Map<string, ThreadSession>();

// internal session id → channelId
const idToChannelId = new Map<string, string>();

let saveQueue: Promise<void> = Promise.resolve();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createDefaultWorkflowState(): SessionWorkflowState {
  return {
    status: 'idle',
    iteration: 0,
    updatedAt: Date.now(),
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export async function loadSessions(): Promise<void> {
  const data = await sessionStore.read();
  if (!data) return;

  let cleaned = false;

  for (const s of data) {
    // Skip sessions from old architecture (no categoryId) — incompatible format
    if (!s.categoryId) {
      cleaned = true;
      console.warn(`Skipping legacy session "${s.id}" (no categoryId — old architecture).`);
      continue;
    }
    if (!s.channelId) {
      cleaned = true;
      console.warn(`Skipping invalid persisted session "${s.id}" (missing channelId).`);
      continue;
    }
    if (sessions.has(s.channelId)) {
      cleaned = true;
      console.warn(`Skipping duplicate persisted session "${s.id}" (channelId ${s.channelId} already loaded).`);
      continue;
    }

    const provider: ProviderName = s.provider ?? 'claude';

    sessions.set(s.channelId, {
      ...s,
      provider,
      verbose: s.verbose ?? false,
      mode: s.mode ?? 'auto',
      subagentDepth: s.subagentDepth ?? 0,
      type: s.type ?? 'persistent',
      workflowState: s.workflowState ?? createDefaultWorkflowState(),
      isGenerating: false,
    });
    idToChannelId.set(s.id, s.channelId);
  }

  if (cleaned) {
    await saveSessions();
  }

  console.log(`[session-manager] Restored ${sessions.size} session(s)`);
}

async function persistSessionsNow(): Promise<void> {
  const data: SessionPersistData[] = [];
  for (const [, s] of sessions) {
    data.push({
      id: s.id,
      channelId: s.channelId,
      categoryId: s.categoryId,
      projectName: s.projectName,
      agentLabel: s.agentLabel,
      provider: s.provider,
      providerSessionId: s.providerSessionId,
      model: s.model,
      type: s.type,
      parentChannelId: s.parentChannelId,
      subagentDepth: s.subagentDepth,
      directory: s.directory,
      mode: s.mode,
      agentPersona: s.agentPersona,
      verbose: s.verbose || false,
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
        console.error(`[session-manager] Failed to persist sessions: ${(err as Error).message}`);
      }
    });
  return saveQueue;
}

// ─── Create / CRUD ────────────────────────────────────────────────────────────

export interface CreateSessionParams {
  channelId: string;             // Session's own Discord channel (TextChannel) or thread ID
  categoryId: string;            // Parent project category ID
  projectName: string;
  agentLabel: string;
  provider: ProviderName;
  directory: string;
  providerSessionId?: string;
  model?: string;
  type: 'persistent' | 'subagent';
  parentChannelId?: string;      // For subagents: parent session's TextChannel ID
  subagentDepth?: number;
  mode?: SessionMode;
}

export async function createSession(params: CreateSessionParams): Promise<ThreadSession> {
  const {
    channelId,
    categoryId,
    projectName,
    agentLabel,
    provider,
    providerSessionId,
    model,
    type,
    parentChannelId,
    subagentDepth = 0,
    mode = config.defaultMode,
  } = params;

  const resolvedDir = resolvePath(params.directory);
  if (!existsSync(resolvedDir)) {
    throw new Error(`Directory does not exist: ${resolvedDir}`);
  }

  await ensureProvider(provider);

  if (sessions.has(channelId)) {
    throw new Error(`Session for channelId "${channelId}" already exists`);
  }

  // Derive a unique internal ID from the agentLabel (auto-deduplicate)
  let id = sanitizeName(agentLabel);
  let suffix = 1;
  while (idToChannelId.has(id)) {
    suffix++;
    id = sanitizeName(`${agentLabel}-${suffix}`);
  }

  const session: ThreadSession = {
    id,
    channelId,
    categoryId,
    projectName,
    agentLabel,
    provider,
    providerSessionId,
    model,
    type,
    parentChannelId,
    subagentDepth,
    directory: resolvedDir,
    mode,
    agentPersona: undefined,
    verbose: false,
    monitorGoal: undefined,
    monitorProviderSessionId: undefined,
    workflowState: createDefaultWorkflowState(),
    isGenerating: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    totalCost: 0,
  };

  sessions.set(channelId, session);
  idToChannelId.set(id, channelId);
  await saveSessions();

  return session;
}

export function getSession(id: string): ThreadSession | undefined {
  const channelId = idToChannelId.get(id);
  return channelId ? sessions.get(channelId) : undefined;
}

/** Look up a session by its Discord channel or thread ID. */
export function getSessionByChannel(channelId: string): ThreadSession | undefined {
  return sessions.get(channelId);
}

/** Backward-compat alias (subagent sessions are still threads). */
export const getSessionByThread = getSessionByChannel;

/** List all sessions under a project category. */
export function getSessionsByCategory(categoryId: string): ThreadSession[] {
  const result: ThreadSession[] = [];
  for (const [, session] of sessions) {
    if (session.categoryId === categoryId) {
      result.push(session);
    }
  }
  return result;
}

export function getAllSessions(): ThreadSession[] {
  return Array.from(sessions.values());
}

export async function endSession(id: string): Promise<void> {
  const session = getSession(id);
  if (!session) throw new Error(`Session "${id}" not found`);

  if (session.isGenerating && (session as any)._controller) {
    (session as any)._controller.abort();
  }

  idToChannelId.delete(session.id);
  sessions.delete(session.channelId);
  await saveSessions();
}

// ─── State management ─────────────────────────────────────────────────────────

export function setMode(sessionId: string, mode: SessionMode): void {
  const session = getSession(sessionId);
  if (session) {
    session.mode = mode;
    if (mode === 'monitor') {
      session.monitorProviderSessionId = undefined;
    }
    session.workflowState = createDefaultWorkflowState();
    saveSessions();
  }
}

export function setVerbose(sessionId: string, verbose: boolean): void {
  const session = getSession(sessionId);
  if (session) {
    session.verbose = verbose;
    saveSessions();
  }
}

export function setModel(sessionId: string, model: string): void {
  const session = getSession(sessionId);
  if (session) {
    session.model = model;
    saveSessions();
  }
}

export function setAgentPersona(sessionId: string, persona: string | undefined): void {
  const session = getSession(sessionId);
  if (session) {
    session.agentPersona = persona;
    saveSessions();
  }
}

export function setMonitorGoal(sessionId: string, goal: string | undefined): void {
  const session = getSession(sessionId);
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
  const session = getSession(sessionId);
  if (!session) return;

  const next = typeof patch === 'function'
    ? patch(session.workflowState)
    : { ...session.workflowState, ...patch };

  session.workflowState = {
    ...next,
    updatedAt: Date.now(),
  };
  saveSessions();
}

export function resetWorkflowState(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session) return;
  session.workflowState = createDefaultWorkflowState();
  saveSessions();
}

// ─── System prompt building ───────────────────────────────────────────────────

function buildSystemPromptParts(session: ThreadSession): string[] {
  const parts: string[] = [];

  const personality = getPersonality(session.categoryId);
  if (personality) parts.push(personality);

  if (session.agentPersona) {
    const agent = getAgent(session.agentPersona);
    if (agent?.systemPrompt) parts.push(agent.systemPrompt);
  }

  const modePrompt = MODE_PROMPTS[session.mode];
  if (modePrompt) parts.push(modePrompt);

  return parts;
}

function buildMonitorSystemPromptParts(session: ThreadSession): string[] {
  const parts: string[] = [];

  const personality = getPersonality(session.categoryId);
  if (personality) parts.push(personality);

  parts.push(MONITOR_SYSTEM_PROMPT);
  return parts;
}

// ─── Provider-delegated prompt sending ───────────────────────────────────────

export async function* sendPrompt(
  sessionId: string,
  prompt: string | ContentBlock[],
): AsyncGenerator<ProviderEvent> {
  const session = getSession(sessionId);
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
      sandboxMode: config.codexSandboxMode,
      approvalPolicy: config.codexApprovalPolicy,
      networkAccessEnabled: config.codexNetworkAccessEnabled,
      webSearchMode: config.codexWebSearchMode,
      modelReasoningEffort: config.codexReasoningEffort || undefined,
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
      // User cancelled — expected
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
  const session = getSession(sessionId);
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
      sandboxMode: config.codexSandboxMode,
      approvalPolicy: config.codexApprovalPolicy,
      networkAccessEnabled: config.codexNetworkAccessEnabled,
      webSearchMode: config.codexWebSearchMode,
      modelReasoningEffort: config.codexReasoningEffort || undefined,
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
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  const provider = await ensureProvider(session.provider);
  const systemPromptParts = buildMonitorSystemPromptParts(session);
  session.lastActivity = Date.now();

  const stream = provider.sendPrompt(prompt, {
    directory: session.directory,
    providerSessionId: session.monitorProviderSessionId,
    model: session.model,
    sandboxMode: config.codexSandboxMode,
    approvalPolicy: config.codexApprovalPolicy,
    networkAccessEnabled: config.codexNetworkAccessEnabled,
    webSearchMode: config.codexWebSearchMode,
    modelReasoningEffort: config.codexReasoningEffort || undefined,
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

// ─── Abort management ─────────────────────────────────────────────────────────

export function abortSession(sessionId: string): boolean {
  return abortSessionWithReason(sessionId, 'user');
}

export function abortSessionWithReason(sessionId: string, reason: 'user' | 'watchdog'): boolean {
  const session = getSession(sessionId);
  if (!session) return false;

  const controller = (session as any)._controller as AbortController | undefined;
  (session as any)._abortReason = reason;

  if (controller) {
    controller.abort();
  }

  if (session.isGenerating) {
    session.isGenerating = false;
    delete (session as any)._controller;
    saveSessions();
    return true;
  }

  return !!controller;
}

export function consumeAbortReason(sessionId: string): 'user' | 'watchdog' | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  const reason = (session as any)._abortReason as 'user' | 'watchdog' | undefined;
  delete (session as any)._abortReason;
  return reason;
}
