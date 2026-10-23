import { randomUUID } from 'node:crypto';
import type * as finch from 'finch';
import { version as extensionVersion } from '../package.json';

export const OBSERVATIONS_KEY = 'send-observations:v1';
export const MAX_OBSERVATIONS = 100;
export const OBSERVATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type SendOutcome = 'accepted' | 'business_rejected' | 'transport_unknown' | 'response_unknown';
export type SendReason = 'prepare_failed' | 'login_expired' | 'other';

/** Intentionally no free-form fields: never persist server text, message content or credentials. */
export interface SendObservation {
  id: string;
  extensionVersion?: string;
  at: number;
  durationMs: number;
  itemType: number;
  textCharacters: number;
  textUtf8Bytes: number;
  requestBytes: number;
  part: number;
  parts: number;
  recentSendCount: number;
  contextReceivedAt: number;
  contextRevision?: string;
  outcome: SendOutcome;
  reason: SendReason;
  ret?: number;
  errcode?: number;
}

function project(value: unknown): SendObservation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !/^[0-9a-f-]{36}$/.test(v.id)
    || !['accepted', 'business_rejected', 'transport_unknown', 'response_unknown'].includes(String(v.outcome))
    || !['prepare_failed', 'login_expired', 'other'].includes(String(v.reason))) return undefined;
  const numericKeys = ['at', 'durationMs', 'itemType', 'textCharacters', 'textUtf8Bytes', 'requestBytes',
    'part', 'parts', 'recentSendCount', 'contextReceivedAt'] as const;
  if (numericKeys.some((key) => typeof v[key] !== 'number' || !Number.isFinite(v[key]) || (v[key] as number) < 0)) return undefined;
  const numbers = Object.fromEntries(numericKeys.map((key) => [key, v[key]]));
  return {
    ...numbers,
    id: v.id, outcome: v.outcome as SendOutcome, reason: v.reason as SendReason,
    ...(typeof v.extensionVersion === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(v.extensionVersion) ? { extensionVersion: v.extensionVersion } : {}),
    ...(typeof v.contextRevision === 'string' && /^[0-9a-f-]{36}$/.test(v.contextRevision) ? { contextRevision: v.contextRevision } : {}),
    ...(typeof v.ret === 'number' && Number.isFinite(v.ret) ? { ret: v.ret } : {}),
    ...(typeof v.errcode === 'number' && Number.isFinite(v.errcode) ? { errcode: v.errcode } : {}),
  } as SendObservation;
}

/** Serialized, bounded, best-effort telemetry; recording failure must never replay or fail a send. */
export class SendObservations {
  private pending: Promise<void> = Promise.resolve();

  constructor(private ctx: finch.MiniToolContext) {}

  newId(): string { return randomUUID(); }

  private async read(): Promise<SendObservation[]> {
    const value = await this.ctx.storage.get<unknown>(OBSERVATIONS_KEY);
    if (!Array.isArray(value)) return [];
    const cutoff = Date.now() - OBSERVATION_RETENTION_MS;
    return value.map(project).filter((row): row is SendObservation => Boolean(row && row.at >= cutoff)).slice(-MAX_OBSERVATIONS);
  }

  async list(limit = 20): Promise<SendObservation[]> {
    await this.pending;
    const count = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_OBSERVATIONS, Math.floor(limit))) : 20;
    return (await this.read()).slice(-count);
  }

  async record(row: SendObservation): Promise<void> {
    const operation = this.pending.then(async () => {
      const safe = project({ ...row, extensionVersion });
      if (!safe) return;
      const rows = await this.read();
      await this.ctx.storage.set(OBSERVATIONS_KEY, [...rows, safe].slice(-MAX_OBSERVATIONS));
    });
    this.pending = operation.catch(() => {
      // Do not log the underlying storage error; it may contain private paths/data.
      try { this.ctx.logger.warn('wechat observation storage unavailable'); } catch { /* best effort */ }
    });
    await this.pending;
  }
}
