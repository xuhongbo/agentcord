// Core type definitions for threadcord
// Structure: Server=Workspace, Category=Project, Channel=Session, Thread=Subagent

export type ProviderName = 'claude' | 'codex' | 'gemini';
export type SessionMode = 'auto' | 'plan' | 'normal' | 'monitor';
export type SessionType = 'persistent' | 'subagent';

// Backward compat alias
export type ThreadType = SessionType;

// ─── Channel Session ───────────────────────────────────────────────────────────
// One Discord channel/thread = one AI agent session
//   'persistent' → lives in a TextChannel under the project Category
//   'subagent'   → lives in a Thread under the parent session's TextChannel

export interface ThreadSession {
  id: string;                    // Internal session ID (sanitized agentLabel + dedup suffix)
  channelId: string;             // Primary Discord ID: TextChannel.id for persistent, Thread.id for subagent
  categoryId: string;            // Discord Category ID (= project)
  projectName: string;           // Project name
  agentLabel: string;            // Human-readable label, e.g. "fix-login"
  provider: ProviderName;
  providerSessionId?: string;    // Provider-side session ID for resumption
  type: SessionType;
  parentChannelId?: string;      // For subagents: parent session's TextChannel ID
  subagentDepth: number;         // Chain depth (0 = top-level)
  directory: string;             // Working directory on host machine
  mode: SessionMode;
  agentPersona?: string;         // Agent persona name
  verbose: boolean;              // Show tool calls in Discord
  monitorGoal?: string;
  monitorProviderSessionId?: string;
  workflowState: SessionWorkflowState;
  isGenerating: boolean;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  totalCost: number;
}

export type SessionPersistData = Omit<ThreadSession, 'isGenerating'>;

// ─── Workflow State ───────────────────────────────────────────────────────────

export type SessionWorkflowStatus =
  | 'idle'
  | 'worker_running'
  | 'retrying'
  | 'monitor_review'
  | 'awaiting_human'
  | 'completed'
  | 'blocked'
  | 'error';

export type SessionWorkflowHookName =
  | 'before_worker_pass'
  | 'after_worker_pass'
  | 'before_monitor_review'
  | 'after_monitor_decision'
  | 'on_stall'
  | 'on_blocked'
  | 'on_complete'
  | 'on_human_question';

export interface SessionMonitorFeedbackReport {
  status: 'complete' | 'continue' | 'blocked';
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  steering: string;
  completionSummary: string;
  acceptedEvidence: string[];
  missingEvidence: string[];
  requiredNextProof: string[];
  disallowedDrift: string[];
  blockingReason: string;
}

export interface SessionWorkflowState {
  status: SessionWorkflowStatus;
  iteration: number;
  lastHook?: SessionWorkflowHookName;
  lastWorkerSummary?: string;
  lastWorkerReport?: SessionWorkerProgressReport;
  lastMonitorRationale?: string;
  lastMonitorDecision?: SessionMonitorFeedbackReport;
  nextProofContract?: SessionNextProofContract;
  awaitingHumanReason?: string;
  updatedAt: number;
}

// ─── Project ──────────────────────────────────────────────────────────────────
// One Discord Category = one project/repository

export interface Skill {
  name: string;
  prompt: string;
}

export interface McpServer {
  name: string;
  command: string;
  args?: string[];
}

export interface Project {
  categoryId: string;            // Discord Category ID (primary key)
  historyChannelId?: string;     // Forum channel ID for archived sessions
  name: string;                  // Project name (= category name)
  directory: string;             // Default working directory
  personality?: string;          // Shared system prompt for all agents in this project
  skills: Skill[];
  mcpServers: McpServer[];
  createdAt: number;
}

// ─── Archived Session ─────────────────────────────────────────────────────────
// Sessions moved out of active channels and into the #history Forum

export interface ArchivedSession {
  id: string;
  categoryId: string;
  agentLabel: string;
  provider: ProviderName;
  directory: string;
  mode: SessionMode;
  createdAt: number;
  archivedAt: number;
  messageCount: number;
  totalCost: number;
  summary?: string;
  forumPostId?: string;          // Discord Forum Post (Thread) ID
}

// ─── Workflow State (extended) ────────────────────────────────────────────────

export interface SessionWorkerProgressReport {
  originalGoal: string;
  textualResponse: string;
  commandCount: number;
  fileChangeCount: number;
  meaningfulExecutionEvidence: boolean;
  providerReportedSuccess: 'yes' | 'no' | 'unknown';
  workerErrorsObserved: boolean;
  askedForHumanInput: boolean;
  claimedCompletedOutcomes: string[];
  artifacts: string[];
  validationCommands: string[];
  goalAssessment: string;
  remainingGaps: string[];
  blockers: string[];
}

export interface SessionNextProofContract {
  goal: string;
  acceptedEvidence: string[];
  missingEvidence: string[];
  requiredNextProof: string[];
  requiredArtifacts: string[];
  requiredValidation: string[];
  stopCondition: string;
  avoidUntilProved: string[];
}

// ─── Agent Persona ────────────────────────────────────────────────────────────

export interface AgentPersona {
  name: string;
  emoji: string;
  description: string;
  systemPrompt: string;
}

// ─── Shell Process ────────────────────────────────────────────────────────────

export interface ShellProcess {
  pid: number;
  command: string;
  startedAt: number;
  process: import('node:child_process').ChildProcess;
}

// ─── Expandable Content (for output-handler) ──────────────────────────────────

export interface ExpandableContent {
  content: string;
  createdAt: number;
}
