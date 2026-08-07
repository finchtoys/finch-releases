import type * as finch from 'finch';
import {
  ILINK_APP_ID, ILINK_APP_CLIENT_VERSION, ILINK_CHANNEL_VERSION,
  KEY_TOKEN, KEY_BASE_URL,
} from './types';
import { randomWechatUin } from './utils';

export type BotConfig = { botAgent: string; autoReply: boolean };

/**
 * iLink HTTP 客户端：封装了鉴权 header、base_info 和通用 POST/GET。
 * 所有 iLink API 调用通过此对象进行。
 */
export class IlinkClient {
  constructor(
    private ctx: finch.MiniToolContext,
    private readConfig: () => BotConfig,
  ) {}

  async getToken(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(KEY_TOKEN);
  }

  async getBaseUrl(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(KEY_BASE_URL);
  }

  async isLoggedIn(): Promise<boolean> {
    return Boolean(await this.getToken());
  }

  /** 每个消息类请求都要带的 base_info（bot_agent 在此，不是 header）。 */
  buildBaseInfo() {
    return {
      channel_version: ILINK_CHANNEL_VERSION,
      bot_agent: this.readConfig().botAgent,
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
    token?: string, timeoutMs = 45_000,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
