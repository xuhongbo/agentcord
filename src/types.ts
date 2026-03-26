import type { ProviderName, CodexSandboxMode, CodexApprovalPolicy } from './providers/types.ts';


export interface AgentWebhookRef {
  id: string;
  token: string;
}

export interface AgentData {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  provider: ProviderName;
  model?: string;
  emoji?: string;
  avatarUrl?: string;
  createdAt: number;
  createdBy: string;
  channelSessions: Record<string, string>;
  webhooks: Record<string, AgentWebhookRef>;
}

// Re-export content block types from providers (used by message-handler, etc.)
export type {
  ContentBlock,
  ImageMediaType,
  TextBlock,
  ImageBlock,
  LocalImageBlock,
  ProviderName,
  CodexSandboxMode,
  CodexApprovalPolicy,
} from './providers/types.ts';

export interface McpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Project {
  name: string;
  directory: string;
  categoryId: string;
  logChannelId?: string;
  personality?: string;
  skills: Record<string, string>;
  mcpServers: McpServer[];
}

export interface Session {
  id: string;
  channelId: string;
  directory: string;
  projectName: string;
  provider: ProviderName;
  providerSessionId?: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  networkAccessEnabled?: boolean;
  agentPersona?: string;
  verbose: boolean;
  mode: SessionMode;
  monitorGoal?: string;
  monitorProviderSessionId?: string;
  workflowState: SessionWorkflowState;
  isGenerating: boolean;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  totalCost: number;
  source?: 'remote' | 'local-sync';
}

export interface SessionPersistData {
  id: string;
  channelId: string;
  directory: string;
  projectName: string;
  provider?: ProviderName;
  providerSessionId?: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  networkAccessEnabled?: boolean;
  agentPersona?: string;
  verbose?: boolean;
  mode?: SessionMode;
  monitorGoal?: string;
  monitorProviderSessionId?: string;
  workflowState?: SessionWorkflowState;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  totalCost: number;
  source?: 'remote' | 'local-sync';
}

export type SessionMode = 'auto' | 'plan' | 'normal' | 'monitor';

export type SessionWorkflowStatus =
  | 'idle'
  | 'worker_running'
  | 'monitor_review'
  | 'retrying'
  | 'awaiting_human'
  | 'completed'
  | 'blocked';

export type SessionWorkflowHookName =
  | 'before_worker_pass'
  | 'after_worker_pass'
  | 'before_monitor_review'
  | 'after_monitor_decision'
  | 'on_stall'
  | 'on_human_question'
  | 'on_complete'
  | 'on_blocked';

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

export interface AgentPersona {
  name: string;
  description: string;
  systemPrompt: string;
  emoji: string;
}

export interface ShellProcess {
  pid: number;
  command: string;
  startedAt: number;
  process: import('node:child_process').ChildProcess;
}

export interface Config {
  token: string;
  clientId: string;
  guildId: string | null;
  allowedUsers: string[];
  allowAllUsers: boolean;
  shellEnabled: boolean;
  shellAllowedUsers: string[];
  messageRetentionDays: number | null;
  rateLimitMs: number;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccessEnabled?: boolean;
}

export interface ExpandableContent {
  content: string;
  createdAt: number;
}
