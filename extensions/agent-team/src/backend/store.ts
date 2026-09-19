import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type * as finch from 'finch';
import { normalizeState } from '../shared/domain.js';
import type {
  AgentProject, AgentRun, AppSnapshot, ModelOption, ProjectActivity,
  SpaceOption, TeamState, TeamTask, TeamWait,
} from '../shared/types.js';

const LEGACY_STORAGE_KEY = 'agent-team.state.v1';
const DATABASE_NAME = 'agent-team.sqlite';
const DATABASE_SCHEMA_VERSION = 1;

type Listener = (snapshot: AppSnapshot) => void | Promise<void>;
type PayloadRow = { payload: string };
type CursorRow = { session_id: string; sequence: number | bigint };
type MetaRow = { value: string };

export class TeamStore {
  private state: TeamState = normalizeState(undefined);
  private models: ModelOption[] = [];
  private spaces: SpaceOption[] = [];
  private listeners = new Set<Listener>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(
    private readonly ctx: finch.MiniToolContext,
    databasePath = join(ctx.storagePath, DATABASE_NAME),
  ) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.configureDatabase();
    this.createSchema();
    this.ctx.subscriptions.push({ dispose: () => this.dispose() });
  }

  async load(): Promise<void> {
    await this.migrateLegacyState();
    this.state = this.readState();
    await this.refreshRuntimeData();
  }

  get current(): TeamState {
    return this.state;
  }

  snapshot(): AppSnapshot {
    return structuredClone({
      ...this.state,
      models: this.models,
      spaces: this.spaces,
    });
  }

  async refreshRuntimeData(): Promise<void> {
    this.state = this.readState();
    const [models, spaces] = await Promise.all([
      this.ctx.models.list(),
      this.ctx.spaces.list(),
    ]);
    this.models = models as ModelOption[];
    this.spaces = spaces as SpaceOption[];
    await this.emit();
  }

  subscribe(listener: Listener): finch.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async mutate<T>(mutation: (state: TeamState) => T, persist = true): Promise<T> {
    const operation = this.queue.then(async () => {
      let result: T;
      if (persist) {
        result = this.transaction(() => {
          // Reload while holding the write reservation so separate Finch windows
          // cannot overwrite a newer committed state with a stale snapshot.
          this.state = this.readState();
          const value = mutation(this.state);
          this.replaceRows(this.state);
          this.incrementRevision();
          return value;
        });
      } else {
        result = mutation(this.state);
      }
      await this.emit();
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async emit(): Promise<void> {
    const snapshot = this.snapshot();
    await Promise.allSettled([...this.listeners].map((listener) => listener(snapshot)));
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private configureDatabase(): void {
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = NORMAL');
    this.database.exec('PRAGMA foreign_keys = ON');
  }

  private createSchema(): void {
    const version = Number((this.database.prepare('PRAGMA user_version').get() as { user_version: number | bigint }).user_version);
    if (version > DATABASE_SCHEMA_VERSION) {
      throw new Error(`Agent Team 数据库版本 ${version} 高于当前支持版本 ${DATABASE_SCHEMA_VERSION}`);
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agent_team_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workflow_state_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        priority INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id, sort_order);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS runs_project_idx ON runs(project_id, sort_order);
      CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(json_extract(payload, '$.sessionId'));
      CREATE TABLE IF NOT EXISTS waits (
        request_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS waits_project_idx ON waits(project_id, sort_order);
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS activities_project_idx ON activities(project_id, sort_order);
      CREATE TABLE IF NOT EXISTS session_cursors (
        session_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};
    `);
  }

  private async migrateLegacyState(): Promise<void> {
    const legacy = await this.ctx.storage.get<unknown>(LEGACY_STORAGE_KEY);
    const hasLegacyState = legacy !== undefined;
    let imported = false;
    this.transaction(() => {
      const initialized = this.getMeta('initialized');
      if (initialized === '1') return;
      this.replaceRows(normalizeState(legacy));
      this.setMeta('initialized', '1');
      this.setMeta('revision', '1');
      imported = hasLegacyState;
    });
    if (hasLegacyState) {
      try {
        await this.ctx.storage.delete(LEGACY_STORAGE_KEY);
        if (imported) this.ctx.logger.info('Migrated Agent Team state from ctx.storage to SQLite');
      } catch (error) {
        this.ctx.logger.warn('SQLite state is ready, but legacy state cleanup failed', error);
      }
    }
  }

  private readState(): TeamState {
    return normalizeState({
      schemaVersion: 1,
      sessionCursors: Object.fromEntries(
        (this.database.prepare('SELECT session_id, sequence FROM session_cursors').all() as CursorRow[])
          .map((row) => [row.session_id, Number(row.sequence)]),
      ),
      projects: this.readPayloads<AgentProject>('SELECT payload FROM projects ORDER BY sort_order'),
      tasks: this.readPayloads<TeamTask>('SELECT payload FROM tasks ORDER BY sort_order'),
      runs: this.readPayloads<AgentRun>('SELECT payload FROM runs ORDER BY sort_order'),
      waits: this.readPayloads<TeamWait>('SELECT payload FROM waits ORDER BY sort_order'),
      activities: this.readPayloads<ProjectActivity>('SELECT payload FROM activities ORDER BY sort_order'),
    });
  }

  private readPayloads<T>(sql: string): T[] {
    const result: T[] = [];
    for (const row of this.database.prepare(sql).all() as PayloadRow[]) {
      try {
        result.push(JSON.parse(row.payload) as T);
      } catch (error) {
        this.ctx.logger.warn('Skipped corrupt Agent Team SQLite row', error);
      }
    }
    return result;
  }

  private replaceRows(state: TeamState): void {
    this.database.exec(`
      DELETE FROM session_cursors;
      DELETE FROM activities;
      DELETE FROM waits;
      DELETE FROM runs;
      DELETE FROM tasks;
      DELETE FROM projects;
    `);

    const insertProject = this.database.prepare('INSERT INTO projects(id, status, updated_at, sort_order, payload) VALUES (?, ?, ?, ?, ?)');
    state.projects.forEach((item, index) => insertProject.run(item.id, item.status, item.updatedAt, index, JSON.stringify(item)));

    const insertTask = this.database.prepare('INSERT INTO tasks(id, project_id, workflow_state_id, role_id, priority, updated_at, sort_order, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    state.tasks.forEach((item, index) => insertTask.run(item.id, item.projectId, item.workflowStateId, item.roleId, item.priority, item.updatedAt, index, JSON.stringify(item)));

    const insertRun = this.database.prepare('INSERT INTO runs(id, project_id, task_id, state, created_at, sort_order, payload) VALUES (?, ?, ?, ?, ?, ?, ?)');
    state.runs.forEach((item, index) => insertRun.run(item.id, item.projectId, item.taskId ?? null, item.state, item.createdAt, index, JSON.stringify(item)));

    const insertWait = this.database.prepare('INSERT INTO waits(request_id, project_id, run_id, created_at, sort_order, payload) VALUES (?, ?, ?, ?, ?, ?)');
    state.waits.forEach((item, index) => insertWait.run(item.requestId, item.projectId, item.runId, item.createdAt, index, JSON.stringify(item)));

    const insertActivity = this.database.prepare('INSERT INTO activities(id, project_id, created_at, sort_order, payload) VALUES (?, ?, ?, ?, ?)');
    state.activities.forEach((item, index) => insertActivity.run(item.id, item.projectId, item.createdAt, index, JSON.stringify(item)));

    const insertCursor = this.database.prepare('INSERT INTO session_cursors(session_id, sequence) VALUES (?, ?)');
    Object.entries(state.sessionCursors).forEach(([sessionId, sequence]) => insertCursor.run(sessionId, sequence));
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  private getMeta(key: string): string | undefined {
    return (this.database.prepare('SELECT value FROM agent_team_meta WHERE key = ?').get(key) as MetaRow | undefined)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO agent_team_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private incrementRevision(): void {
    this.setMeta('revision', String(Number(this.getMeta('revision') ?? 0) + 1));
  }
}
