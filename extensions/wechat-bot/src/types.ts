import type * as finch from 'finch';

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

export const CONTAINER_ID = 'wechat';
/** 微信图标包：使用完整 pack 引用，避免菜单图标解析回退。 */
export const wechatIcon = (id: string): string => `ext:wechat/${id}`;

/** iLink 二维码请求固定入口（微信官方）。 */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_BOT_TYPE = '3';

// iLink 协议头 / base_info（对齐 @tencent-weixin/openclaw-weixin）。
export const ILINK_APP_ID = 'bot';
// iLink-App-ClientVersion: uint32 = major<<16 | minor<<8 | patch，取 openclaw 2.4.6 → 132102。
export const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
// base_info.channel_version：随 openclaw 兼容版本，避免被判过旧。
export const ILINK_CHANNEL_VERSION = '2.4.6';

/** 微信 CDN 基座地址（媒体上传/下载）。 */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
/** 上传媒体类型：1=图片 2=视频 3=文件 4=语音。 */
export const UPLOAD_MEDIA_IMAGE = 1;
export const UPLOAD_MEDIA_VIDEO = 2;
export const UPLOAD_MEDIA_FILE = 3;

// 多账号存储键：每个账号一条 account:<id> 记录，索引保存账号 id 顺序。
export const ACCOUNT_INDEX_KEY = 'accounts:index';
export const ACCOUNT_PREFIX = 'account:';
export const ACCOUNT_CURSOR_PREFIX = 'cursor:';
export const ACCOUNT_ACTIVE_SESSION_PREFIX = 'active-session:';

// 旧单账号存储键：仅用于迁移，迁移后删除。
export const KEY_TOKEN = 'auth:botToken';
export const KEY_BASE_URL = 'auth:baseUrl';
export const KEY_BOT_ID = 'auth:botId';
export const KEY_OWNER_USER = 'auth:ownerUserId';
export const KEY_CURSOR = 'msg:getUpdatesBuf';
export const KEY_ACTIVE_SESSION = 'wechat:activeSessionId';
export const LEGACY_PEER_MAP_PREFIX = 'peer:';
export const SESSION_MAP_PREFIX = 'session:';
export const TURN_MAP_PREFIX = 'turn:';
export const CTOKEN_PREFIX = 'ctoken:';
export const TASK_PREFIX = 'task:';
export const TASK_INDEX_KEY = 'tasks:index';
export const WAIT_PREFIX = 'wait:';
export const WAIT_INDEX_PREFIX = 'wait-index:';

export const RECONNECT_BACKOFF_MS = [1_000, 3_000, 6_000, 10_000, 15_000];
export const QR_POLL_INTERVAL_MS = 1_500;

// ─────────────────────────────────────────────────────────────────────────────
// 账号模型
// ─────────────────────────────────────────────────────────────────────────────

/** 账号角色：主账号显示在 Finch 上并作为默认发送身份，其余为子账号。 */
export type AccountRole = 'primary' | 'sub';

/** 一个微信账号记录；登录后带凭证，登出后只保留条目以便重新登录。 */
export interface WeChatAccount {
  /** 本地稳定 id，用作存储作用域；与 iLink 返回的 bot id 解耦。 */
  id: string;
  /** 以下三项为登录凭证；登出后清空（条目保留）。 */
  botId?: string;
  botToken?: string;
  baseUrl?: string;
  /** 完成扫码登录的微信用户 id（消息归属校验用）。 */
  ownerUserId?: string;
  /** 展示用标签，可读，不用于路由。 */
  label: string;
  role: AccountRole;
  createdAt: number;
}

/** 供设置菜单显示的账号快照，不含凭证。 */
export interface AccountView {
  id: string;
  label: string;
  role: AccountRole;
  ownerUserId?: string;
  connected: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// iLink 协议类型
// ─────────────────────────────────────────────────────────────────────────────

export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export type QRStatus =
  | 'wait' | 'scaned' | 'confirmed' | 'expired'
  | 'scaned_but_redirect' | 'need_verifycode'
  | 'verify_code_blocked' | 'binded_redirect';

export type LoginPhase = 'idle' | 'waiting' | 'scanned' | 'verify' | 'expired' | 'failed';

export interface StatusResponse {
  status: QRStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface WeixinCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string; // base64(raw16) 或 base64(hex32)
  full_url?: string;
  /** 加密类型: 0=只加密fileid, 1=打包缩略图/中图等信息 */
  encrypt_type?: number;
}

export interface WeixinImageItem {
  media?: WeixinCdnMedia;
  aeskey?: string;
  mid_size?: number;
}

export interface WeixinVoiceItem {
  media?: WeixinCdnMedia;
  text?: string;
}

export interface WeixinFileItem {
  media?: WeixinCdnMedia;
  file_name?: string;
  len?: string;
}

export interface WeixinVideoItem {
  media?: WeixinCdnMedia;
  video_size?: number;
}

// MessageItemType: 1=文本 2=图片 3=语音 4=文件 5=视频
export interface WeixinMessageItem {
  type: number;
  text_item?: { text: string };
  image_item?: WeixinImageItem;
  voice_item?: WeixinVoiceItem;
  file_item?: WeixinFileItem;
  video_item?: WeixinVideoItem;
}

export interface WeixinInboundMessage {
  from_user_id: string;
  from_nickname?: string;
  context_token?: string;
  item_list?: WeixinMessageItem[];
}

export interface GetUpdatesResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinInboundMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResponse {
  /** Official send client permits omission on successful JSON responses. */
  ret?: number;
  /** Optional server identifier, not a device delivery receipt. */
  message_id?: string | number;
  errcode?: number;
  errmsg?: string;
}

export interface GetUploadUrlResponse {
  upload_param?: string;
  upload_full_url?: string;
  thumb_upload_param?: string;
}

export interface UploadedMediaInfo {
  downloadEncryptedQueryParam: string;
  aeskeyHex: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

/** 一个待人工处理的中继卡片（权限/问答/表单）。 */
export interface PendingWaitRecord {
  code: string;
  peerId: string;
  /** 收到该消息的账号 id，回复也必须经同一账号发出。 */
  accountId: string;
  sessionId: string;
  requestId: string;
  kind: 'permission' | 'question' | 'form';
  questionHeaders?: string[];
  formFields?: { key: string; type: string }[];
}

/** Bot 派发到某个 Space 的任务会话记录。 */
export interface TaskRecord {
  sessionId: string;
  spaceId: string;
  title?: string;
  notifyPeerId?: string;
  /** 结果通知走哪个账号发出；缺省回退到主账号。 */
  notifyAccountId?: string;
  status: 'running' | 'waiting' | 'completed' | 'failed';
  lastTurnId?: string;
  lastOutput?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** 会话/轮次到微信来源的映射，用于把结果回复到正确的账号与联系人。 */
export interface PeerTarget {
  peerId: string;
  accountId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 共享运行时状态
// ─────────────────────────────────────────────────────────────────────────────

/** 单个账号的消息轮询状态。 */
export interface AccountLoopState {
  running: boolean;
  stop: boolean;
  backoffIndex: number;
  lastError: string | undefined;
}

/** 可变状态对象，由 activate() 创建并传给各模块。 */
export interface BotState {
  loginRunning: boolean;
  loginCancel: boolean;
  loginAttempt: number;
  loginPhase: LoginPhase;
  activeQr: QRCodeResponse | undefined;
  activeLoginDialog: finch.ModalDialogHandle | undefined;
  /** 当前扫码登录是为哪个账号（undefined = 新增子账号）。 */
  loginTargetAccountId: string | undefined;
  /** 每个账号独立的消息轮询状态。 */
  loops: Map<string, AccountLoopState>;
  deliveredCount: number;
  lastError: string | undefined;
  settingsMenu: (finch.Disposable & { notifyUpdate(): void }) | undefined;
}

export function createBotState(): BotState {
  return {
    loginRunning: false,
    loginCancel: false,
    loginAttempt: 0,
    loginPhase: 'idle',
    activeQr: undefined,
    activeLoginDialog: undefined,
    loginTargetAccountId: undefined,
    loops: new Map(),
    deliveredCount: 0,
    lastError: undefined,
    settingsMenu: undefined,
  };
}
