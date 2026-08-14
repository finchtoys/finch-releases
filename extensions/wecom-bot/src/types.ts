import type * as finch from 'finch';

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

export const CONTAINER_ID = 'wecom';
/** 企微图标包：使用完整 pack 引用，避免菜单图标解析回退。 */
export const wecomIcon = (id: string): string => `ext:wecom/${id}`;

/** 单聊 / 群聊的会话类型（企微协议值）。 */
export type WeComChatType = 'single' | 'group';

// 存储键（对齐 wechat-bot 的前缀风格，独立命名空间避免冲突）
export const KEY_ACTIVE_SESSION = 'wecom:activeSessionId';
export const SESSION_MAP_PREFIX = 'wecom:session:';
export const TURN_MAP_PREFIX = 'wecom:turn:';
export const TASK_PREFIX = 'wecom:task:';
export const TASK_INDEX_KEY = 'wecom:tasks:index';
export const WAIT_PREFIX = 'wecom:wait:';
export const WAIT_INDEX_PREFIX = 'wecom:wait-index:';
export const MSG_DEDUP_PREFIX = 'wecom:msg:';

/** 等待卡片 #code 短码长度（字节）。 */
export const WAIT_CODE_BYTES = 3;
/** 入站 msgid 去重窗口（毫秒），企微可能因网络原因重复回调。 */
export const MSG_DEDUP_WINDOW_MS = 10 * 60 * 1000;

/** 连接重试退避（与 wechat-bot 对齐）。 */
export const RECONNECT_BACKOFF_MS = [1_000, 3_000, 6_000, 10_000, 15_000];

// ─────────────────────────────────────────────────────────────────────────────
// 消息 / 会话映射类型
// ─────────────────────────────────────────────────────────────────────────────

/** 会话映射：一个企微 peer（单聊 userid 或群聊 chatid）对应一个 Finch Session。 */
export interface WeComPeerRecord {
  /** 单聊：发送者 userid；群聊：chatid。 */
  peerKey: string;
  /** 会话类型。 */
  kind: WeComChatType;
  /** 群聊时区分发言人；单聊时等于 peerKey。 */
  userId: string;
}

/** 群聊入站消息需要携带发言人来区隔上下文。 */
export interface WeComInbound {
  /** 企微消息唯一 id（排重）。 */
  msgid: string;
  /** 会话类型。 */
  chattype: WeComChatType;
  /** 群聊 id（仅群聊）。 */
  chatid?: string;
  /** 发送者 userid。 */
  userid: string;
  /** 文本内容（text / mixed.text / voice 转文本拼接）。 */
  text: string;
  /** 媒体附件（图片/文件/视频，已下载解密为 base64）。 */
  attachments: finch.SessionMessageAttachment[];
  /** 原始消息体（用于 reply 透传 req_id 等）。 */
  raw: unknown;
}

/** 等待状态中继记录（对齐 wechat-bot 的 PendingWaitRecord）。 */
export interface PendingWaitRecord {
  code: string;
  peerKey: string;
  sessionId: string;
  requestId: string;
  kind: 'permission' | 'question' | 'form';
  questionHeaders?: string[];
  formFields?: { key: string; type: string }[];
}

/** 派发到 Space 的任务会话记录（对齐 wechat-bot 的 TaskRecord）。 */
export interface TaskRecord {
  sessionId: string;
  spaceId: string;
  title?: string;
  notifyPeerKey?: string;
  notifyKind?: WeComChatType;
  status: 'running' | 'waiting' | 'completed' | 'failed';
  lastTurnId?: string;
  lastOutput?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** 共享运行时状态。 */
export interface BotState {
  connecting: boolean;
  connected: boolean;
  lastError: string | undefined;
  deliveredCount: number;
  settingsMenu: (finch.Disposable & { notifyUpdate(): void }) | undefined;
}

export function createBotState(): BotState {
  return {
    connecting: false,
    connected: false,
    lastError: undefined,
    deliveredCount: 0,
    settingsMenu: undefined,
  };
}
