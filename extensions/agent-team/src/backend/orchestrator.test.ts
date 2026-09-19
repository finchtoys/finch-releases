import type * as finch from 'finch';
import { describe, expect, it, vi } from 'vitest';
import type { AppRequest } from '../shared/types.js';
import { AgentTeamOrchestrator } from './orchestrator.js';
import { TeamStore } from './store.js';

const generatedPlan = JSON.stringify({
  name: 'Parallel launch', goal: 'Ship two independent deliverables',
  workflow: [
    { id: 'ready', name: 'Ready', category: 'ready', color: '#64748b', terminal: false },
    { id: 'active', name: 'Active', category: 'active', color: '#8b5cf6', terminal: false },
    { id: 'review', name: 'Review', category: 'review', color: '#f59e0b', terminal: false },
    { id: 'done', name: 'Done', category: 'done', color: '#22c55e', terminal: true },
  ],
  roles: [
    { id: 'dev', name: 'Developer', mission: 'Build', modelKey: 'test:model', reasoningEffort: 'high', useWorkspace: true, color: '#3b82f6', concurrencyLimit: 2 },
  ],
  tasks: [
    { id: 'a', title: 'Task A', description: 'A', acceptanceCriteria: ['A done'], workflowStateId: 'ready', roleId: 'dev', dependencyIds: [], priority: 80 },
    { id: 'b', title: 'Task B', description: 'B', acceptanceCriteria: ['B done'], workflowStateId: 'ready', roleId: 'dev', dependencyIds: [], priority: 70 },
  ],
});

function mockContext(spaces: Array<{ id: string; name: string; directoryPath?: string }> = []) {
  let stored: unknown;
  let sessionCounter = 0;
  let turnCounter = 0;
  let scopeCounter = 0;
  let taskCounter = 0;
  let artifactCounter = 0;
  let handoffCounter = 0;
  let documentCounter = 0;
  let eventListener: ((event: finch.SessionBridgeEvent) => unknown) | undefined;
  let collaborationTool: finch.ToolDefinition | undefined;
  let discoveryProvider: finch.ToolSearchProvider | undefined;
  const sessions = {
    create: vi.fn(async () => ({ sessionId: `session-${++sessionCounter}`, owner: { type: 'minitool', minitoolId: 'agent-team' }, placement: { type: 'chat' }, activity: 'background', state: { pinned: false, archived: false }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
    send: vi.fn(async (sessionId: string) => ({ sessionId, turnId: `turn-${++turnCounter}`, clientMessageId: `msg-${turnCounter}`, state: 'accepted', queued: false, pendingCount: 1, queuePosition: 0 })),
    onDidReceiveEvent: vi.fn((listener) => { eventListener = listener; return { dispose() {} }; }),
    listEvents: vi.fn(async () => ({ events: [] })),
    listWaits: vi.fn(async () => []),
    waitForTurn: vi.fn(() => new Promise(() => undefined)),
    cancelTurn: vi.fn(async () => true),
    respondToWait: vi.fn(async () => ({ state: 'accepted', requestId: 'wait-1' })),
  };
  const ctx = {
    subscriptions: [] as finch.Disposable[],
    storage: { get: vi.fn(async () => stored), set: vi.fn(async (_key: string, value: unknown) => { stored = structuredClone(value); }), delete: vi.fn(), clear: vi.fn() },
    models: { list: vi.fn(async () => [{ modelKey: 'test:model', providerId: 'test', providerName: 'Test', modelId: 'model', name: 'Test Model', supportsThinking: true, reasoningLevels: ['off', 'medium', 'high'] }]) },
    spaces: { list: vi.fn(async () => spaces) },
    tools: {
      register: vi.fn((definition: finch.ToolDefinition) => { collaborationTool = definition; return { dispose() {} }; }),
      registerDiscoveryProvider: vi.fn((provider: finch.ToolSearchProvider) => { discoveryProvider = provider; return { dispose() {} }; }),
    },
    artifacts: {
      publish: vi.fn(async () => ({ artifactId: `artifact-${++artifactCounter}` })),
    },
    collaboration: {
      scopes: { create: vi.fn(async () => ({ scopeId: `scope-${++scopeCounter}` })) },
      documents: { create: vi.fn(async () => ({ documentId: `document-${++documentCounter}`, revision: 1 })) },
      tasks: {
        create: vi.fn(async () => ({ taskId: `shared-task-${++taskCounter}`, version: 1 })),
        claim: vi.fn(async (input: { taskId: string; expectedVersion: number }) => ({ state: 'updated', task: { taskId: input.taskId, version: input.expectedVersion + 1 } })),
        update: vi.fn(async (input: { taskId: string; expectedVersion: number }) => ({ state: 'updated', task: { taskId: input.taskId, version: input.expectedVersion + 1 } })),
      },
      handoffs: {
        create: vi.fn(async () => ({ handoffId: `handoff-${++handoffCounter}`, version: 1 })),
        get: vi.fn(async (handoffId: string) => ({ handoffId, version: 1, state: 'created' })),
        accept: vi.fn(async (input: { handoffId: string }) => ({ state: 'updated', handoff: { handoffId: input.handoffId, version: 2, state: 'accepted' } })),
        reject: vi.fn(async (input: { handoffId: string }) => ({ state: 'updated', handoff: { handoffId: input.handoffId, version: 2, state: 'rejected' } })),
      },
    },
    sessions,
    status: { get: vi.fn(async () => ({ status: 'idle', runningCount: 0, waitingCount: 0, unreadCount: 0, updatedAt: new Date().toISOString() })), onDidChange: vi.fn(() => ({ dispose() {} })) },
    notifications: { onDidPost: vi.fn(() => ({ dispose() {} })) },
    logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  } as unknown as finch.MiniToolContext;
  return {
    ctx,
    sessions,
    emit: (event: finch.SessionBridgeEvent) => eventListener?.(event),
    tool: () => {
      if (!collaborationTool) throw new Error('collaboration tool was not registered');
      return collaborationTool;
    },
    discovery: () => {
      if (!discoveryProvider) throw new Error('collaboration discovery provider was not registered');
      return discoveryProvider;
    },
  };
}

describe('AgentTeamOrchestrator', () => {
  it('rejects a project without any authorized work location', async () => {
    const mock = mockContext();
    const store = new TeamStore(mock.ctx, ':memory:');
    const orchestrator = new AgentTeamOrchestrator(mock.ctx, store);
    await orchestrator.initialize();

    await expect(orchestrator.handleRequest({
      type: 'agent-team:create-project',
      input: { brief: 'No location', commanderModelKey: 'test:model', commanderReasoningEffort: 'high', spaceIds: [], workspaceAllowed: false, permissionMode: 'ask', maxConcurrency: 1 },
    })).rejects.toThrow('请至少授权一个 Space，或允许使用默认工作间');
    expect(mock.sessions.create).not.toHaveBeenCalled();
    expect(store.current.projects).toHaveLength(0);
  });

  it('creates an AI project, applies the durable planner event, and fans out ready tasks', async () => {
    const mock = mockContext();
    const store = new TeamStore(mock.ctx, ':memory:');
    const orchestrator = new AgentTeamOrchestrator(mock.ctx, store);
    await orchestrator.initialize();

    await orchestrator.handleRequest({
      type: 'agent-team:create-project',
      input: { brief: 'Build A and B', commanderModelKey: 'test:model', commanderReasoningEffort: 'high', spaceIds: [], workspaceAllowed: true, permissionMode: 'ask', maxConcurrency: 2 },
    });
    const planner = store.current.runs[0];
    expect(store.current.projects[0].status).toBe('planning');
    expect(planner.kind).toBe('planner');

    mock.emit({ type: 'turn.completed', sequence: 1, sessionId: planner.sessionId, turnId: planner.turnId, outputText: generatedPlan, messageIds: ['m1'], createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.current.projects[0].status).toBe('draft'));
    expect(store.current.tasks).toHaveLength(2);

    await orchestrator.handleRequest({ type: 'agent-team:start-project', projectId: store.current.projects[0].id });
    const workers = store.current.runs.filter((run) => run.kind === 'worker');
    expect(workers).toHaveLength(2);
    expect(new Set(workers.map((run) => run.sessionId)).size).toBe(2);
    expect(mock.sessions.create).toHaveBeenCalledTimes(3);
    // Authorized workspace: own sessions are created without a container or Space placement.
    for (const call of mock.sessions.create.mock.calls) {
      expect(call[0]).not.toHaveProperty('containerId');
      expect(call[0]).not.toHaveProperty('space');
    }
  });

  it('places planner and Workers in an authorized Space without a container fallback', async () => {
    const mock = mockContext([{ id: 'space-1', name: 'Project Space' }]);
    const store = new TeamStore(mock.ctx, ':memory:');
    const orchestrator = new AgentTeamOrchestrator(mock.ctx, store);
    await orchestrator.initialize();
    await orchestrator.handleRequest({
      type: 'agent-team:create-project',
      input: { brief: 'Space project', commanderModelKey: 'test:model', commanderReasoningEffort: 'high', spaceIds: ['space-1'], workspaceAllowed: false, permissionMode: 'ask', maxConcurrency: 2 },
    });
    const planner = store.current.runs[0];
    const spacePlan = JSON.parse(generatedPlan);
    spacePlan.roles[0].spaceId = 'space-1';
    spacePlan.roles[0].useWorkspace = false;
    mock.emit({ type: 'turn.completed', sequence: 1, sessionId: planner.sessionId, turnId: planner.turnId, outputText: JSON.stringify(spacePlan), messageIds: ['m1'], createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.current.projects[0].status).toBe('draft'));
    await orchestrator.handleRequest({ type: 'agent-team:start-project', projectId: store.current.projects[0].id });

    for (const call of mock.sessions.create.mock.calls) {
      expect(call[0]).toMatchObject({ space: { spaceId: 'space-1' } });
      expect(call[0]).not.toHaveProperty('containerId');
    }
  });

  it('uses the commander as each Worker parent and handles started/unknown events without ending the turn', async () => {
    const mock = mockContext();
    const store = new TeamStore(mock.ctx, ':memory:');
    const orchestrator = new AgentTeamOrchestrator(mock.ctx, store);
    await orchestrator.initialize();
    await orchestrator.handleRequest({
      type: 'agent-team:create-project',
      input: { brief: 'Lifecycle', commanderModelKey: 'test:model', commanderReasoningEffort: 'high', spaceIds: [], workspaceAllowed: true, permissionMode: 'ask', maxConcurrency: 2 },
    });
    const planner = store.current.runs[0];
    mock.emit({ type: 'turn.completed', sequence: 1, sessionId: planner.sessionId, turnId: planner.turnId, outputText: generatedPlan, messageIds: ['m1'], createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.current.projects[0].status).toBe('draft'));
    await orchestrator.handleRequest({ type: 'agent-team:start-project', projectId: store.current.projects[0].id });
    const worker = store.current.runs.find((run) => run.kind === 'worker')!;

    const workerCreate = mock.sessions.create.mock.calls.find((call) => call[0].title.includes('Task A'));
    expect(workerCreate?.[0].parentSessionId).toBe(planner.sessionId);
    mock.emit({
      type: 'turn.started', sequence: 2, sessionId: worker.sessionId, turnId: worker.turnId,
      modelKey: 'test:model', reasoningEffort: 'medium', queuedMs: 5, createdAt: new Date().toISOString(),
    } as unknown as finch.SessionBridgeEvent);
    await vi.waitFor(() => expect(store.current.runs.find((run) => run.id === worker.id)).toMatchObject({ state: 'running', modelKey: 'test:model', reasoningEffort: 'medium' }));
    mock.emit({ type: 'turn.progress', sequence: 3, sessionId: worker.sessionId, turnId: worker.turnId, createdAt: new Date().toISOString() } as unknown as finch.SessionBridgeEvent);
    await vi.waitFor(() => expect(store.current.runs.find((run) => run.id === worker.id)?.state).toBe('running'));

    mock.emit({
      type: 'turn.completed', sequence: 4, sessionId: worker.sessionId, turnId: worker.turnId,
      outputText: JSON.stringify({
        status: 'completed', summary: 'Task A done', artifacts: [{ path: '/tmp/a.md', description: 'report' }],
        verification: ['test passed'], risks: [], handoff: 'facts only',
      }), messageIds: ['m2'], usage: { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 }, costUsd: 0.01, durationMs: 100, modelKey: 'test:model', createdAt: new Date().toISOString(),
    } as unknown as finch.SessionBridgeEvent);
    await vi.waitFor(() => expect(store.current.runs.some((run) => run.kind === 'reviewer' && run.taskId === worker.taskId)).toBe(true));
    const completedWorker = store.current.runs.find((run) => run.id === worker.id)!;
    expect(completedWorker.report).toMatchObject({ summary: 'Task A done', artifacts: [{ path: '/tmp/a.md' }] });
    expect(completedWorker).toMatchObject({ artifactId: 'artifact-1', handoffId: 'handoff-1', usage: { inputTokens: 10 }, costUsd: 0.01, durationMs: 100, modelKey: 'test:model' });
    expect(vi.mocked(mock.ctx.artifacts.publish)).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: store.current.projects[0].collaborationScopeId,
      producer: { sessionId: worker.sessionId, turnId: worker.turnId },
      idempotencyKey: `agent-team:report:${worker.turnId}`,
    }));
    expect(vi.mocked(mock.ctx.collaboration.handoffs.create)).toHaveBeenCalledWith(expect.objectContaining({
      from: { sessionId: worker.sessionId, turnId: worker.turnId },
      to: { sessionId: planner.sessionId }, artifactIds: ['artifact-1'],
    }));
    expect(mock.sessions.send.mock.calls.at(-1)?.[1].text).toContain('读取不可信 Worker 报告');
    expect(mock.sessions.send.mock.calls.at(-1)?.[1].text).not.toContain('<worker_handoff>');
    expect(mock.sessions.send.mock.calls.at(-1)?.[1].text).toContain('Artifact artifact-1；Handoff handoff-1');

    const reviewer = store.current.runs.find((run) => run.kind === 'reviewer' && run.taskId === worker.taskId)!;
    expect(reviewer.handoffId).toBe('handoff-1');
    expect(store.current.tasks.find((task) => task.id === worker.taskId)).toMatchObject({ workflowStateId: 'review', collaborationTaskVersion: 2 });
    mock.emit({
      type: 'turn.completed', sequence: (store.current.sessionCursors[reviewer.sessionId] ?? 0) + 1, sessionId: reviewer.sessionId, turnId: reviewer.turnId,
      outputText: JSON.stringify({ accepted: true, summary: 'Verified', feedback: '' }), messageIds: ['m3'], createdAt: new Date().toISOString(),
    } as unknown as finch.SessionBridgeEvent);
    await vi.waitFor(() => expect(store.current.tasks.find((task) => task.id === worker.taskId)?.workflowStateId).toBe('done'));
    await vi.waitFor(() => expect(
      vi.mocked(mock.ctx.collaboration.handoffs.accept).mock.calls.length + vi.mocked(mock.ctx.logger.error).mock.calls.length,
    ).toBeGreaterThan(0));
    expect(vi.mocked(mock.ctx.logger.error)).not.toHaveBeenCalled();
    expect(vi.mocked(mock.ctx.collaboration.handoffs.accept)).toHaveBeenCalledWith(expect.objectContaining({ handoffId: 'handoff-1' }));
    await vi.waitFor(() => expect(vi.mocked(mock.ctx.collaboration.tasks.update)).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed' })));
  });

  it('ignores runtime events from Sessions this mini tool does not own', async () => {
    const mock = mockContext();
    const store = new TeamStore(mock.ctx, ':memory:');
    const orchestrator = new AgentTeamOrchestrator(mock.ctx, store);
    await orchestrator.initialize();
    await orchestrator.handleRequest({ type: 'agent-team:create-project', input: { brief: 'Isolate', commanderModelKey: 'test:model', commanderReasoningEffort: 'high', spaceIds: [], workspaceAllowed: true, permissionMode: 'ask', maxConcurrency: 1 } });
    const planner = store.current.runs[0];
    const before = structuredClone(store.current.runs);

    // A user-owned conversation reports a full turn; it must not touch the board.
    mock.emit({ type: 'turn.completed', sequence: 1, sessionId: 'user-session', turnId: 'user-turn', outputText: '{"name":"Hijack"}', messageIds: ['m9'], createdAt: new Date().toISOString() });
    mock.emit({ type: 'assistant.delta', sequence: 2, sessionId: 'user-session', turnId: 'user-turn', delta: 'noise', createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.current.sessionCursors['user-session']).toBeUndefined());

    expect(store.current.runs).toEqual(before);
    expect(store.current.projects[0].status).toBe('planning');
    expect(store.current.projects[0].name).toBe('正在规划…');

    // The same event shape on our own planner Session still advances the project.
    mock.emit({ type: 'turn.completed', sequence: 1, sessionId: planner.sessionId, turnId: planner.turnId, outputText: generatedPlan, messageIds: ['m1'], createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.current.projects[0].status).toBe('draft'));
  });

  it('updates a role and applies the chosen work location', async () => {
    const mock = mockContext();
    const store = new TeamStore(mock.ctx, ':memory:');
    const orchestrator = new AgentTeamOrchestrator(mock.ctx, store);
    await orchestrator.initialize();
    await orchestrator.handleRequest({ type: 'agent-team:create-project', input: { brief: 'Roles', commanderModelKey: 'test:model', commanderReasoningEffort: 'high', spaceIds: [], workspaceAllowed: true, permissionMode: 'ask', maxConcurrency: 1 } });
    const planner = store.current.runs[0];
    mock.emit({ type: 'turn.completed', sequence: 1, sessionId: planner.sessionId, turnId: planner.turnId, outputText: generatedPlan, messageIds: ['m1'], createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.current.projects[0].status).toBe('draft'));

    const project = store.current.projects[0];
    const role = project.roles[0];
    await orchestrator.handleRequest({
      type: 'agent-team:update-role',
      projectId: project.id,
      roleId: role.id,
      role: { name: '架构师', mission: '负责架构决策', modelKey: 'test:model', reasoningEffort: 'medium', color: '#123456', concurrencyLimit: 3, useWorkspace: true },
    });

    const updated = store.current.projects[0].roles[0];
    expect(updated.name).toBe('架构师');
    expect(updated.mission).toBe('负责架构决策');
    expect(updated.concurrencyLimit).toBe(3);
    expect(updated.color).toBe('#123456');
    expect(updated.spaceId).toBeUndefined();
    expect(updated.useWorkspace).toBe(true);

    await expect(orchestrator.handleRequest({
      type: 'agent-team:update-role',
      projectId: project.id,
      roleId: role.id,
      role: { ...updated, useWorkspace: false },
    })).rejects.toThrow('角色必须选择已授权的 Space 或默认工作间');

    await expect(orchestrator.handleRequest({
      type: 'agent-team:update-role',
      projectId: project.id,
      roleId: role.id,
      role: { ...updated, modelKey: 'missing:model' },
    })).rejects.toThrow('角色模型不可用');
  });

  it('registers one dynamic collaboration tool and commits the planner output through it', async () => {
    const mock = mockContext();
    const store = new TeamStore(mock.ctx, ':memory:');
    const orchestrator = new AgentTeamOrchestrator(mock.ctx, store);
    await orchestrator.initialize();
    const tool = mock.tool();
    expect(tool).toMatchObject({ name: 'agent_team_collaboration', exposure: 'dynamic', defaultEnabled: true });
    expect(await mock.discovery().search({ query: 'Agent Team collaboration' }, { sessionId: 'user-session' })).toEqual([]);
    await expect(tool.execute({ action: 'get_context' }, { sessionId: 'user-session' } as finch.ToolExecutionContext))
      .rejects.toThrow('不属于正在运行的 Agent Team');

    await orchestrator.handleRequest({ type: 'agent-team:create-project', input: { brief: 'Tool plan', commanderModelKey: 'test:model', commanderReasoningEffort: 'high', spaceIds: [], workspaceAllowed: true, permissionMode: 'ask', maxConcurrency: 1 } });
    const planner = store.current.runs[0];
    expect(await mock.discovery().search({ query: 'Agent Team collaboration' }, { sessionId: planner.sessionId })).toEqual([
      expect.objectContaining({ toolName: 'agent_team_collaboration' }),
    ]);
    const context = await tool.execute({ action: 'get_context' }, { sessionId: planner.sessionId } as finch.ToolExecutionContext);
    expect(JSON.parse(context.content[0].type === 'text' ? context.content[0].text : '{}')).toMatchObject({
      role: 'planner', project: { fallbackModelKey: 'test:model', workspaceAllowed: true }, models: [{ modelKey: 'test:model' }],
    });
    const unavailableModelPlan = JSON.parse(generatedPlan);
    unavailableModelPlan.roles[0].modelKey = 'missing:model';
    await expect(tool.execute(
      { action: 'commit_plan', plan: unavailableModelPlan },
      { sessionId: planner.sessionId, toolCallId: 'call-invalid-plan' } as finch.ToolExecutionContext,
    )).rejects.toThrow('配置的模型不可用');
    expect(vi.mocked(mock.ctx.artifacts.publish)).not.toHaveBeenCalled();
    await tool.execute(
      { action: 'commit_plan', plan: JSON.parse(generatedPlan) },
      { sessionId: planner.sessionId, toolCallId: 'call-plan' } as finch.ToolExecutionContext,
    );
    expect(store.current.projects[0]).toMatchObject({ status: 'draft', planArtifactId: 'artifact-1', planDocumentId: 'document-1', planRevision: 1 });
    expect(store.current.tasks).toHaveLength(2);
    expect(vi.mocked(mock.ctx.collaboration.documents.create)).toHaveBeenCalledWith(expect.objectContaining({ initialArtifactId: 'artifact-1' }));

    mock.emit({ type: 'turn.failed', sequence: 1, sessionId: planner.sessionId, turnId: planner.turnId, code: 'final_response_failed', message: 'final text failed after tool submission', retryable: false, createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.current.runs[0].state).toBe('completed'));
    expect(store.current.projects[0].status).toBe('draft');
  });

  it('uses the dynamic tool for Worker artifacts and Reviewer decisions without JSON final replies', async () => {
    const mock = mockContext();
    const store = new TeamStore(mock.ctx, ':memory:');
    const orchestrator = new AgentTeamOrchestrator(mock.ctx, store);
    await orchestrator.initialize();
    const tool = mock.tool();
    await orchestrator.handleRequest({ type: 'agent-team:create-project', input: { brief: 'Tool handoff', commanderModelKey: 'test:model', commanderReasoningEffort: 'high', spaceIds: [], workspaceAllowed: true, permissionMode: 'ask', maxConcurrency: 1 } });
    const planner = store.current.runs[0];
    await tool.execute({ action: 'commit_plan', plan: JSON.parse(generatedPlan) }, { sessionId: planner.sessionId, toolCallId: 'call-plan' } as finch.ToolExecutionContext);
    mock.emit({ type: 'turn.completed', sequence: 1, sessionId: planner.sessionId, turnId: planner.turnId, outputText: '计划已提交。', messageIds: ['m1'], createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.current.runs[0].state).toBe('completed'));
    await orchestrator.handleRequest({ type: 'agent-team:start-project', projectId: store.current.projects[0].id });
    const worker = store.current.runs.find((run) => run.kind === 'worker')!;
    expect(mock.sessions.send.mock.calls.at(-1)?.[1].text).toContain('action=submit_result');
    expect(mock.sessions.send.mock.calls.at(-1)?.[1].text).not.toContain('"status":"completed');

    const workerContext = await tool.execute({ action: 'get_context' }, { sessionId: worker.sessionId, cwd: '/workspace' } as finch.ToolExecutionContext);
    expect(JSON.parse(workerContext.content[0].type === 'text' ? workerContext.content[0].text : '{}')).toMatchObject({ role: 'worker', task: { title: 'Task A' } });
    await tool.execute({
      action: 'submit_result', status: 'completed', summary: 'Task A done',
      artifacts: [{ path: 'result.md', description: 'final report' }], verification: ['tests passed'], risks: [], handoff: 'facts only',
    }, { sessionId: worker.sessionId, cwd: '/workspace', toolCallId: 'call-worker' } as finch.ToolExecutionContext);
    expect(vi.mocked(mock.ctx.artifacts.publish)).toHaveBeenCalledWith(expect.objectContaining({ source: { type: 'file', path: '/workspace/result.md' } }));
    expect(store.current.runs.find((run) => run.id === worker.id)).toMatchObject({ report: { summary: 'Task A done' }, artifactIds: ['artifact-3', 'artifact-2'], handoffId: 'handoff-1' });

    mock.emit({ type: 'turn.completed', sequence: 1, sessionId: worker.sessionId, turnId: worker.turnId, outputText: '结果已提交。', messageIds: ['m2'], createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.current.runs.some((run) => run.kind === 'reviewer')).toBe(true));
    const reviewer = store.current.runs.find((run) => run.kind === 'reviewer')!;
    const reviewContext = await tool.execute({ action: 'get_context' }, { sessionId: reviewer.sessionId } as finch.ToolExecutionContext);
    expect(JSON.parse(reviewContext.content[0].type === 'text' ? reviewContext.content[0].text : '{}')).toMatchObject({
      role: 'reviewer', workerReport: { summary: 'Task A done' }, artifactIds: ['artifact-3', 'artifact-2'], handoffId: 'handoff-1',
    });
    await tool.execute({ action: 'review_handoff', accepted: true, summary: 'Verified' }, { sessionId: reviewer.sessionId, toolCallId: 'call-review' } as finch.ToolExecutionContext);
    mock.emit({ type: 'turn.completed', sequence: 2, sessionId: reviewer.sessionId, turnId: reviewer.turnId, outputText: '验收已通过。', messageIds: ['m3'], createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.current.tasks.find((task) => task.id === worker.taskId)?.workflowStateId).toBe('done'));
    expect(vi.mocked(mock.ctx.collaboration.handoffs.accept)).toHaveBeenCalledWith(expect.objectContaining({ handoffId: 'handoff-1' }));
  });

  it('surfaces a wait and relays the user response to the existing card', async () => {
    const mock = mockContext();
    const store = new TeamStore(mock.ctx, ':memory:');
    const orchestrator = new AgentTeamOrchestrator(mock.ctx, store);
    await orchestrator.initialize();
    await orchestrator.handleRequest({ type: 'agent-team:create-project', input: { brief: 'Test waits', commanderModelKey: 'test:model', commanderReasoningEffort: 'high', spaceIds: [], workspaceAllowed: true, permissionMode: 'ask', maxConcurrency: 1 } });
    const run = store.current.runs[0];
    mock.emit({ type: 'turn.waiting', sequence: 1, sessionId: run.sessionId, turnId: run.turnId, reason: 'question', requestId: 'wait-1', wait: { kind: 'question', requestId: 'wait-1', sessionId: run.sessionId, turnId: run.turnId, createdAt: new Date().toISOString(), questions: [{ header: 'Direction', question: 'Which?', multiSelect: false, options: [{ label: 'A', description: '' }] }] }, createdAt: new Date().toISOString() });
    await vi.waitFor(() => expect(store.current.waits).toHaveLength(1));
    const request: AppRequest = { type: 'agent-team:respond-wait', sessionId: run.sessionId, requestId: 'wait-1', response: { kind: 'question', answers: { Direction: 'A' } } };
    await orchestrator.handleRequest(request);
    expect(mock.sessions.respondToWait).toHaveBeenCalledWith(run.sessionId, 'wait-1', request.response);
    expect(store.current.waits).toHaveLength(0);
  });
});
