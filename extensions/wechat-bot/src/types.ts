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

// 存储键
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
  ret: number;
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

/** Bot 派发到某个 Space 的任务会话记录。 */
export interface PendingWaitRecord {
  code: string;
  peerId: string;
  sessionId: string;
  requestId: string;
  kind: 'permission' | 'question' | 'form';
  questionHeaders?: string[];
  formFields?: { key: string; type: string }[];
}

export interface TaskRecord {
  sessionId: string;
  spaceId: string;
  title?: string;
  notifyPeerId?: string;
  status: 'running' | 'waiting' | 'completed' | 'failed';
  lastTurnId?: string;
  lastOutput?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 共享运行时状态
// ─────────────────────────────────────────────────────────────────────────────

/** 可变状态对象，由 activate() 创建并传给各模块。 */
export interface BotState {
  loginRunning: boolean;
  loginCancel: boolean;
  loginAttempt: number;
  loginPhase: LoginPhase;
  activeQr: QRCodeResponse | undefined;
  activeLoginDialog: finch.ModalDialogHandle | undefined;
  messageRunning: boolean;
  stopMessageLoop: boolean;
  backoffIndex: number;
  lastError: string | undefined;
  deliveredCount: number;
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
    messageRunning: false,
    stopMessageLoop: false,
    backoffIndex: 0,
    lastError: undefined,
    deliveredCount: 0,
    settingsMenu: undefined,
  };
}
