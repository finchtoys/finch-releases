export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ProjectStatus = 'planning' | 'draft' | 'active' | 'paused' | 'completed' | 'failed';
export type WorkflowCategory = 'backlog' | 'ready' | 'active' | 'review' | 'blocked' | 'done' | 'cancelled';
export type RunState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type RunKind = 'planner' | 'worker' | 'reviewer';
export type PermissionMode = 'ask' | 'acceptCalls';

export interface WorkflowState {
  id: string;
  name: string;
  category: WorkflowCategory;
  color: string;
  order: number;
  terminal: boolean;
}

export interface AgentRole {
  id: string;
  name: string;
  mission: string;
  modelKey: string;
  reasoningEffort: ReasoningEffort;
  spaceId?: string;
  /** Use Finch's default non-Space workspace when no Space is assigned. */
  useWorkspace?: boolean;
  color: string;
  concurrencyLimit: number;
}

export interface TeamTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  workflowStateId: string;
  roleId: string;
  modelKey?: string;
  reasoningEffort?: ReasoningEffort;
  spaceId?: string;
  dependencyIds: string[];
  priority: number;
  autoStart: boolean;
  activeRunId?: string;
  attempt: number;
  maxAttempts: number;
  latestSummary?: string;
  reviewFeedback?: string;
  collaborationTaskId?: string;
  collaborationTaskVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerArtifact {
  path: string;
  description?: string;
}

/** Persisted worker-to-reviewer handoff. All text is untrusted worker data. */
export interface WorkerReport {
  status: 'completed' | 'blocked' | 'needs_input';
  summary: string;
  artifacts: WorkerArtifact[];
  verification: string[];
  risks: string[];
  handoff: string;
  /** True when legacy free-form output had to be wrapped into this shape. */
  fallback?: boolean;
}

export interface ReviewDecision {
  accepted: boolean;
  summary: string;
  feedback?: string;
  submittedAt: string;
}

export interface AgentRun {
  id: string;
  projectId: string;
  taskId?: string;
  kind: RunKind;
  roleId?: string;
  sessionId: string;
  turnId: string;
  state: RunState;
  eventCursor: number;
  queuePosition?: number;
  pendingCount: number;
  streamText?: string;
  outputText?: string;
  errorCode?: string;
  retryable?: boolean;
  report?: WorkerReport;
  artifactId?: string;
  artifactIds?: string[];
  handoffId?: string;
  reviewDecision?: ReviewDecision;
  usage?: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number };
  costUsd?: number;
  durationMs?: number;
  modelKey?: string;
  reasoningEffort?: ReasoningEffort;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

export interface TeamWait {
  requestId: string;
  projectId: string;
  taskId?: string;
  runId: string;
  sessionId: string;
  turnId?: string;
  kind: 'permission' | 'question' | 'form';
  title: string;
  destructive: boolean;
  dangerous: boolean;
  payload: unknown;
  createdAt: string;
  expiresAt?: string;
}

export interface ProjectActivity {
  id: string;
  projectId: string;
  kind: 'project' | 'task' | 'run' | 'wait' | 'system';
  message: string;
  createdAt: string;
  taskId?: string;
  runId?: string;
}

export interface AgentProject {
  id: string;
  name: string;
  brief: string;
  goal: string;
  status: ProjectStatus;
  workflow: WorkflowState[];
  roles: AgentRole[];
  taskIds: string[];
  commanderModelKey: string;
  commanderReasoningEffort: ReasoningEffort;
  commanderSessionId?: string;
  collaborationScopeId?: string;
  planArtifactId?: string;
  planDocumentId?: string;
  planRevision?: number;
  spaceIds: string[];
  /** Allow roles without a Space assignment to run in the default Workspace. */
  workspaceAllowed: boolean;
  permissionMode: PermissionMode;
  maxConcurrency: number;
  reviewMode: 'commander' | 'manual' | 'none';
  createdAt: string;
  updatedAt: string;
}

export interface ModelOption {
  modelKey: string;
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  alias?: string;
  supportsThinking: boolean;
  instant?: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  reasoningLevels?: ReasoningEffort[];
}

export interface SpaceOption {
  id: string;
  name: string;
  alias?: string;
  directoryPath?: string;
}

export interface TeamState {
  schemaVersion: 1;
  sessionCursors: Record<string, number>;
  projects: AgentProject[];
  tasks: TeamTask[];
  runs: AgentRun[];
  waits: TeamWait[];
  activities: ProjectActivity[];
}

export interface AppSnapshot extends TeamState {
  models: ModelOption[];
  spaces: SpaceOption[];
}

export interface ProjectDraftInput {
  brief: string;
  commanderModelKey: string;
  commanderReasoningEffort: ReasoningEffort;
  spaceIds: string[];
  workspaceAllowed: boolean;
  permissionMode: PermissionMode;
  maxConcurrency: number;
}

export interface GeneratedProject {
  name: string;
  goal: string;
  workflow: Array<Omit<WorkflowState, 'order'>>;
  roles: Array<Omit<AgentRole, 'concurrencyLimit'> & { concurrencyLimit?: number }>;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    workflowStateId: string;
    roleId: string;
    modelKey?: string;
    reasoningEffort?: ReasoningEffort;
    spaceId?: string;
    dependencyIds: string[];
    priority: number;
    autoStart?: boolean;
    maxAttempts?: number;
  }>;
}

export type WaitResponse =
  | { kind: 'permission'; allow: boolean }
  | { kind: 'question'; answers: Record<string, string> }
  | { kind: 'form'; submitted: boolean; values?: Record<string, string | number | boolean | string[]> };

export type AppRequest =
  | { type: 'agent-team:init' }
  | { type: 'agent-team:create-project'; input: ProjectDraftInput }
  | { type: 'agent-team:start-project'; projectId: string }
  | { type: 'agent-team:pause-project'; projectId: string }
  | { type: 'agent-team:delete-project'; projectId: string }
  | { type: 'agent-team:update-workflow'; projectId: string; workflow: WorkflowState[] }
  | { type: 'agent-team:update-role'; projectId: string; roleId: string; role: Omit<AgentRole, 'id'> }
  | { type: 'agent-team:move-task'; taskId: string; workflowStateId: string }
  | { type: 'agent-team:add-task'; projectId: string; task: Partial<TeamTask> & Pick<TeamTask, 'title' | 'roleId'> }
  | { type: 'agent-team:start-task'; taskId: string }
  | { type: 'agent-team:cancel-run'; runId: string }
  | { type: 'agent-team:retry-task'; taskId: string }
  | { type: 'agent-team:respond-wait'; sessionId: string; requestId: string; response: WaitResponse }
  | { type: 'agent-team:refresh' };

export type HostMessage =
  | { type: 'agent-team:snapshot'; snapshot: AppSnapshot }
  | { type: 'agent-team:error'; message: string }
  | { type: 'agent-team:notice'; message: string; variant: 'success' | 'info' | 'warning' };
