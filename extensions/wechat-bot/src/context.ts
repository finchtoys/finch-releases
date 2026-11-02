import { createHash, randomUUID } from 'node:crypto';
import type * as finch from 'finch';
import { CTOKEN_PREFIX, SESSION_MAP_PREFIX, TURN_MAP_PREFIX } from './types';
import type { AccountStore } from './accounts';

const META_PREFIX = 'context-meta:';
const SECRET_PREFIX = 'wechat.context.';

export interface ContextIdentity {
  botId: string;
  botToken: string;
}

export interface MessageContext {
  token: string;
  receivedAt: number;
  /** Local capture revision, not a token fingerprint or server expiry timestamp. */
  revision?: string;
}

/** 绑定 bot 和本次登录凭证；同一账号重新登录也不能回退到旧上下文。 */
export function contextScope(identity: ContextIdentity): string {
  return createHash('sha256').update(JSON.stringify([identity.botId, identity.botToken])).digest('hex');
}

interface ContextMetadata {
  receivedAt: number;
  revision?: string;
  /** 记录该上下文属于哪次登录，退出/重新登录时按账号清理。 */
  scope?: string;
  pending?: boolean;
}

/** token 仅进入安全存储，普通 KV 只保存接收时间，不自行猜测服务端 TTL。 */
export class ContextStore {
  private records = new Map<string, Promise<void>>();

  private async withRecord<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.records.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.then(() => {}, () => {});
    this.records.set(id, tail);
    void tail.then(() => { if (this.records.get(id) === tail) this.records.delete(id); });
    return current;
  }

  constructor(
    private ctx: finch.MiniToolContext,
    private accounts: AccountStore,
  ) {}

  private id(peerId: string, identity: ContextIdentity): string {
    return createHash('sha256').update(JSON.stringify([contextScope(identity), peerId])).digest('hex');
  }

  async isCurrent(identity: ContextIdentity): Promise<boolean> {
    return this.accounts.matches(identity);
  }

  async get(peerId: string, identity: ContextIdentity): Promise<MessageContext | undefined> {
    const id = this.id(peerId, identity);
    return this.withRecord(id, async () => {
      const metadata = await this.ctx.storage.get<ContextMetadata>(`${META_PREFIX}${id}`);
      if (!metadata || metadata.pending) return undefined;
      const token = await this.ctx.secrets.get(`${SECRET_PREFIX}${id}`);
      if (!token?.trim()) return undefined;
      return { token, receivedAt: metadata.receivedAt, revision: metadata.revision };
    });
  }

  /** 使用收到消息的那次轮询身份，拒绝退出/重新登录后迟到的旧响应。 */
  async capture(peerId: string, token: string | undefined, identity: ContextIdentity): Promise<void> {
    if (!token?.trim()) return;
    const receivedAt = Date.now();
    const id = this.id(peerId, identity);
    await this.withRecord(id, async () => {
      if (!(await this.isCurrent(identity))) return;
      // Mark incomplete writes: never pair a new token with old metadata, and keep the key enumerable for logout cleanup.
      const metadata: ContextMetadata = { receivedAt, revision: randomUUID(), scope: contextScope(identity) };
      await this.ctx.storage.set(`${META_PREFIX}${id}`, { ...metadata, pending: true });
      await this.ctx.secrets.set(`${SECRET_PREFIX}${id}`, token);
      await this.ctx.storage.set(`${META_PREFIX}${id}`, metadata);
      // 如果保存过程中发生账号切换，旧响应不能重新建立发送上下文。
      if (!(await this.isCurrent(identity))) {
        await this.ctx.secrets.delete(`${SECRET_PREFIX}${id}`);
        await this.ctx.storage.delete(`${META_PREFIX}${id}`);
      }
    });
  }

  /** 旧缓存没有登录身份，不能安全迁移；仅删 token，保留历史会话与任务。 */
  async discardLegacy(): Promise<void> {
    for (const key of await this.ctx.storage.keys()) {
      if (key.startsWith(CTOKEN_PREFIX)) {
        await this.ctx.storage.delete(key);
      } else if (key.startsWith(SESSION_MAP_PREFIX) || key.startsWith(TURN_MAP_PREFIX)) {
        const record = await this.ctx.storage.get<Record<string, unknown>>(key);
        if (record && typeof record === 'object' && 'contextToken' in record) {
          const { contextToken: _discarded, ...rest } = record;
          await this.ctx.storage.set(key, rest);
        }
      }
    }
  }

  private async deleteRecord(key: string): Promise<void> {
    const id = key.slice(META_PREFIX.length);
    await this.withRecord(id, async () => {
      await this.ctx.secrets.delete(`${SECRET_PREFIX}${id}`);
      await this.ctx.storage.delete(key);
    });
  }

  /** 清空所有账号的发送上下文（扩展级重置）。 */
  async clear(): Promise<void> {
    for (const key of await this.ctx.storage.keys()) {
      if (!key.startsWith(META_PREFIX)) continue;
      await this.deleteRecord(key);
    }
    await this.discardLegacy();
  }

  /** 迁移：旧上下文没有 scope，按迁移后的登录凭证补上，保证按账号清理可用。 */
  async adoptLegacyScope(identity: ContextIdentity): Promise<void> {
    const scope = contextScope(identity);
    for (const key of await this.ctx.storage.keys()) {
      if (!key.startsWith(META_PREFIX)) continue;
      const metadata = await this.ctx.storage.get<ContextMetadata>(key);
      if (metadata && !metadata.scope) await this.ctx.storage.set(key, { ...metadata, scope });
    }
  }

  /** 只清空某个账号登录下的发送上下文，不影响其他账号。 */
  async clearScope(identity: ContextIdentity): Promise<void> {
    const scope = contextScope(identity);
    for (const key of await this.ctx.storage.keys()) {
      if (!key.startsWith(META_PREFIX)) continue;
      const metadata = await this.ctx.storage.get<ContextMetadata>(key);
      if (metadata?.scope === scope) await this.deleteRecord(key);
    }
  }
}
