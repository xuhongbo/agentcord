// Core type definitions for threadcord
// Structure: Server=Workspace, Channel=Project, Thread=Session, EphemeralThread=Subagent

export type ProviderName = 'claude' | 'codex' | 'gemini';
export type SessionMode = 'auto' | 'plan' | 'normal' | 'monitor';
export type ThreadType = 'persistent' | 'subagent';

// ─── Thread Session ───────────────────────────────────────────────────────────
// One Discord thread = one AI agent session

export interface ThreadSession {
  id: string;                    // Internal session ID (sanitized agentLabel + dedup suffix)
  threadId: string;              // Discord Thread ID (primary Discord key)
  channelId: string;             // Parent project channel ID
  projectName: string;           // Project name (derived from channel name)
  agentLabel: string;            // Human-readable label, e.g. "fix-login"
  provider: ProviderName;
  providerSessionId?: string;    // Provider-side session ID for resumption
  type: ThreadType;              // 'persistent' | 'subagent'
  parentThreadId?: string;       // For subagents: which thread spawned them
  subagentDepth: number;         // Chain depth (0 = top-level, prevents infinite loops)
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
// One Discord channel = one project

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
  channelId: string;             // Discord Channel ID (primary key)
  name: string;                  // Project name (= channel name)
  directory: string;             // Default working directory
  personality?: string;          // Shared system prompt for all agents in this project
  skills: Skill[];
  mcpServers: McpServer[];
  createdAt: number;
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
