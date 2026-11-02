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

/** 是否持有完整登录凭证；登出后的条目仍保留在列表里。 */
export const isAccountLoggedIn = (
  account: Pick<WeChatAccount, 'botToken' | 'baseUrl' | 'botId'>,
): account is Pick<WeChatAccount, 'botToken' | 'baseUrl' | 'botId'> & { botToken: string; baseUrl: string; botId: string } =>
  Boolean(account.botToken && account.baseUrl && account.botId);

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

  /** 默认发送身份：优先已登录的主账号，否则任意已登录账号。 */
  async defaultSender(): Promise<WeChatAccount | undefined> {
    const accounts = await this.list();
    return accounts.find((account) => account.role === 'primary' && isAccountLoggedIn(account))
      ?? accounts.find(isAccountLoggedIn);
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

  /** 清空账号登录凭证但保留条目（含 botId/归属，便于重新登录时原地认领）。 */
  async clearCredentials(id: string): Promise<WeChatAccount | undefined> {
    const account = await this.get(id);
    if (!account) return undefined;
    const loggedOut: WeChatAccount = {
      id: account.id, label: account.label, role: account.role, createdAt: account.createdAt,
      ...(account.ownerUserId ? { ownerUserId: account.ownerUserId } : {}),
      ...(account.botId ? { botId: account.botId } : {}),
    };
    await this.save(loggedOut);
    await this.ctx.storage.delete(cursorKey(id));
    await this.ctx.storage.delete(activeSessionKey(id));
    return loggedOut;
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

  /** 保证恰好一个主账号：优先在已登录账号里选，登出后自动顺延给下一个已登录账号。 */
  async ensurePrimary(): Promise<boolean> {
    const accounts = await this.list();
    if (!accounts.length) return false;
    const loggedIn = accounts.filter(isAccountLoggedIn);
    const pool = loggedIn.length ? loggedIn : accounts;
    const primaries = accounts.filter((account) => account.role === 'primary');
    // 当前主账号仍在候选池里就不动，否则顺延给候选池第一个。
    if (primaries.length === 1 && pool.some((account) => account.id === primaries[0].id)) return false;
    const next = pool[0];
    let changed = false;
    for (const account of accounts) {
      const role = account.id === next.id ? 'primary' : 'sub';
      if (account.role === role) continue;
      account.role = role;
      await this.save(account);
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
