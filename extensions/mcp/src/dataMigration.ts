import type * as finch from 'finch';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeMcpServerAlias } from './serverOwnership.js';

export const MCP_DATA_MIGRATION_VERSION = 2;

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
  /**
   * `partial` means the configuration was published but at least one business
   * credential could not be verified; those servers stay disabled and the
   * completion marker is withheld so the next start retries them.
   */
  state: 'idle' | 'running' | 'completed' | 'partial' | 'conflict' | 'failed';
  conflictCount?: number;
  error?: string;
}

function readServers(path: string): ServerConfig[] {
  const file = serversFilePath(path);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { servers?: unknown };
  if (!parsed || !Array.isArray(parsed.servers)) throw new Error('Invalid MCP configuration');
  if (!parsed.servers.every((value) => value && typeof value === 'object'
    && typeof value.name === 'string' && value.name.trim())) throw new Error('Invalid MCP server entry');
  return parsed.servers as ServerConfig[];
}

function serversFilePath(storagePath: string): string {
  return join(storagePath, 'servers.json');
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

interface MigrationMarker {
  /** Data-import stage version (see MCP_DATA_MIGRATION_VERSION). */
  version?: number;
  completed?: boolean;
  sources?: string[];
  completedAt?: string;
  conflictCount?: number;
  /** Legacy v2 fields, kept readable for compatibility (no longer written/acted on). */
  pendingCredentials?: string[];
  pendingSourcePurge?: string[];
  /** Slots whose custody write has not been verified yet. */
  pendingSlots?: SlotRef[];
  /**
   * Historical source ids that still hold plaintext credentials. REPORT ONLY:
   * ordinary historical storage is explicitly out of scope for this phase, so it
   * is listed for the owner to handle and never auto-purged.
   */
  sourcesRetainingPlaintext?: string[];
  /** Normalized server names the user removed; never re-imported. */
  removedServers?: string[];
  /**
   * Servers THIS migration disabled while a slot was pending. Only these may be
   * re-enabled on recovery — a disable the user performed is never overridden.
   */
  disabledByMigration?: string[];
}

/** Minimal migration access the importer needs (mirrors the internal context). */
interface McpMigrationAccess {
  readSecret(capability: string, sourceId: string, key: string): Promise<string | undefined>;
}

function readMarker(dataPath: string): MigrationMarker | undefined {
  try {
    return JSON.parse(readFileSync(join(dataPath, 'migration.json'), 'utf8')) as MigrationMarker;
  } catch {
    return undefined;
  }
}

function markerCompleted(marker: MigrationMarker | undefined): boolean {
  return marker?.version === MCP_DATA_MIGRATION_VERSION && marker.completed === true;
}

function readConflicts(dataPath: string): MigrationConflict[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dataPath, 'migration-conflicts.json'), 'utf8')) as { conflicts?: unknown };
    return Array.isArray(parsed.conflicts) ? parsed.conflicts as MigrationConflict[] : [];
  } catch {
    return [];
  }
}

function atomicWrite(path: string, name: string, value: unknown): void {
  mkdirSync(path, { recursive: true });
  const target = join(path, name);
  const temp = join(path, `.${name}.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, target);
}

function sanitizeSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function targetSecretRef(serverName: string, envKey: string): string {
  return `mcp.${sanitizeSegment(serverName)}.env.${sanitizeSegment(envKey)}`;
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

  let marker = readMarker(dataPath);
  const stableServers = readServers(dataPath);
  const priorConflicts = (marker?.version === MCP_DATA_MIGRATION_VERSION || marker?.version === 1)
    ? readConflicts(dataPath)
    : [];
  const migration = internal.capabilityMigration;
  const historical = migration?.sources('mcp.client') ?? [];

  // ── Stage 1: data import. A completed run is never repeated, so it can neither
  // re-import configuration nor resurrect a deleted server.
  if (!markerCompleted(marker)) {
    if (!migration) return { state: 'failed', error: 'MCP migration access is unavailable' };
    marker = await importHistoricalServers(ctx, migration, historical, dataPath, marker, stableServers);
    stableServers.splice(0, stableServers.length, ...readServers(dataPath));
  }

  // ── Stage 2: slot-level credential retry. Only the slots still pending are
  // touched, so an already-verified reference is never rebuilt from a source that
  // may have changed, and a deleted server is never re-imported.
  if (migration && (marker?.pendingSlots?.length ?? 0) > 0) {
    marker = await retryPendingSlots(ctx, migration, historical, dataPath, marker!, stableServers);
    stableServers.splice(0, stableServers.length, ...readServers(dataPath));
  }

  // Historical source files are READ ONLY here: this phase imports credentials
  // into custody and never rewrites or deletes ordinary historical storage. The
  // ids that still hold plaintext are reported for the owner, not claimed clean.
  marker = reportRetainedSources(dataPath, marker, historical);

  return pendingState(marker, priorConflicts.length);
}

/**
 * Record which historical sources still hold plaintext, so the receipt is honest
 * about what this phase did NOT do. Nothing is written to those sources.
 */
function reportRetainedSources(
  dataPath: string,
  marker: MigrationMarker | undefined,
  historical: ReadonlyArray<MigrationSource>,
): MigrationMarker | undefined {
  if (!marker) return marker;
  const retained: string[] = [];
  for (const source of historical) {
    try {
      const raw = readFileSync(serversFilePath(source.storagePath), 'utf8');
      if (/(secretRefs|"env"|apiKey|token)/i.test(raw)) retained.push(source.id);
    } catch { /* unreadable source is reported by the import path */ }
  }
  const next = { ...marker, sourcesRetainingPlaintext: retained };
  if (JSON.stringify(marker.sourcesRetainingPlaintext ?? []) !== JSON.stringify(retained)) {
    writeMarker(dataPath, next);
  }
  return next;
}

function pendingState(marker: MigrationMarker | undefined, conflictCount: number): McpMigrationState {
  const pendingCredentials = marker?.pendingSlots?.length ?? 0;
  if (markerCompleted(marker) && pendingCredentials === 0) {
    return conflictCount > 0 ? { state: 'conflict', conflictCount } : { state: 'completed', conflictCount };
  }
  return {
    state: 'partial',
    conflictCount,
    error: 'Some MCP credentials could not be migrated; they stay disabled and will be retried',
  };
}

/** Single historical credential slot awaiting migration or source purification. */
interface SlotRef {
  /** Target server name. */
  server: string;
  /** Server name inside the historical source file. */
  sourceServer: string;
  envKey: string;
  source: string;
  kind: 'ref' | 'env';
  sourceRef?: string;
}

async function importHistoricalServers(
  ctx: finch.MiniToolContext,
  migration: McpMigrationAccess,
  historical: ReadonlyArray<MigrationSource>,
  dataPath: string,
  marker: MigrationMarker | undefined,
  stableServers: ServerConfig[],
): Promise<MigrationMarker> {
  const previouslyApplied = marker?.version === MCP_DATA_MIGRATION_VERSION
    || (marker?.version === 1 && marker.completed === true);
  const stableNames = new Set(stableServers.map((server) => normalizedName(server.name)));
  const removed = new Set(marker?.removedServers ?? []);
  // A server whose slots are already being retried is likewise never re-imported:
  // otherwise a user who deletes a partially-migrated server would see it come
  // back on the next run (the retry stage records the tombstone instead).
  const trackedNames = new Set([
    ...stableNames,
    ...(marker?.pendingSlots ?? []).map((slot) => normalizedName(slot.server)),
  ]);

  // A server already present (or tracked) is authoritative and is never
  // re-imported; a tombstoned (user-deleted) server is never resurrected.
  const sources = [
    { id: 'stable', servers: stableServers },
    ...historical.map((source) => ({
      id: source.id,
      servers: readServers(source.storagePath).filter((server) => (
        !removed.has(normalizedName(server.name))
        && !trackedNames.has(normalizedName(server.name))
      )),
    })),
  ];
  const result = mergeMcpServerSources(sources);
  const allConflicts = [...(previouslyApplied ? readConflicts(dataPath) : []), ...result.conflicts];

  const prepared: ServerConfig[] = [];
  const pending: SlotRef[] = [];
  const disabledByMigration = new Set(marker?.disabledByMigration ?? []);
  const sourceNameByImported = new Map(result.conflicts.map((conflict) => [
    `${conflict.source}\u0000${conflict.importedName}`,
    conflict.originalName,
  ]));

  for (const raw of result.servers) {
    const { migrationSource, ...server } = raw;
    if (!migrationSource || migrationSource === 'stable') {
      prepared.push(server);
      continue;
    }
    const sourceServer = sourceNameByImported.get(`${migrationSource}\u0000${server.name}`) ?? server.name;
    const nextRefs: Record<string, string> = { ...(server.secretRefs ?? {}) };
    const slots: SlotRef[] = [
      ...Object.entries(server.secretRefs ?? {}).map(([envKey, sourceRef]) => (
        { server: server.name, sourceServer, envKey, source: migrationSource, kind: 'ref' as const, sourceRef }
      )),
      ...Object.keys(server.env ?? {}).map((envKey) => (
        { server: server.name, sourceServer, envKey, source: migrationSource, kind: 'env' as const }
      )),
    ];
    const outcome = await migrateSlots(ctx, migration, historical, slots, nextRefs, server);
    pending.push(...outcome.pending);
    const { env: _plaintextEnv, ...withoutPlaintextEnv } = server;
    // Only a server THIS migration actually disabled earns automatic re-enable.
    // A source that was already `enabled: false` was disabled by the user, and that
    // intent must survive a later recovery.
    if (outcome.pending.length > 0 && server.enabled !== false) {
      disabledByMigration.add(normalizedName(server.name));
    }
    prepared.push({
      ...withoutPlaintextEnv,
      ...(server.secretRefs || Object.keys(nextRefs).length ? { secretRefs: nextRefs } : {}),
      ...(outcome.pending.length > 0 ? { enabled: false, credentialMigrationFailed: true } : {}),
    });
  }

  // Legacy markers only recorded "this server failed", without slot detail: derive
  // the missing slots from the historical sources so the retry stays slot-level
  // and never rebuilds a reference that was already verified.
  for (const server of prepared) {
    if ((server as { credentialMigrationFailed?: boolean }).credentialMigrationFailed !== true) continue;
    for (const source of historical) {
      const sourceServer = readServers(source.storagePath)
        .find((candidate) => normalizedName(candidate.name) === normalizedName(server.name));
      if (!sourceServer) continue;
      for (const envKey of Object.keys(sourceServer.secretRefs ?? {})) {
        if (server.secretRefs?.[envKey]) continue;
        const slot: SlotRef = {
          server: server.name, sourceServer: sourceServer.name, envKey, source: source.id,
          kind: 'ref', sourceRef: (sourceServer.secretRefs ?? {})[envKey],
        };
        if (!pending.some((entry) => sameSlot(entry, slot))) pending.push(slot);
      }
      for (const envKey of serverEnvKeys(sourceServer)) {
        if (server.secretRefs?.[envKey]) continue;
        const slot: SlotRef = { server: server.name, sourceServer: sourceServer.name, envKey, source: source.id, kind: 'env' };
        if (!pending.some((entry) => sameSlot(entry, slot))) pending.push(slot);
      }
    }
  }

  publishServers(dataPath, prepared, allConflicts);
  // Derive the completion flag from the FULL queue (previous run's pending slots
  // included), never from just this run's additions: otherwise a server left
  // pending by an earlier partial would be marked complete.
  const queuedSlots = dedupeSlots([...(marker?.pendingSlots ?? []), ...pending]);
  const nextMarker: MigrationMarker = {
    ...marker,
    version: MCP_DATA_MIGRATION_VERSION,
    completed: queuedSlots.length === 0,
    completedAt: new Date().toISOString(),
    sources: historical.map((source) => source.id),
    conflictCount: allConflicts.length,
    pendingCredentials: [...new Set(queuedSlots.map((slot) => slot.server))],
    pendingSourcePurge: [],
    pendingSlots: queuedSlots,
    removedServers: marker?.removedServers ?? [],
    disabledByMigration: [...disabledByMigration],
  };
  writeMarker(dataPath, nextMarker);
  return nextMarker;
}

/**
 * Slot-level retry. Only the reported slots are retried and only their own
 * reference is added, so a previously verified reference can never disappear.
 */
async function retryPendingSlots(
  ctx: finch.MiniToolContext,
  migration: McpMigrationAccess,
  historical: ReadonlyArray<MigrationSource>,
  dataPath: string,
  marker: MigrationMarker,
  stableServers: ServerConfig[],
): Promise<MigrationMarker> {
  // Dedupe the queue: the same (server, envKey, source) slot must be handled once.
  const pendingSlots = dedupeSlots(marker.pendingSlots ?? []);
  // Two passes at most: if the user edits the target while this run is awaiting
  // secret writes, the edit is picked up by re-reading it instead of publishing a
  // stale snapshot over their ref/note/enabled.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const base = attempt === 0 ? stableServers : readServers(dataPath);
    const pass = await retryPass(ctx, migration, historical, dataPath, marker, base);
    if (!pass.conflict) return pass.marker;
  }
  // Still moving under us after both passes: never publish the servers snapshot.
  // The marker is rebuilt from what is on disk NOW, so state the user changed during
  // those awaits (a disable that revoked this migration's recovery eligibility) is
  // preserved instead of being restored from the pre-run marker. Only the queue and
  // the completion flag are (re)asserted.
  const onDisk = readMarker(dataPath);
  const settled: MigrationMarker = {
    ...(onDisk ?? marker),
    pendingSlots: dedupeSlots([...(onDisk?.pendingSlots ?? []), ...pendingSlots]),
    completed: false,
  };
  writeMarker(dataPath, settled);
  return settled;
}

async function retryPass(
  ctx: finch.MiniToolContext,
  migration: McpMigrationAccess,
  historical: ReadonlyArray<MigrationSource>,
  dataPath: string,
  markerInput: MigrationMarker,
  stableServers: ServerConfig[],
): Promise<{ conflict: false; marker: MigrationMarker } | { conflict: true }> {
  // Re-read the marker: the user's own disable (a real UI action) is recorded
  // there, and it must be able to revoke this migration's recovery intent even
  // while a retry is in flight.
  const marker = readMarker(dataPath) ?? markerInput;
  const pendingSlots = dedupeSlots(marker.pendingSlots ?? []);
  const prepared = stableServers.map((server) => ({ ...server }));
  const remaining: SlotRef[] = [];
  const removedServers = new Set(marker.removedServers ?? []);
  const disabledByMigration = new Set(marker.disabledByMigration ?? []);

  for (const slot of pendingSlots) {
    const server = prepared.find((candidate) => normalizedName(candidate.name) === normalizedName(slot.server));
    if (!server) {
      // The target no longer has this server: the user deleted it. Never
      // resurrect it; record it so a later run does not re-import either.
      removedServers.add(normalizedName(slot.server));
      continue;
    }
    // Resolution order, highest first:
    //   1. the ref the target currently points at, when it resolves to a value;
    //   2. the canonical target ref, when it ALREADY holds a valid value — a
    //      legitimate fix made outside this migration must be bound, not overwritten
    //      with the stale source;
    //   3. only when both are explicitly missing may the source be written.
    // An unreadable entry is never treated as missing: it stays pending.
    const existingRef = server.secretRefs?.[slot.envKey];
    if (typeof existingRef === 'string') {
      const probe = await probeCustodyValue(ctx, existingRef);
      if (probe === 'present') continue;
      if (probe === 'error') {
        remaining.push(slot);
        continue;
      }
    }
    const canonicalRef = targetSecretRef(String(server.name), slot.envKey);
    if (canonicalRef !== existingRef) {
      const probe = await probeCustodyValue(ctx, canonicalRef);
      if (probe === 'error') {
        remaining.push(slot);
        continue;
      }
      if (probe === 'present') {
        // Bind the existing canonical value; never write the source over it.
        Object.assign(server, {
          secretRefs: { ...(server.secretRefs ?? {}), [slot.envKey]: canonicalRef },
        });
        continue;
      }
    }
    const nextRefs: Record<string, string> = { ...(server.secretRefs ?? {}) };
    const outcome = await migrateSlots(ctx, migration, historical, [slot], nextRefs, server);
    if (outcome.verified.length > 0) {
      // Only add the reference this slot resolved to; never touch other slots.
      Object.assign(server, { secretRefs: { ...nextRefs } });
    } else {
      remaining.push(slot);
    }
  }

  // Per-service state is derived from what actually remains: a server with no
  // pending slot clears the failure marker, and it is re-enabled only when THIS
  // migration disabled it (a user disable stays in effect).
  for (const server of prepared) {
    const name = normalizedName(server.name);
    const stillPending = remaining.some((slot) => normalizedName(slot.server) === name);
    if (stillPending) {
      // Eligibility is only ever granted to a server that this retry itself turned
      // off. A server the user had already disabled (or that an earlier stage
      // disabled without eligibility) must not gain a right to be re-enabled.
      const wasEnabled = server.enabled !== false;
      (server as { credentialMigrationFailed?: boolean }).credentialMigrationFailed = true;
      server.enabled = false;
      if (wasEnabled) disabledByMigration.add(name);
    } else if (disabledByMigration.has(name)) {
      delete (server as { credentialMigrationFailed?: boolean }).credentialMigrationFailed;
      server.enabled = true;
      disabledByMigration.delete(name);
    } else if (server.credentialMigrationFailed === true) {
      // Recovered, but the user had disabled it: drop only the failure marker.
      delete (server as { credentialMigrationFailed?: boolean }).credentialMigrationFailed;
    }
  }

  // The user may have edited the target while this run was awaiting secret writes.
  // Publishing our snapshot would overwrite their ref/note/enabled wholesale, so
  // only publish when the target still matches what this run started from.
  if (JSON.stringify(readServers(dataPath)) !== JSON.stringify(stableServers)
    || JSON.stringify(readMarker(dataPath)) !== JSON.stringify(marker)) {
    return { conflict: true };
  }

  publishServers(dataPath, prepared, readConflicts(dataPath));
  const nextMarker: MigrationMarker = {
    ...marker,
    pendingSlots: remaining,
    removedServers: [...removedServers],
    disabledByMigration: [...disabledByMigration],
    completed: remaining.length === 0,
  };
  writeMarker(dataPath, nextMarker);
  return { conflict: false, marker: nextMarker };
}

/**
 * Revoke this migration's automatic re-enable eligibility for a server the USER
 * disabled. Called from the real user-facing toggle: a user disable issued while a
 * migration is partial must beat the migration's own recovery intent, so a later
 * recovery never turns the server back on behind their back.
 */
export function revokeMigrationRecovery(dataPath: string, serverName: string): void {
  const marker = readMarker(dataPath);
  if (!marker) return;
  const eligibility = marker.disabledByMigration ?? [];
  const name = normalizedName(serverName);
  if (!eligibility.some((entry) => normalizedName(entry) === name)) return;
  writeMarker(dataPath, {
    ...marker,
    disabledByMigration: eligibility.filter((entry) => normalizedName(entry) !== name),
  });
}

/**
 * Tri-state custody probe. `error` (an unreadable / failing store) is deliberately
 * distinct from `missing`: only a value that is provably absent may be written.
 */
async function probeCustodyValue(
  ctx: finch.MiniToolContext,
  ref: string,
): Promise<'present' | 'missing' | 'error'> {
  try {
    const value = await ctx.secrets.get(ref);
    return typeof value === 'string' && value.length > 0 ? 'present' : 'missing';
  } catch {
    return 'error';
  }
}

/** Is a reference already backed by a stored value (i.e. the slot is satisfied)? */
async function custodyHasValue(ctx: finch.MiniToolContext, ref: string): Promise<boolean> {
  return (await probeCustodyValue(ctx, ref)) === 'present';
}

function dedupeSlots(slots: readonly SlotRef[]): SlotRef[] {
  const unique: SlotRef[] = [];
  for (const slot of slots) if (!unique.some((entry) => sameSlot(entry, slot))) unique.push(slot);
  return unique;
}

/** Migrate the given slots against one target server, adding verified refs. */
async function migrateSlots(
  ctx: finch.MiniToolContext,
  migration: McpMigrationAccess,
  historical: ReadonlyArray<MigrationSource>,
  slots: readonly SlotRef[],
  nextRefs: Record<string, string>,
  server: ServerConfig,
): Promise<{ verified: SlotRef[]; pending: SlotRef[] }> {
  const verified: SlotRef[] = [];
  const pending: SlotRef[] = [];
  for (const slot of slots) {
    try {
      const value = slot.kind === 'ref'
        ? await migration.readSecret('mcp.client', slot.source, slot.sourceRef ?? '')
        : readSourceEnvValue(historical, slot);
      if (value === undefined) throw new Error('missing secret');
      const targetRef = targetSecretRef(server.name, slot.envKey);
      // The same slot resolving to the same reference is NOT a conflict; only a
      // reference already claimed by a DIFFERENT slot is.
      const claimedByOtherSlot = Object.entries(nextRefs)
        .some(([key, ref]) => ref === targetRef && key !== slot.envKey);
      if (claimedByOtherSlot) throw new Error('MCP secret reference collision');
      await writeVerifiedSecret(ctx, targetRef, value);
      nextRefs[slot.envKey] = targetRef;
      verified.push(slot);
    } catch {
      pending.push(slot);
    }
  }
  return { verified, pending };
}

/** Declared env keys of a server config (the field is untyped on disk). */
function serverEnvKeys(server: ServerConfig): string[] {
  const env = server.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return [];
  return Object.keys(env as Record<string, unknown>);
}

/** Plaintext env value of a historical source slot, read on demand. */
function readSourceEnvValue(historical: ReadonlyArray<MigrationSource>, slot: SlotRef): string | undefined {
  const source = historical.find((candidate) => candidate.id === slot.source);
  if (!source) return undefined;
  const server = readServers(source.storagePath).find((candidate) => candidate.name === slot.sourceServer);
  const env = server?.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return undefined;
  const value = (env as Record<string, unknown>)[slot.envKey];
  return typeof value === 'string' ? value : undefined;
}

function sameSlot(left: SlotRef, right: SlotRef): boolean {
  return left.source === right.source
    && left.sourceServer === right.sourceServer
    && left.envKey === right.envKey
    && left.kind === right.kind;
}

function publishServers(dataPath: string, servers: ServerConfig[], conflicts: MigrationConflict[]): void {
  const tmpPath = join(dataPath, '.migration-tmp');
  rmSync(tmpPath, { recursive: true, force: true });
  mkdirSync(tmpPath, { recursive: true, mode: 0o700 });
  atomicWrite(tmpPath, 'servers.json', { servers });
  if (conflicts.length) atomicWrite(tmpPath, 'migration-conflicts.json', { conflicts });
  mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  renameSync(join(tmpPath, 'servers.json'), join(dataPath, 'servers.json'));
  if (conflicts.length) renameSync(join(tmpPath, 'migration-conflicts.json'), join(dataPath, 'migration-conflicts.json'));
  else rmSync(join(dataPath, 'migration-conflicts.json'), { force: true });
  rmSync(tmpPath, { recursive: true, force: true });
}

function writeMarker(dataPath: string, marker: MigrationMarker): void {
  atomicWrite(dataPath, 'migration.json', marker);
}

/** Write a secret and prove it reads back identical before the ref is published. */
async function writeVerifiedSecret(ctx: finch.MiniToolContext, ref: string, value: string): Promise<void> {
  await ctx.secrets.set(ref, value);
  const readBack = await ctx.secrets.get(ref);
  if (readBack !== value) throw new Error('MCP secret write verification failed');
}
