import { describe, expect, it } from 'vitest';
import {
  dependenciesSatisfied,
  extractJsonObject,
  hasDependencyCycle,
  normalizeState,
  runnableTasks,
  runSummary,
  validateGeneratedProject,
} from './domain.js';
import type { AgentProject, AgentRun, TeamState, TeamTask } from './types.js';

const createdAt = '2026-09-13T00:00:00.000Z';
const workflow = [
  { id: 'ready', name: '待执行', category: 'ready' as const, color: '#64748b', order: 0, terminal: false },
  { id: 'active', name: '进行中', category: 'active' as const, color: '#8b5cf6', order: 1, terminal: false },
  { id: 'done', name: '完成', category: 'done' as const, color: '#22c55e', order: 2, terminal: true },
];
const project: AgentProject = {
  id: 'project-1', name: 'Test', brief: 'Test', goal: 'Test', status: 'active', workflow,
  roles: [{ id: 'dev', name: 'Dev', mission: 'Build', modelKey: 'test:model', reasoningEffort: 'medium', color: '#3b82f6', concurrencyLimit: 2 }],
  taskIds: ['task-a', 'task-b'], commanderModelKey: 'test:model', commanderReasoningEffort: 'high', spaceIds: [],
  workspaceAllowed: true, permissionMode: 'ask', maxConcurrency: 2, reviewMode: 'commander', createdAt, updatedAt: createdAt,
};
function task(id: string, dependencyIds: string[] = []): TeamTask {
  return { id, projectId: project.id, title: id, description: '', acceptanceCriteria: [], workflowStateId: 'ready', roleId: 'dev', dependencyIds, priority: 50, autoStart: true, attempt: 0, maxAttempts: 2, createdAt, updatedAt: createdAt };
}
function state(tasks: TeamTask[]): TeamState {
  return { schemaVersion: 1, sessionCursors: {}, projects: [project], tasks, runs: [], waits: [], activities: [] };
}

function runRecord(id: string): AgentRun {
  return {
    id, projectId: project.id, kind: 'worker', sessionId: `session-${id}`, turnId: `turn-${id}`,
    state: 'running', eventCursor: 0, pendingCount: 0, createdAt,
  };
}

describe('Agent Team domain', () => {
  it('extracts JSON from plain or fenced model output', () => {
    expect(extractJsonObject('before {"accepted":true} after')).toEqual({ accepted: true });
    expect(extractJsonObject('```json\n{"name":"demo"}\n```')).toEqual({ name: 'demo' });
  });

  it('validates and normalizes generated projects', () => {
    const generated = validateGeneratedProject({
      name: 'Ship feature', goal: 'Deliver it', workflow: [
        { id: 'ready', name: 'Ready', category: 'ready', color: '#64748b' },
        { id: 'active', name: 'Active', category: 'active', color: '#8b5cf6' },
        { id: 'done', name: 'Done', category: 'done', color: '#22c55e' },
      ],
      roles: [{ id: 'dev', name: 'Developer', mission: 'Build', modelKey: 'test:model', reasoningEffort: 'high', color: '#3b82f6' }],
      tasks: [{ id: 't1', title: 'Build', description: 'Build it', acceptanceCriteria: ['Tests pass'], workflowStateId: 'ready', roleId: 'dev', dependencyIds: [], priority: 80 }],
    });
    expect(generated.roles[0].concurrencyLimit).toBe(1);
    expect(generated.tasks[0].autoStart).toBe(true);
    expect(generated.tasks[0].maxAttempts).toBe(2);
  });

  it('detects dependency cycles', () => {
    expect(hasDependencyCycle([task('a', ['b']), task('b', ['a'])])).toBe(true);
    expect(hasDependencyCycle([task('a'), task('b', ['a'])])).toBe(false);
  });

  it('dispatches only dependency-ready tasks within concurrency limits', () => {
    const first = task('task-a');
    const second = task('task-b', ['task-a']);
    const current = state([first, second]);
    expect(dependenciesSatisfied(current, first)).toBe(true);
    expect(dependenciesSatisfied(current, second)).toBe(false);
    expect(runnableTasks(current, project).map((item) => item.id)).toEqual(['task-a']);
    first.workflowStateId = 'done';
    expect(runnableTasks(current, project).map((item) => item.id)).toEqual(['task-b']);
    second.workflowStateId = 'blocked';
    expect(runnableTasks(current, project)).toEqual([]);
  });

  it('rejects generated workflows without active and done states', () => {
    expect(() => validateGeneratedProject({
      name: 'Bad', goal: 'Bad',
      workflow: [
        { id: 'a', name: 'A', category: 'ready' },
        { id: 'b', name: 'B', category: 'review' },
        { id: 'c', name: 'C', category: 'blocked' },
      ],
      roles: [{ id: 'dev', name: 'Dev', modelKey: 'test:model' }],
      tasks: [{ id: 't', title: 'T', roleId: 'dev', workflowStateId: 'a' }],
    })).toThrow('active');
  });

  it('counts only its own runs, never global app activity', () => {
    const summary = runSummary([
      { ...runRecord('a'), state: 'running' },
      { ...runRecord('b'), state: 'queued' },
      { ...runRecord('c'), state: 'waiting' },
      { ...runRecord('d'), state: 'completed' },
      { ...runRecord('e'), state: 'failed' },
    ]);
    expect(summary).toEqual({ active: 2, waiting: 1, total: 5 });
    expect(runSummary([])).toEqual({ active: 0, waiting: 0, total: 0 });
  });

  it('normalizes corrupt storage without losing the schema contract', () => {
    expect(normalizeState({ schemaVersion: 1, projects: 'bad' })).toMatchObject({ schemaVersion: 1, sessionCursors: {}, projects: [], tasks: [] });
    expect(normalizeState({ schemaVersion: 2 })).toMatchObject({ schemaVersion: 1, projects: [] });
  });
});
