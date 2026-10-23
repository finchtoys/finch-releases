import type * as finch from 'finch';
import {
  ILINK_APP_ID, ILINK_APP_CLIENT_VERSION, ILINK_CHANNEL_VERSION,
  KEY_TOKEN, KEY_BASE_URL, KEY_BOT_ID,
} from './types';
import { randomWechatUin } from './utils';

export type BotConfig = { autoReply: boolean };

export interface IlinkAccount {
  baseUrl: string;
  botId: string;
  botToken: string;
}

/**
 * iLink HTTP 客户端：封装了鉴权 header、base_info 和通用 POST/GET。
 * 所有 iLink API 调用通过此对象进行。
 */
export class IlinkClient {
  constructor(
    private ctx: finch.MiniToolContext,
    private appUserAgent: string,
  ) {}

  async getToken(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(KEY_TOKEN);
  }

  async getBaseUrl(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(KEY_BASE_URL);
  }

  async getAccount(): Promise<IlinkAccount | undefined> {
    const [baseUrl, botId, botToken] = await Promise.all([
      this.getBaseUrl(),
      this.ctx.storage.get<string>(KEY_BOT_ID),
      this.getToken(),
    ]);
    if (!baseUrl || !botId || !botToken) return undefined;
    return { baseUrl, botId, botToken };
  }

  async isLoggedIn(): Promise<boolean> {
    return Boolean(await this.getToken());
  }

  /** 每个消息类请求都要带的 base_info（bot_agent 在此，不是 header）。 */
  buildBaseInfo() {
    return {
      channel_version: ILINK_CHANNEL_VERSION,
      bot_agent: this.appUserAgent,
    };
  }

  commonHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
    };
    if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
    return headers;
  }

  async post<T>(
    baseUrl: string, endpoint: string, body: unknown,
    token?: string, timeoutMs = 45_000, signal?: AbortSignal,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const abort = () => ctrl.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) ctrl.abort();
    try {
      const res = await fetch(`${baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: this.commonHeaders(token),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async get<T>(
    baseUrl: string, endpoint: string,
    token?: string, timeoutMs = 35_000,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/${endpoint}`, {
        method: 'GET',
        headers: {
          'iLink-App-Id': ILINK_APP_ID,
          'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
