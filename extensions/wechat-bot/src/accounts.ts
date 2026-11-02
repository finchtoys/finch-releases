import type * as finch from 'finch';
import {
  ACCOUNT_INDEX_KEY, ACCOUNT_PREFIX, ACCOUNT_CURSOR_PREFIX, ACCOUNT_ACTIVE_SESSION_PREFIX,
  KEY_TOKEN, KEY_BASE_URL, KEY_BOT_ID, KEY_OWNER_USER, KEY_CURSOR, KEY_ACTIVE_SESSION,
  SESSION_MAP_PREFIX, TURN_MAP_PREFIX,
  type WeChatAccount,
} from './types';
import { randomHex } from './utils';

export const accountKey = (id: string): string => `${ACCOUNT_PREFIX}${id}`;
export const cursorKey = (id: string): string => `${ACCOUNT_CURSOR_PREFIX}${id}`;
export const activeSessionKey = (id: string): string => `${ACCOUNT_ACTIVE_SESSION_PREFIX}${id}`;

/**
 * 账号注册表：一个主账号 + 多个子账号。凭证（botToken）只存本地 KV，
 * 不进入会话上下文或日志；账号顺序即索引顺序，用作主账号顺延的优先级。
 */
export class AccountStore {
  constructor(private ctx: finch.MiniToolContext) {}

  private async readIndex(): Promise<string[]> {
    const index = await this.ctx.storage.get<string[]>(ACCOUNT_INDEX_KEY);
    return Array.isArray(index) ? index : [];
  }

  async list(): Promise<WeChatAccount[]> {
    const out: WeChatAccount[] = [];
    for (const id of await this.readIndex()) {
      const account = await this.get(id);
      if (account) out.push(account);
    }
    return out;
  }

  async get(id: string): Promise<WeChatAccount | undefined> {
    const account = await this.ctx.storage.get<WeChatAccount>(accountKey(id));
    if (!account || typeof account !== 'object' || typeof account.id !== 'string') return undefined;
    return account;
  }

  async hasAny(): Promise<boolean> {
    return (await this.readIndex()).length > 0;
  }

  async primary(): Promise<WeChatAccount | undefined> {
    const accounts = await this.list();
    return accounts.find((account) => account.role === 'primary') ?? accounts[0];
  }

  async save(account: WeChatAccount): Promise<void> {
    await this.ctx.storage.set(accountKey(account.id), account);
    const index = await this.readIndex();
    if (!index.includes(account.id)) {
      index.push(account.id);
      await this.ctx.storage.set(ACCOUNT_INDEX_KEY, index);
    }
  }

  /** 这组凭证是否仍是当前有效登录：用于拒绝退出/重新登录后迟到的响应。 */
  async matches(identity: { botId: string; botToken: string }): Promise<boolean> {
    const accounts = await this.list();
    return accounts.some((a) => a.botId === identity.botId && a.botToken === identity.botToken);
  }

  /** 删除账号及其轮询游标、当前会话指针；保留历史会话与任务。 */
  async remove(id: string): Promise<WeChatAccount | undefined> {
    const account = await this.get(id);
    const index = await this.readIndex();
    await this.ctx.storage.set(ACCOUNT_INDEX_KEY, index.filter((entry) => entry !== id));
    await this.ctx.storage.delete(accountKey(id));
    await this.ctx.storage.delete(cursorKey(id));
    await this.ctx.storage.delete(activeSessionKey(id));
    return account;
  }

  /** 可读标签：截取微信用户 id 尾段，避免展示完整凭证片段。 */
  static labelFor(ownerUserId: string | undefined, fallback: string): string {
    if (ownerUserId) return `微信 ${ownerUserId.length > 6 ? ownerUserId.slice(-6) : ownerUserId}`;
    return `微信账号 ${fallback}`;
  }

  /** 保证恰好一个主账号：缺失时按索引顺序提升第一个，重复时保留最靠前的。 */
  async ensurePrimary(): Promise<boolean> {
    const accounts = await this.list();
    if (!accounts.length) return false;
    const primaries = accounts.filter((account) => account.role === 'primary');
    if (primaries.length === 1) return false;
    let changed = false;
    if (!primaries.length) {
      accounts[0].role = 'primary';
      await this.save(accounts[0]);
      changed = true;
    }
    for (const extra of primaries.slice(1)) {
      extra.role = 'sub';
      await this.save(extra);
      changed = true;
    }
    return changed;
  }

  /** 把旧单账号数据迁移成一条主账号记录；仅在尚未注册任何账号时执行一次。 */
  async migrateLegacy(): Promise<WeChatAccount | undefined> {
    if ((await this.readIndex()).length) return undefined;
    const [botToken, baseUrl, botId, ownerUserId] = await Promise.all([
      this.ctx.storage.get<string>(KEY_TOKEN),
      this.ctx.storage.get<string>(KEY_BASE_URL),
      this.ctx.storage.get<string>(KEY_BOT_ID),
      this.ctx.storage.get<string>(KEY_OWNER_USER),
    ]);
    if (!botToken || !baseUrl || !botId) return undefined;

    const account: WeChatAccount = {
      id: `acc_${randomHex(6)}`, botId, botToken, baseUrl,
      ...(ownerUserId ? { ownerUserId } : {}),
      label: AccountStore.labelFor(ownerUserId, '1'),
      role: 'primary', createdAt: Date.now(),
    };
    await this.save(account);

    const cursor = await this.ctx.storage.get<string>(KEY_CURSOR);
    if (cursor !== undefined) await this.ctx.storage.set(cursorKey(account.id), cursor);
    const active = await this.ctx.storage.get<string>(KEY_ACTIVE_SESSION);
    if (active) await this.ctx.storage.set(activeSessionKey(account.id), active);

    // 旧映射没有账号归属，补上主账号，保证历史会话的结果仍能回复到微信。
    for (const key of await this.ctx.storage.keys()) {
      if (!key.startsWith(SESSION_MAP_PREFIX) && !key.startsWith(TURN_MAP_PREFIX)) continue;
      const record = await this.ctx.storage.get<Record<string, unknown>>(key);
      if (record && typeof record === 'object' && typeof record.peerId === 'string' && !record.accountId) {
        await this.ctx.storage.set(key, { ...record, accountId: account.id });
      }
    }

    for (const key of [KEY_TOKEN, KEY_BASE_URL, KEY_BOT_ID, KEY_OWNER_USER, KEY_CURSOR, KEY_ACTIVE_SESSION]) {
      await this.ctx.storage.delete(key);
    }
    return account;
  }
}
