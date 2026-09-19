import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as finch from 'finch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamState } from '../shared/types.js';
import { TeamStore } from './store.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'finch-agent-team-'));
  tempDirectories.push(directory);
  return join(directory, 'agent-team.sqlite');
}

function mockContext(legacy?: unknown) {
  const storage = {
    get: vi.fn(async () => legacy),
    set: vi.fn(),
    delete: vi.fn(async () => undefined),
    clear: vi.fn(),
  };
  const ctx = {
    storagePath: tmpdir(),
    subscriptions: [] as finch.Disposable[],
    storage,
    models: { list: vi.fn(async () => []) },
    spaces: { list: vi.fn(async () => []) },
    status: { get: vi.fn(async () => undefined) },
    logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  } as unknown as finch.MiniToolContext;
  return { ctx, storage };
}

function legacyState(): TeamState {
  return {
    schemaVersion: 1,
    sessionCursors: { 'session-1': 7 },
    projects: [], tasks: [], runs: [], waits: [],
    activities: [{
      id: 'activity-1', projectId: 'project-1', kind: 'system',
      message: 'Migrated', createdAt: '2026-09-13T00:00:00.000Z',
    }],
  };
}

describe('TeamStore SQLite persistence', () => {
  it('creates a missing private storage directory before opening SQLite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-agent-team-'));
    tempDirectories.push(root);
    const databasePath = join(root, 'private', 'nested', 'agent-team.sqlite');
    const store = new TeamStore(mockContext().ctx, databasePath);
    await store.load();
    store.dispose();
    expect(existsSync(databasePath)).toBe(true);
  });

  it('migrates legacy ctx.storage once and persists across reopen', async () => {
    const databasePath = createDatabasePath();
    const first = mockContext(legacyState());
    const store = new TeamStore(first.ctx, databasePath);
    await store.load();

    expect(store.current.sessionCursors['session-1']).toBe(7);
    expect(store.current.activities[0].message).toBe('Migrated');
    expect(first.storage.delete).toHaveBeenCalledWith('agent-team.state.v1');

    await store.mutate((state) => {
      state.activities.push({
        id: 'activity-2', projectId: 'project-1', kind: 'system',
        message: 'Persisted', createdAt: '2026-09-13T00:01:00.000Z',
      });
    });
    store.dispose();

    const second = mockContext();
    const reopened = new TeamStore(second.ctx, databasePath);
    await reopened.load();
    expect(reopened.current.activities.map((item) => item.message)).toEqual(['Migrated', 'Persisted']);
    expect(second.storage.delete).not.toHaveBeenCalled();
    reopened.dispose();
  });

  it('serializes writers through SQLite transactions without lost updates', async () => {
    const databasePath = createDatabasePath();
    const first = new TeamStore(mockContext().ctx, databasePath);
    const second = new TeamStore(mockContext().ctx, databasePath);
    await first.load();
    await second.load();

    await Promise.all([
      first.mutate((state) => state.activities.push({
        id: 'writer-a', projectId: 'project-1', kind: 'system',
        message: 'A', createdAt: '2026-09-13T00:00:00.000Z',
      })),
      second.mutate((state) => state.activities.push({
        id: 'writer-b', projectId: 'project-1', kind: 'system',
        message: 'B', createdAt: '2026-09-13T00:00:01.000Z',
      })),
    ]);
    await first.refreshRuntimeData();
    expect(first.current.activities.map((item) => item.id)).toEqual(['writer-a', 'writer-b']);
    first.dispose();
    second.dispose();

    const verifier = new TeamStore(mockContext().ctx, databasePath);
    await verifier.load();
    expect(verifier.current.activities.map((item) => item.id)).toEqual(['writer-a', 'writer-b']);
    verifier.dispose();
  });
});
