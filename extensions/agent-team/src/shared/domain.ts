import type {
  AgentProject,
  AgentRole,
  AgentRun,
  GeneratedProject,
  ProjectActivity,
  TeamState,
  TeamTask,
  WorkflowCategory,
  WorkflowState,
  WorkerReport,
} from './types.js';

export const EMPTY_STATE: TeamState = {
  schemaVersion: 1,
  sessionCursors: {},
  projects: [],
  tasks: [],
  runs: [],
  waits: [],
  activities: [],
};

const CATEGORIES: WorkflowCategory[] = ['backlog', 'ready', 'active', 'review', 'blocked', 'done', 'cancelled'];
const COLORS = ['#64748b', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#22c55e', '#78716c'];

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function cloneEmptyState(): TeamState {
  return structuredClone(EMPTY_STATE);
}

export function normalizeState(value: unknown): TeamState {
  if (!value || typeof value !== 'object') return cloneEmptyState();
  const raw = value as Partial<TeamState>;
  if (raw.schemaVersion !== 1) return cloneEmptyState();
  return {
    schemaVersion: 1,
    sessionCursors: raw.sessionCursors && typeof raw.sessionCursors === 'object' ? raw.sessionCursors : {},
    projects: Array.isArray(raw.projects) ? raw.projects.map((project) => ({
      ...project,
      workspaceAllowed: project.workspaceAllowed === true,
      roles: Array.isArray(project.roles) ? project.roles.map((role) => ({ ...role, useWorkspace: role.useWorkspace === true })) : [],
    })) : [],
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    runs: Array.isArray(raw.runs) ? raw.runs : [],
    waits: Array.isArray(raw.waits) ? raw.waits : [],
    activities: Array.isArray(raw.activities) ? raw.activities.slice(-500) : [],
  };
}

export function addActivity(
  state: TeamState,
  projectId: string,
  kind: ProjectActivity['kind'],
  message: string,
  details: Pick<ProjectActivity, 'taskId' | 'runId'> = {},
): void {
  state.activities.push({ id: createId('evt'), projectId, kind, message, createdAt: now(), ...details });
  if (state.activities.length > 500) state.activities.splice(0, state.activities.length - 500);
}

export function orderedWorkflow(project: AgentProject): WorkflowState[] {
  return [...project.workflow].sort((a, b) => a.order - b.order);
}

export function stateByCategory(project: AgentProject, category: WorkflowCategory): WorkflowState | undefined {
  return orderedWorkflow(project).find((item) => item.category === category);
}

export function initialWorkflowState(project: AgentProject): WorkflowState {
  return stateByCategory(project, 'ready')
    ?? stateByCategory(project, 'backlog')
    ?? orderedWorkflow(project)[0];
}

export function activeWorkflowState(project: AgentProject): WorkflowState {
  return stateByCategory(project, 'active') ?? orderedWorkflow(project)[0];
}

export function completedWorkflowState(project: AgentProject): WorkflowState {
  return stateByCategory(project, 'done')
    ?? orderedWorkflow(project).find((item) => item.terminal)
    ?? orderedWorkflow(project).at(-1)!;
}

export function reviewWorkflowState(project: AgentProject): WorkflowState | undefined {
  return stateByCategory(project, 'review');
}

export function blockedWorkflowState(project: AgentProject): WorkflowState | undefined {
  return stateByCategory(project, 'blocked');
}

export function isTaskDone(state: TeamState, taskId: string): boolean {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return false;
  const project = state.projects.find((item) => item.id === task.projectId);
  const workflow = project?.workflow.find((item) => item.id === task.workflowStateId);
  return workflow?.category === 'done';
}

export function dependenciesSatisfied(state: TeamState, task: TeamTask): boolean {
  return task.dependencyIds.every((id) => isTaskDone(state, id));
}

export function runningCount(state: TeamState, projectId: string): number {
  return state.runs.filter((run) => run.projectId === projectId && ['queued', 'running', 'waiting'].includes(run.state)).length;
}

/**
 * Counts only Agent Team's own runs. Finch's global runtime status also covers
 * Sessions the mini tool does not own, so it must never drive this board.
 */
export function runSummary(runs: AgentRun[]): { active: number; waiting: number; total: number } {
  let active = 0;
  let waiting = 0;
  for (const run of runs) {
    if (run.state === 'waiting') waiting += 1;
    else if (run.state === 'queued' || run.state === 'running') active += 1;
  }
  return { active, waiting, total: runs.length };
}

export function roleRunningCount(state: TeamState, projectId: string, roleId: string): number {
  return state.runs.filter((run) => run.projectId === projectId && run.roleId === roleId && ['queued', 'running', 'waiting'].includes(run.state)).length;
}

export function runnableTasks(state: TeamState, project: AgentProject): TeamTask[] {
  if (project.status !== 'active') return [];
  const workflow = new Map(project.workflow.map((item) => [item.id, item]));
  const slots = Math.max(0, project.maxConcurrency - runningCount(state, project.id));
  if (slots === 0) return [];

  return state.tasks
    .filter((task) => task.projectId === project.id)
    .filter((task) => task.autoStart && !task.activeRunId && task.attempt < task.maxAttempts)
    .filter((task) => ['backlog', 'ready'].includes(workflow.get(task.workflowStateId)?.category ?? ''))
    .filter((task) => dependenciesSatisfied(state, task))
    .filter((task) => {
      const role = project.roles.find((item) => item.id === task.roleId);
      return role ? roleRunningCount(state, project.id, role.id) < role.concurrencyLimit : false;
    })
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
    .slice(0, slots);
}

export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!source.trim()) throw new Error('模型没有返回 JSON 对象');
  return JSON.parse(source);
}

/**
 * Convert a worker's terminal response into a bounded, persisted handoff.
 * Legacy free-form worker replies remain supported, but never become control
 * instructions for the reviewer: they are wrapped as untrusted handoff text.
 */
export function toWorkerReport(output: string): WorkerReport {
  const fallback = (): WorkerReport => ({
    status: 'completed',
    summary: truncate(output, 1_600) || 'Worker 未提供文字汇报。',
    artifacts: [],
    verification: [],
    risks: [],
    handoff: truncate(output, 4_000),
    fallback: true,
  });
  try {
    const raw = extractJsonObject(output);
    if (!raw || typeof raw !== 'object') return fallback();
    const value = raw as Record<string, unknown>;
    const status = value.status === 'blocked' || value.status === 'needs_input' || value.status === 'completed'
      ? value.status
      : 'completed';
    const artifacts = Array.isArray(value.artifacts)
      ? value.artifacts.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const entry = item as Record<string, unknown>;
          const path = typeof entry.path === 'string' ? entry.path.trim() : '';
          return path ? [{ path: truncate(path, 1_000), ...(typeof entry.description === 'string' && entry.description.trim()
            ? { description: truncate(entry.description.trim(), 500) }
            : {}) }] : [];
        }).slice(0, 50)
      : [];
    return {
      status,
      summary: typeof value.summary === 'string' && value.summary.trim() ? truncate(value.summary.trim(), 1_600) : truncate(output, 1_600),
      artifacts,
      verification: stringList(value.verification, 50, 500),
      risks: stringList(value.risks, 50, 500),
      handoff: typeof value.handoff === 'string' && value.handoff.trim() ? truncate(value.handoff.trim(), 4_000) : truncate(output, 4_000),
    };
  } catch {
    return fallback();
  }
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .slice(0, maxItems)
      .map((item) => truncate(item.trim(), maxLength))
    : [];
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function validCategory(value: unknown): value is WorkflowCategory {
  return typeof value === 'string' && CATEGORIES.includes(value as WorkflowCategory);
}

function nonEmpty(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function validateGeneratedProject(value: unknown): GeneratedProject {
  if (!value || typeof value !== 'object') throw new Error('项目草案不是对象');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.workflow) || raw.workflow.length < 3) throw new Error('Workflow 至少需要 3 个状态');
  if (!Array.isArray(raw.roles) || raw.roles.length === 0) throw new Error('至少需要 1 个角色');
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error('至少需要 1 个任务');

  const workflowRows = raw.workflow;
  const workflow = workflowRows.map((item, order) => {
    const row = item as Record<string, unknown>;
    const category = validCategory(row.category) ? row.category : order === workflowRows.length - 1 ? 'done' : 'ready';
    return {
      id: nonEmpty(row.id, `state-${order + 1}`),
      name: nonEmpty(row.name, `State ${order + 1}`),
      category,
      color: nonEmpty(row.color, COLORS[order % COLORS.length]),
      terminal: row.terminal === true || category === 'done' || category === 'cancelled',
    };
  });
  const workflowIds = new Set(workflow.map((item) => item.id));
  if (workflowIds.size !== workflow.length) throw new Error('Workflow 状态 id 必须唯一');
  if (!workflow.some((item) => item.category === 'active')) throw new Error('Workflow 必须包含 active 状态');
  if (!workflow.some((item) => item.category === 'done')) throw new Error('Workflow 必须包含 done 状态');

  const roles = raw.roles.map((item, index) => {
    const row = item as Record<string, unknown>;
    return {
      id: nonEmpty(row.id, `role-${index + 1}`),
      name: nonEmpty(row.name, `Role ${index + 1}`),
      mission: nonEmpty(row.mission, '完成分配的任务并提交可验证的工作报告。'),
      modelKey: nonEmpty(row.modelKey, ''),
      reasoningEffort: ['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(row.reasoningEffort))
        ? row.reasoningEffort as AgentRole['reasoningEffort'] : 'medium',
      spaceId: typeof row.spaceId === 'string' ? row.spaceId : undefined,
      useWorkspace: row.useWorkspace === true ? true : row.useWorkspace === false ? false : undefined,
      color: nonEmpty(row.color, COLORS[(index + 2) % COLORS.length]),
      concurrencyLimit: Math.max(1, Math.min(8, Number(row.concurrencyLimit) || 1)),
    };
  });
  const roleIds = new Set(roles.map((item) => item.id));
  const taskRows = raw.tasks as Record<string, unknown>[];
  const taskIds = new Set(taskRows.map((row, index) => nonEmpty(row.id, `task-${index + 1}`)));

  const tasks = taskRows.map((row, index) => {
    const id = nonEmpty(row.id, `task-${index + 1}`);
    const roleId = nonEmpty(row.roleId, roles[0].id);
    const workflowStateId = nonEmpty(row.workflowStateId, workflow[0].id);
    return {
      id,
      title: nonEmpty(row.title, `Task ${index + 1}`),
      description: nonEmpty(row.description, ''),
      acceptanceCriteria: Array.isArray(row.acceptanceCriteria) ? row.acceptanceCriteria.map(String).filter(Boolean) : [],
      workflowStateId: workflowIds.has(workflowStateId) ? workflowStateId : workflow[0].id,
      roleId: roleIds.has(roleId) ? roleId : roles[0].id,
      modelKey: typeof row.modelKey === 'string' ? row.modelKey : undefined,
      reasoningEffort: ['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(row.reasoningEffort))
        ? row.reasoningEffort as AgentRole['reasoningEffort'] : undefined,
      spaceId: typeof row.spaceId === 'string' ? row.spaceId : undefined,
      dependencyIds: Array.isArray(row.dependencyIds)
        ? row.dependencyIds.map(String).filter((dependency) => dependency !== id && taskIds.has(dependency)) : [],
      priority: Math.max(0, Math.min(100, Number(row.priority) || 50)),
      autoStart: row.autoStart !== false,
      maxAttempts: Math.max(1, Math.min(5, Number(row.maxAttempts) || 2)),
    };
  });

  return { name: nonEmpty(raw.name, 'Agent Team Project'), goal: nonEmpty(raw.goal, ''), workflow, roles, tasks };
}

export function hasDependencyCycle(tasks: Array<Pick<TeamTask, 'id' | 'dependencyIds'>>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const map = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of map.get(id)?.dependencyIds ?? []) if (map.has(dep) && visit(dep)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}
