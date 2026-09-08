import type * as finch from 'finch';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeMcpServerAlias } from './serverOwnership.js';

export const MCP_DATA_MIGRATION_VERSION = 1;

type ServerConfig = Record<string, unknown> & {
  name: string;
  enabled?: boolean;
  secretRefs?: Record<string, string>;
  credentialMigrationFailed?: boolean;
};

interface MigrationSource {
  id: string;
  storagePath: string;
}

interface InternalMcpContext {
  capabilityStoragePaths?: Record<string, string>;
  capabilityMigration?: {
    sources(capability: string): MigrationSource[];
    readSecret(capability: string, sourceId: string, key: string): Promise<string | undefined>;
  };
}

interface MigrationConflict {
  originalName: string;
  importedName: string;
  source: string;
  differingFields: string[];
}

export interface McpMigrationState {
  state: 'idle' | 'running' | 'completed' | 'conflict' | 'failed';
  conflictCount?: number;
  error?: string;
}

function readServers(path: string): ServerConfig[] {
  const file = join(path, 'servers.json');
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { servers?: unknown };
  if (!parsed || !Array.isArray(parsed.servers)) throw new Error('Invalid MCP configuration');
  if (!parsed.servers.every((value) => value && typeof value === 'object'
    && typeof value.name === 'string' && value.name.trim())) throw new Error('Invalid MCP server entry');
  return parsed.servers as ServerConfig[];
}

function normalizedName(name: string): string {
  // Migration must use the same identity as `mcp__<server>__<tool>` routing.
  // Case-only and separator-only variants cannot survive as distinct servers at
  // runtime, so preserve the lower-priority copy as a disabled conflict instead.
  return normalizeMcpServerAlias(name.trim());
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    if (key === 'migrationSource') continue;
    if (key === 'enabled' && input[key] === true) continue;
    out[key] = canonical(input[key]);
  }
  return out;
}

function sameConfig(left: ServerConfig, right: ServerConfig): boolean {
  return JSON.stringify(canonical({ ...left, enabled: left.enabled ?? true }))
    === JSON.stringify(canonical({ ...right, enabled: right.enabled ?? true }));
}

function differingFields(left: ServerConfig, right: ServerConfig): string[] {
  const fields = new Set([...Object.keys(left), ...Object.keys(right)]);
  fields.delete('name');
  fields.delete('migrationSource');
  return [...fields].filter((field) => {
    const leftValue = field === 'enabled' ? left.enabled ?? true : left[field];
    const rightValue = field === 'enabled' ? right.enabled ?? true : right[field];
    return JSON.stringify(canonical(leftValue)) !== JSON.stringify(canonical(rightValue));
  }).sort();
}

function migratedName(original: string, used: ReadonlySet<string>): string {
  let index = 2;
  let candidate = `${original}-migrated-${index}`;
  while (used.has(normalizedName(candidate))) {
    index += 1;
    candidate = `${original}-migrated-${index}`;
  }
  return candidate;
}

export function mergeMcpServerSources(
  sources: Array<{ id: string; servers: ServerConfig[] }>,
): { servers: Array<ServerConfig & { migrationSource?: string }>; conflicts: MigrationConflict[] } {
  const merged: Array<ServerConfig & { migrationSource?: string }> = [];
  const byName = new Map<string, ServerConfig>();
  const used = new Set<string>();
  const conflicts: MigrationConflict[] = [];

  for (const source of sources) {
    for (const server of source.servers) {
      const key = normalizedName(server.name);
      const existing = byName.get(key);
      if (!existing) {
        const imported = { ...server, migrationSource: source.id };
        merged.push(imported);
        byName.set(key, imported);
        used.add(key);
        continue;
      }
      // 相同引用名不代表不同来源的密钥值相同，不能静默丢弃另一份凭据。
      if (sameConfig(existing, server) && Object.keys(server.secretRefs ?? {}).length === 0) continue;
      const name = migratedName(server.name, used);
      const imported = { ...server, name, enabled: false, migrationSource: source.id };
      merged.push(imported);
      byName.set(normalizedName(name), imported);
      used.add(normalizedName(name));
      conflicts.push({
        originalName: server.name,
        importedName: name,
        source: source.id,
        differingFields: differingFields(existing, server),
      });
    }
  }
  return { servers: merged, conflicts };
}

function markerCompleted(dataPath: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(dataPath, 'migration.json'), 'utf8')) as { version?: number; completed?: boolean };
    return marker.version === MCP_DATA_MIGRATION_VERSION && marker.completed === true;
  } catch {
    return false;
  }
}

function atomicWrite(path: string, name: string, value: unknown): void {
  mkdirSync(path, { recursive: true });
  const target = join(path, name);
  const temp = join(path, `.${name}.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, target);
}

export async function migrateMcpData(ctx: finch.MiniToolContext): Promise<McpMigrationState> {
  try {
    return await runMcpDataMigration(ctx);
  } catch {
    return { state: 'failed', error: 'MCP data migration failed; source data was preserved' };
  }
}

async function runMcpDataMigration(ctx: finch.MiniToolContext): Promise<McpMigrationState> {
  const internal = ctx as finch.MiniToolContext & InternalMcpContext;
  const dataPath = internal.capabilityStoragePaths?.['mcp.client'];
  if (!dataPath) return { state: 'failed', error: 'Stable MCP storage is unavailable' };
  if (markerCompleted(dataPath)) {
    const conflicts = existsSync(join(dataPath, 'migration-conflicts.json'))
      ? (JSON.parse(readFileSync(join(dataPath, 'migration-conflicts.json'), 'utf8')) as { conflicts?: unknown[] }).conflicts?.length ?? 0
      : 0;
    return { state: conflicts > 0 ? 'conflict' : 'completed', conflictCount: conflicts };
  }

  const migration = internal.capabilityMigration;
  if (!migration) return { state: 'failed', error: 'MCP migration access is unavailable' };
  const historical = migration.sources('mcp.client');
  const sources = [
    { id: 'stable', servers: readServers(dataPath) },
    ...historical.map((source) => ({ id: source.id, servers: readServers(source.storagePath) })),
  ];
  const result = mergeMcpServerSources(sources);

  try {
    const prepared: ServerConfig[] = [];
    for (const raw of result.servers) {
      const { migrationSource, ...server } = raw;
      if (!migrationSource || migrationSource === 'stable') {
        prepared.push(server);
        continue;
      }
      const nextRefs: Record<string, string> = {};
      let credentialMigrationFailed = false;
      for (const [envKey, sourceRef] of Object.entries(server.secretRefs ?? {})) {
        try {
          const value = await migration.readSecret('mcp.client', migrationSource, sourceRef);
          if (value === undefined) throw new Error('missing secret');
          const targetRef = `mcp.${normalizedName(server.name).replace(/[^a-z0-9]+/g, '_')}.env.${envKey.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
          if (Object.values(nextRefs).includes(targetRef)) throw new Error('MCP secret reference collision');
          await ctx.secrets.set(targetRef, value);
          nextRefs[envKey] = targetRef;
        } catch {
          credentialMigrationFailed = true;
        }
      }
      prepared.push({
        ...server,
        ...(server.secretRefs ? { secretRefs: nextRefs } : {}),
        ...(credentialMigrationFailed ? { enabled: false, credentialMigrationFailed: true } : {}),
      });
    }

    // 配置和业务密钥迁移不改变 OAuth 凭据归属，也不读取历史 OAuth 存储。

    const tmpPath = join(dataPath, '.migration-tmp');
    rmSync(tmpPath, { recursive: true, force: true });
    mkdirSync(tmpPath, { recursive: true, mode: 0o700 });
    atomicWrite(tmpPath, 'servers.json', { servers: prepared });
    if (result.conflicts.length) atomicWrite(tmpPath, 'migration-conflicts.json', { conflicts: result.conflicts });
    mkdirSync(dataPath, { recursive: true, mode: 0o700 });
    renameSync(join(tmpPath, 'servers.json'), join(dataPath, 'servers.json'));
    if (result.conflicts.length) renameSync(join(tmpPath, 'migration-conflicts.json'), join(dataPath, 'migration-conflicts.json'));
    rmSync(tmpPath, { recursive: true, force: true });
    atomicWrite(dataPath, 'migration.json', {
      version: MCP_DATA_MIGRATION_VERSION,
      completed: true,
      completedAt: new Date().toISOString(),
      sources: historical.map((source) => source.id),
      conflictCount: result.conflicts.length,
    });
    return { state: result.conflicts.length ? 'conflict' : 'completed', conflictCount: result.conflicts.length };
  } catch {
    return { state: 'failed', error: 'MCP data migration failed; source data was preserved' };
  }
}
