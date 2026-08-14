// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** 会话容器 id。 */
export const CONTAINER_ID = 'wecom';

/** 凭证在 Finch 系统安全存储（ctx.secrets）中的键。 */
export const BOT_ID_SECRET = 'wecom.botId';
export const BOT_SECRET_SECRET = 'wecom.secret';

// 存储键前缀
export const SESSION_PREFIX = 'session:';          // session:<base64url(peerKey)> → sessionId
export const PEER_PREFIX = 'peer:';                // peer:<sessionId> → WeComPeer；peer:known:<base64url(peerKey)> → WeComPeer
export const TURN_PREFIX = 'turn:';                // turn:<turnId> → { peer, streamId }（进程重启后回退为主动推送）
export const SEEN_INDEX_KEY = 'seen:index';        // 去重索引（FIFO）
export const SEEN_PREFIX = 'seen:';                // seen:<base64url(msgid)> → true
export const MAX_SEEN_MESSAGES = 500;

// 提示文案
export const PROCESSING_TEXT = '正在处理，请稍候…';
export const BUSY_TEXT = '当前消息较多，请稍后再试。';
export const WELCOME_TEXT = '你好，我是 Finch 企业微信助手。直接发送消息即可开始。';

/** 企微单条回复内容上限（字节）；超过则截断。 */
export const MAX_REPLY_BYTES = 20_000;

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/** 一个企微对端：单聊成员或群聊。 */
export interface WeComPeer {
  /** 规范 key：`single:<userid>` 或 `group:<chatid>`。 */
  key: string;
  /** 会话目标：单聊为 userid，群聊为 chatid。 */
  chatId: string;
  chatType: 'single' | 'group';
  /** 最近一次消息发送者 userid。 */
  userId: string;
}

/** 桥接运行时状态（设置菜单展示用）。 */
export interface WeComRuntimeState {
  client: unknown;
  connecting: boolean;
  authenticated: boolean;
  lastError: string | undefined;
  receivedCount: number;
  menu: (DisposableLike & { notifyUpdate(): void }) | undefined;
}

export interface DisposableLike {
  dispose(): void;
}
