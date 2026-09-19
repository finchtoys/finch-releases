import type * as finch from 'finch';

export type CollaborationToolInput = {
  action: 'get_context' | 'commit_plan' | 'submit_result' | 'review_handoff';
  plan?: Record<string, unknown>;
  status?: 'completed' | 'blocked' | 'needs_input';
  summary?: string;
  artifacts?: Array<{ path: string; description: string }>;
  verification?: string[];
  risks?: string[];
  handoff?: string;
  accepted?: boolean;
  feedback?: string;
};

const id = { type: 'string', minLength: 1, maxLength: 100 } as const;
const shortText = { type: 'string', minLength: 1, maxLength: 500 } as const;

const planSchema: finch.JsonSchema = {
  type: 'object',
  description: 'commit_plan 时提交的完整项目计划。',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    goal: { type: 'string', minLength: 1, maxLength: 2000 },
    workflow: {
      type: 'array', minItems: 2, maxItems: 7,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id, name: shortText,
          category: { type: 'string', enum: ['backlog', 'ready', 'active', 'review', 'done', 'blocked', 'custom'] },
          color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
          terminal: { type: 'boolean' },
        },
        required: ['id', 'name', 'category', 'color', 'terminal'],
      },
    },
    roles: {
      type: 'array', minItems: 1, maxItems: 8,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id, name: shortText,
          mission: { type: 'string', minLength: 1, maxLength: 2000 },
          modelKey: id,
          reasoningEffort: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
          spaceId: id,
          useWorkspace: { type: 'boolean' },
          color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
          concurrencyLimit: { type: 'integer', minimum: 1, maximum: 8 },
        },
        required: ['id', 'name', 'mission', 'modelKey', 'reasoningEffort', 'color'],
      },
    },
    tasks: {
      type: 'array', minItems: 1, maxItems: 20,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id, title: shortText,
          description: { type: 'string', minLength: 1, maxLength: 4000 },
          acceptanceCriteria: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } },
          workflowStateId: id,
          roleId: id,
          modelKey: id,
          reasoningEffort: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
          spaceId: id,
          dependencyIds: { type: 'array', maxItems: 20, items: id },
          priority: { type: 'integer', minimum: 0, maximum: 100 },
          autoStart: { type: 'boolean' },
          maxAttempts: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['id', 'title', 'description', 'acceptanceCriteria', 'workflowStateId', 'roleId', 'dependencyIds', 'priority'],
      },
    },
  },
  required: ['name', 'goal', 'workflow', 'roles', 'tasks'],
  additionalProperties: false,
};

export function createCollaborationDiscoveryProvider(
  ownsActiveSession: (sessionId: string) => boolean,
): finch.ToolSearchProvider {
  return {
    id: 'agent-team-collaboration',
    description: '按需发现 Agent Team 的 Planner、Worker、Reviewer 协作工具。',
    async search(query, ctx) {
      if (!ctx.sessionId || !ownsActiveSession(ctx.sessionId)) return [];
      const text = `${query.query ?? ''} ${query.source ?? ''}`.toLowerCase();
      if (text && !['agent', 'team', 'collaboration', '协作', '计划', '任务', 'handoff', 'review'].some((term) => text.includes(term))) return [];
      return [{
        toolName: 'agent_team_collaboration',
        title: 'Agent Team Collaboration',
        description: '读取角色上下文并提交计划、Worker 产物或验收结论。',
        source: 'agent-team',
      }];
    },
  };
}

export function createCollaborationTool(
  execute: (input: CollaborationToolInput, ctx: finch.ToolExecutionContext) => Promise<finch.ToolResult>,
): finch.ToolDefinition<CollaborationToolInput> {
  return {
    name: 'agent_team_collaboration',
    title: 'Agent Team Collaboration',
    description: `Agent Team 的领域协作入口，仅供该小程序创建的 Planner、Worker、Reviewer Session 使用；普通会话调用会被拒绝。\naction:\n  get_context     — 按当前角色读取最小必要上下文\n  commit_plan     — Planner 校验并提交计划、Document 与共享 Tasks\n  submit_result   — Worker 固化文件/报告 Artifact 并创建 Handoff\n  review_handoff  — Reviewer 接受或拒绝 Handoff 并推进共享 Task`,
    exposure: 'dynamic',
    defaultEnabled: true,
    risk: 'medium',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get_context', 'commit_plan', 'submit_result', 'review_handoff'], description: '当前角色要执行的领域动作。' },
        plan: planSchema,
        status: { type: 'string', enum: ['completed', 'blocked', 'needs_input'] },
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        artifacts: {
          type: 'array', maxItems: 30,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              path: { type: 'string', minLength: 1, maxLength: 2000, description: '当前工作目录内的绝对或相对文件路径。' },
              description: { type: 'string', minLength: 1, maxLength: 1000 },
            },
            required: ['path', 'description'],
          },
        },
        verification: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 2000 } },
        risks: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 2000 } },
        handoff: { type: 'string', maxLength: 4000 },
        accepted: { type: 'boolean' },
        feedback: { type: 'string', maxLength: 4000 },
      },
      required: ['action'],
    },
    callDisplay: { inline: { fields: [{ path: 'action' }] } },
    execute,
  };
}
