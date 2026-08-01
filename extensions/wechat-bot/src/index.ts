import type * as finch from 'finch';
import { createDecipheriv } from 'node:crypto';
import QRCode from 'qrcode';

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINER_ID = 'wechat';
/**
 * 图标以静态 SVG 文件形式声明在 manifest 的 `contributes.icons`（见 icons/ 目录）。
 * 静态图标由主进程直接从磁盘解析，不依赖扩展是否已激活——因此侧栏容器入口图标在
 * App 启动、扩展尚未激活时也能正常显示（运行时 iconPacks 存在启动竞态，故弃用）。
 * 菜单 / 入口引用统一用完整的 `ext:<extId>/<iconId>` 形式；extId 即扩展 id。
 */
const EXT_ID = 'wechat-bot';
const wechatIcon = (id: string): string => `ext:${EXT_ID}/${id}`;

/** iLink 二维码请求固定入口（微信官方）。 */
const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_BOT_TYPE = '3';

// iLink 协议头 / base_info（对齐 @tencent-weixin/openclaw-weixin）。
const ILINK_APP_ID = 'bot';
// iLink-App-ClientVersion: uint32 = major<<16 | minor<<8 | patch，取 openclaw 2.4.6 → 132102。
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
// base_info.channel_version：随 openclaw 兼容版本，避免被判过旧。
const ILINK_CHANNEL_VERSION = '2.4.6';

// 存储键
const KEY_TOKEN = 'auth:botToken';
const KEY_BASE_URL = 'auth:baseUrl';
const KEY_BOT_ID = 'auth:botId';
const KEY_OWNER_USER = 'auth:ownerUserId';
const KEY_CURSOR = 'msg:getUpdatesBuf';
const KEY_ACTIVE_SESSION = 'wechat:activeSessionId';
const LEGACY_PEER_MAP_PREFIX = 'peer:'; // 仅用于迁移旧版 peer:<userId> 映射
const SESSION_MAP_PREFIX = 'session:'; // session:<sessionId> -> { peerId, contextToken }
const TURN_MAP_PREFIX = 'turn:'; // turn:<turnId> -> { peerId, contextToken }
const CTOKEN_PREFIX = 'ctoken:'; // ctoken:<userId> -> 该联系人最新 context_token（每条消息刷新，回复时用最新）
const TASK_PREFIX = 'task:'; // task:<sessionId> -> TaskRecord（Bot 派发到 Space 的任务会话）
const TASK_INDEX_KEY = 'tasks:index'; // string[] 已登记的任务 sessionId 列表

const RECONNECT_BACKOFF_MS = [1_000, 3_000, 6_000, 10_000, 15_000];
const QR_POLL_INTERVAL_MS = 1_500;

// ─────────────────────────────────────────────────────────────────────────────
// iLink 协议类型
// ─────────────────────────────────────────────────────────────────────────────

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string; // 二维码内容（URL 字符串）
}

type QRStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

/** Bot 派发到某个 Space 的任务会话记录。 */
interface TaskRecord {
  sessionId: string;
  spaceId: string;
  title?: string;
  /** 任务完成后要回馈状态的微信联系人 userId（可选）。 */
  notifyPeerId?: string;
  status: 'running' | 'waiting' | 'completed' | 'failed';
  lastTurnId?: string;
  lastOutput?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

interface StatusResponse {
  status: QRStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

interface WeixinTextItem {
  text: string;
}
// CDN 媒体引用：full_url 为服务端直出的完整下载地址；aes_key/aeskey 为解密密钥。
interface WeixinCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string; // base64(raw16) 或 base64(hex32)
  full_url?: string;
}
interface WeixinImageItem {
  media?: WeixinCdnMedia;
  aeskey?: string; // 16 字节 hex 字符串（优先于 media.aes_key）
}
interface WeixinVoiceItem {
  media?: WeixinCdnMedia;
  text?: string; // 服务端语音转文字内容
}
interface WeixinFileItem {
  media?: WeixinCdnMedia;
  file_name?: string;
}
interface WeixinVideoItem {
  media?: WeixinCdnMedia;
}
// MessageItemType: 1=文本 2=图片 3=语音 4=文件 5=视频
interface WeixinMessageItem {
  type: number;
  text_item?: WeixinTextItem;
  image_item?: WeixinImageItem;
  voice_item?: WeixinVoiceItem;
  file_item?: WeixinFileItem;
  video_item?: WeixinVideoItem;
}
interface WeixinInboundMessage {
  from_user_id: string;
  from_nickname?: string;
  context_token?: string;
  item_list?: WeixinMessageItem[];
}
interface GetUpdatesResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinInboundMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}
interface SendMessageResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 激活入口
// ─────────────────────────────────────────────────────────────────────────────

export async function activate(ctx: finch.MiniToolContext): Promise<void> {
  let loginRunning = false;
  let loginCancel = false;
  let loginAttempt = 0;
  let loginPhase: 'idle' | 'waiting' | 'scanned' | 'verify' | 'expired' | 'failed' = 'idle';
  let activeQr: QRCodeResponse | undefined;
  let activeLoginDialog: finch.ModalDialogHandle | undefined;
  let messageRunning = false;
  let stopMessageLoop = false;
  let backoffIndex = 0;
  let lastError: string | undefined;
  let deliveredCount = 0;
  let settingsMenu: (finch.Disposable & { notifyUpdate(): void }) | undefined;

  const toast = (
    title: string,
    description?: string,
    variant: finch.ToastVariant = 'info',
  ) => {
    void ctx.ui.showToast({ title, description, variant, position: 'TR' });
  };

  // ── 配置 ────────────────────────────────────────────────────────────────────

  const readConfig = () => ({
    botAgent: (ctx.settings.get<string>('botAgent') ?? 'Finch/0.1').trim() || 'Finch/0.1',
    autoReply: ctx.settings.get<boolean>('autoReply') ?? true,
  });

  const randomWechatUin = () =>
    Buffer.from(String(Math.floor(Math.random() * 0xffffffff)), 'utf8').toString('base64');

  // n 字节的随机十六进制串，用于生成唯一 client_id。
  const randomHex = (bytes: number) =>
    Array.from({ length: bytes }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');

  const commonHeaders = (token?: string): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
    };
    if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
    return headers;
  };

  // 每个消息类请求都要带的 base_info（bot_agent 在此，不是 header）。
  const buildBaseInfo = () => ({
    channel_version: ILINK_CHANNEL_VERSION,
    bot_agent: readConfig().botAgent,
  });

  const isLoggedIn = async () => Boolean(await ctx.storage.get<string>(KEY_TOKEN));

  // ── 通用请求 ────────────────────────────────────────────────────────────────

  const post = async <T>(baseUrl: string, endpoint: string, body: unknown, token?: string, timeoutMs = 45_000): Promise<T> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: commonHeaders(token),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  };

  const get = async <T>(baseUrl: string, endpoint: string, token?: string, timeoutMs = 35_000): Promise<T> => {
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
  };

  // ── 媒体下载解密 ─────────────────────────────────────────────────────────────
  //
  // 微信图片/文件/视频通过 CDN 加密下发，服务端在 media.full_url 给出完整下载地址，
  // 内容用 AES-128-ECB 加密，密钥在 media.aes_key（图片也可能在 image_item.aeskey）。

  // aes_key 有两种编码：base64(raw 16 字节) 或 base64(hex 32 字符)。
  const parseAesKey = (aesKeyBase64: string): Buffer => {
    const decoded = Buffer.from(aesKeyBase64, 'base64');
    if (decoded.length === 16) return decoded;
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
      return Buffer.from(decoded.toString('ascii'), 'hex');
    }
    throw new Error(`Invalid aes_key: decoded to ${decoded.length} bytes`);
  };

  const decryptAesEcb = (ciphertext: Buffer, key: Buffer): Buffer => {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  };

  // 下载并（按需）解密一个 CDN 媒体，返回明文 Buffer。
  const downloadMedia = async (media: WeixinCdnMedia, aesKeyOverrideHex?: string): Promise<Buffer> => {
    if (!media.full_url) throw new Error('Missing full_url for media download');
    const res = await fetch(media.full_url);
    if (!res.ok) throw new Error(`CDN download failed with HTTP ${res.status}`);
    const encrypted = Buffer.from(await res.arrayBuffer());
    // 图片优先用 image_item.aeskey（hex），否则用 media.aes_key。
    const keyB64 = aesKeyOverrideHex
      ? Buffer.from(aesKeyOverrideHex, 'hex').toString('base64')
      : media.aes_key;
    if (!keyB64) return encrypted; // 无密钥即明文
    return decryptAesEcb(encrypted, parseAesKey(keyB64));
  };

  // 从文件名猜 MIME。
  const guessMime = (name: string): string => {
    const ext = name.toLowerCase().split('.').pop() ?? '';
    const map: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
      pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
      doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
    };
    return map[ext] ?? 'application/octet-stream';
  };

  const attachmentKindFor = (mime: string): finch.SessionMessageAttachmentKind =>
    mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : mime.startsWith('text/') ? 'text' : 'file';

  // ── 输入状态 (typing) ────────────────────────────────────────────────────────
  //
  // 模型处理期间给微信发 typing。需先 getconfig 拿 typing_ticket，再 sendtyping。
  // typing 状态需每 5s 保活；per-peer 记正在运行的 turn 数，归零才真正取消。
  const typingState = new Map<string, { ticket: string; timer: ReturnType<typeof setInterval>; runningTurns: number }>();
  const ticketCache = new Map<string, string>(); // peerId -> typing_ticket

  const fetchTypingTicket = async (peerId: string, contextToken?: string): Promise<string | undefined> => {
    if (ticketCache.has(peerId)) return ticketCache.get(peerId);
    const baseUrl = await ctx.storage.get<string>(KEY_BASE_URL);
    const token = await ctx.storage.get<string>(KEY_TOKEN);
    if (!baseUrl || !token) return undefined;
    try {
      const resp = await post<{ ret?: number; typing_ticket?: string }>(
        baseUrl, 'ilink/bot/getconfig',
        { ilink_user_id: peerId, context_token: contextToken, base_info: buildBaseInfo() }, token,
      );
      if (resp.typing_ticket) {
        ticketCache.set(peerId, resp.typing_ticket);
        return resp.typing_ticket;
      }
    } catch (error) {
      ctx.logger.debug('getConfig failed (ignored)', error);
    }
    return undefined;
  };

  const sendTyping = async (peerId: string, ticket: string, status: 1 | 2) => {
    const baseUrl = await ctx.storage.get<string>(KEY_BASE_URL);
    const token = await ctx.storage.get<string>(KEY_TOKEN);
    if (!baseUrl || !token) return;
    await post(baseUrl, 'ilink/bot/sendtyping',
      { ilink_user_id: peerId, typing_ticket: ticket, status, base_info: buildBaseInfo() }, token,
    ).catch((error) => ctx.logger.debug('sendTyping failed (ignored)', error));
  };

  const startTyping = async (peerId: string, contextToken?: string) => {
    const existing = typingState.get(peerId);
    if (existing) { existing.runningTurns += 1; return; }
    const ticket = await fetchTypingTicket(peerId, contextToken);
    if (!ticket) return; // 无 ticket 时静默跳过 typing
    await sendTyping(peerId, ticket, 1);
    const timer = setInterval(() => { void sendTyping(peerId, ticket, 1); }, 5_000);
    typingState.set(peerId, { ticket, timer, runningTurns: 1 });
  };

  const stopTyping = async (peerId: string) => {
    const state = typingState.get(peerId);
    if (!state) return;
    state.runningTurns -= 1;
    if (state.runningTurns > 0) return; // 还有其它 turn 在跑，保持 typing
    clearInterval(state.timer);
    typingState.delete(peerId);
    await sendTyping(peerId, state.ticket, 2);
  };

  // ── 扫码登录 ────────────────────────────────────────────────────────────────
  //
  // iLink 返回二维码目标 URL。扩展使用 qrcode 生成 PNG，
  // The PNG is displayed in a native Modal as a data URI and never returned to the model.

  const fetchQrCode = async (): Promise<QRCodeResponse> => {
    return post<QRCodeResponse>(
      ILINK_BASE_URL,
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_BOT_TYPE)}`,
      { local_token_list: [] },
    );
  };

  const pollQrStatus = async (baseUrl: string, qrcode: string): Promise<StatusResponse> => {
    try {
      return await get<StatusResponse>(
        baseUrl,
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        undefined,
        35_000,
      );
    } catch (error) {
      // 客户端超时或网关 524：视为等待，继续轮询。
      if (error instanceof Error && error.name === 'AbortError') return { status: 'wait' };
      ctx.logger.warn('pollQrStatus network error, retrying', { error: String(error) });
      return { status: 'wait' };
    }
  };

  /**
   * 后台长轮询 get_qrcode_status。二维码是否过期完全以 iLink 返回的 `expired` 为准。
   * 每次登录拥有独立 attempt，避免旧轮询阻塞新二维码的 confirmed 状态。
   */
  const runLoginPolling = async (qr: QRCodeResponse, attempt: number) => {
    let currentBase = ILINK_BASE_URL;
    const isCurrent = () => attempt === loginAttempt && !loginCancel;

    while (isCurrent()) {
      const st = await pollQrStatus(currentBase, qr.qrcode);
      if (!isCurrent()) break;
      switch (st.status) {
        case 'wait':
          break;
        case 'scaned':
          if (loginPhase !== 'scanned') toast('二维码已扫描', '请在手机微信中确认登录。', 'info');
          loginPhase = 'scanned';
          settingsMenu?.notifyUpdate();
          break;
        case 'need_verifycode':
          loginPhase = 'verify';
          activeQr = undefined;
          toast('需要配对码', '当前弹窗无法输入配对码，请重新获取二维码。', 'warning');
          await activeLoginDialog?.close('verify');
          loginCancel = true;
          break;
        case 'scaned_but_redirect':
          if (st.redirect_host) currentBase = `https://${st.redirect_host}`;
          break;
        case 'expired':
          loginPhase = 'expired';
          activeQr = undefined;
          toast('二维码已过期', '请重新发起微信登录。', 'warning');
          await activeLoginDialog?.close('expired');
          loginCancel = true;
          break;
        case 'verify_code_blocked':
          loginPhase = 'failed';
          activeQr = undefined;
          lastError = 'Too many incorrect pairing codes. Try again later.';
          toast('登录受限', '配对码错误次数过多，请稍后重试。', 'error');
          await activeLoginDialog?.close('failed');
          loginCancel = true;
          break;
        case 'binded_redirect':
          loginPhase = 'failed';
          activeQr = undefined;
          lastError = 'This WeChat account is already connected to another client.';
          toast('无法重复连接', '这个微信账号已连接到其他客户端。', 'warning');
          await activeLoginDialog?.close('failed');
          loginCancel = true;
          break;
        case 'confirmed': {
          if (!st.bot_token || !st.ilink_bot_id) throw new Error('Login was confirmed but required credentials are missing');
          const baseUrl = (st.baseurl || currentBase).replace(/\/+$/, '');
          await ctx.storage.set(KEY_TOKEN, st.bot_token);
          await ctx.storage.set(KEY_BASE_URL, baseUrl);
          await ctx.storage.set(KEY_BOT_ID, st.ilink_bot_id);
          if (st.ilink_user_id) await ctx.storage.set(KEY_OWNER_USER, st.ilink_user_id);
          // 新扫码凭证可能使旧 getupdates cursor 与当前会话失效，即使 bot ID 不变也必须重建。
          await ctx.storage.delete(KEY_CURSOR);
          await ctx.storage.delete(KEY_ACTIVE_SESSION);
          activeQr = undefined;
          loginPhase = 'idle';
          lastError = undefined;
          toast('微信登录成功', '已开始接收消息。', 'success');
          settingsMenu?.notifyUpdate();
          await activeLoginDialog?.close('connected');
          loginCancel = true;
          startMessageLoop();
          break;
        }
      }
      if (isCurrent()) await sleep(QR_POLL_INTERVAL_MS, () => !isCurrent());
    }
  };

  const beginLoginPolling = (qr: QRCodeResponse) => {
    const attempt = ++loginAttempt;
    loginRunning = true;
    loginCancel = false;
    loginPhase = 'waiting';
    settingsMenu?.notifyUpdate();
    void runLoginPolling(qr, attempt)
      .catch((error) => {
        if (attempt !== loginAttempt) return;
        const message = error instanceof Error ? error.message : String(error);
        loginPhase = 'failed';
        activeQr = undefined;
        lastError = message;
        ctx.logger.error('login polling failed', error);
        toast('微信登录失败', '请重试或重新获取二维码。', 'error');
        void activeLoginDialog?.close('failed');
      })
      .finally(() => {
        if (attempt !== loginAttempt) return;
        loginRunning = false;
        settingsMenu?.notifyUpdate();
      });
  };

  const getLoginQr = async (): Promise<QRCodeResponse> => {
    if (activeQr && loginRunning) return activeQr;
    activeQr = await fetchQrCode();
    beginLoginPolling(activeQr);
    return activeQr;
  };

  const renderQrPng = async (content: string): Promise<string> => {
    const png = await QRCode.toBuffer(content, {
      type: 'png',
      width: 420,
      margin: 3,
      errorCorrectionLevel: 'M',
    });
    return png.toString('base64');
  };

  const showLoginDialog = async (): Promise<void> => {
    if (await isLoggedIn()) {
      toast('微信已登录', '当前正在接收消息。', 'info');
      return;
    }
    try {
      const qr = await getLoginQr();
      const pngBase64 = await renderQrPng(qr.qrcode_img_content);
      await activeLoginDialog?.close('replaced');
      const dialog = ctx.ui.showModalDialog({
        title: '登录微信',
        description: '请使用手机微信扫码，并在手机上确认登录。',
        message: `![微信登录二维码](data:image/png;base64,${pngBase64})\n\n> 请尽快扫码；实际有效期以微信端为准。`,
        actions: [{ id: 'close', label: '关闭' }],
      });
      activeLoginDialog = dialog;
      const result = await dialog;
      if (activeLoginDialog === dialog) activeLoginDialog = undefined;

      if (['connected', 'verify', 'expired', 'failed', 'replaced', 'logged-out', 'disposed'].includes(result.action)) return;
      if (await isLoggedIn()) return;

      loginCancel = true;
      activeQr = undefined;
      loginPhase = 'failed';
      lastError = 'The QR dialog was closed before login completed.';
      toast('登录未完成', '关闭弹窗前尚未完成微信确认。', 'warning');
    } catch (error) {
      activeLoginDialog = undefined;
      lastError = error instanceof Error ? error.message : String(error);
      loginPhase = 'failed';
      toast('微信登录失败', '请稍后重试。', 'error');
    }
  };

  const logout = async () => {
    loginAttempt += 1;
    loginCancel = true;
    await activeLoginDialog?.close('logged-out');
    activeLoginDialog = undefined;
    loginRunning = false;
    loginPhase = 'idle';
    activeQr = undefined;
    stopMessageLoop = true;
    messageRunning = false;
    lastError = undefined;
    await ctx.storage.delete(KEY_TOKEN);
    await ctx.storage.delete(KEY_BASE_URL);
    await ctx.storage.delete(KEY_BOT_ID);
    await ctx.storage.delete(KEY_OWNER_USER);
    await ctx.storage.delete(KEY_CURSOR);
    await ctx.storage.delete(KEY_ACTIVE_SESSION);
    toast('已退出微信', '本地登录状态已清除。', 'info');
    settingsMenu?.notifyUpdate();
  };

  // ── 唯一微信账号 ↔ 当前 Session ─────────────────────────────────────────────

  const formatWechatSessionTitle = (label?: string): string => {
    const createdAt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()).replace(/\//g, '-');
    return label ? `微信 · ${createdAt} · ${label}` : `微信 · ${createdAt}`;
  };

  const createWechatSession = async (
    ownerUserId: string,
    contextToken: string | undefined,
    label?: string,
  ): Promise<string> => {
    const created = await ctx.sessions.create({
      containerId: CONTAINER_ID,
      title: formatWechatSessionTitle(label),
      activity: 'background',
      permissionMode: 'acceptCalls',
    });
    await ctx.storage.set(KEY_ACTIVE_SESSION, created.sessionId);
    await ctx.storage.set(`${SESSION_MAP_PREFIX}${created.sessionId}`, { peerId: ownerUserId, contextToken });
    return created.sessionId;
  };

  const ensureActiveWechatSession = async (
    ownerUserId: string,
    nickname: string | undefined,
    contextToken: string | undefined,
  ): Promise<string> => {
    const active = await ctx.storage.get<string>(KEY_ACTIVE_SESSION);
    if (active && (await ctx.sessions.get(active))) return active;

    // 兼容升级前的 peer 映射：找到后提升为唯一当前 Session。
    const legacy = await ctx.storage.get<string>(`${LEGACY_PEER_MAP_PREFIX}${ownerUserId}`);
    if (legacy && (await ctx.sessions.get(legacy))) {
      await ctx.storage.set(KEY_ACTIVE_SESSION, legacy);
      return legacy;
    }

    return createWechatSession(
      ownerUserId,
      contextToken,
      nickname,
    );
  };

  // ── 收发消息 ────────────────────────────────────────────────────────────────

  const sendWeixinText = async (toUserId: string, contextToken: string | undefined, text: string) => {
    const baseUrl = await ctx.storage.get<string>(KEY_BASE_URL);
    const token = await ctx.storage.get<string>(KEY_TOKEN);
    if (!baseUrl || !token) throw new Error('WeChat is not logged in');
    // context_token 随每条消息刷新，旧的会失效；回复时优先用该联系人最新的 token。
    const latestToken = (await ctx.storage.get<string>(`${CTOKEN_PREFIX}${toUserId}`)) ?? contextToken;
    // client_id 每条唯一，服务端据此去重；缺了会导致后续消息被当重复丢弃。
    const clientId = `openclaw-weixin:${Date.now()}-${randomHex(4)}`;
    const resp = await post<SendMessageResponse>(baseUrl, 'ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [{ type: 1, text_item: { text } }],
        context_token: latestToken,
      },
      base_info: buildBaseInfo(),
    }, token);
    // 成功时同样可能不带 ret；仅 ret 明确非 0 才算失败。
  if (resp.ret !== undefined && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} ${resp.errmsg ?? ''}`);
  }
  };

  // 文本 + 语音转文字（服务端在 voice_item.text 直接给出识别结果）。
  const extractText = (msg: WeixinInboundMessage): string =>
    (msg.item_list ?? [])
      .map((it) => {
        if (it.type === 1 && it.text_item?.text) return it.text_item.text;
        if (it.type === 3 && it.voice_item?.text) return it.voice_item.text; // 语音转文字
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();

  // 解析图片/文件/视频为 Session 附件（下载+解密→base64）。语音已转文字，不作附件。
  const extractAttachments = async (msg: WeixinInboundMessage): Promise<finch.SessionMessageAttachment[]> => {
    const out: finch.SessionMessageAttachment[] = [];
    for (const it of msg.item_list ?? []) {
      try {
        if (it.type === 2 && it.image_item?.media?.full_url) {
          const buf = await downloadMedia(it.image_item.media, it.image_item.aeskey);
          out.push({ name: `image-${randomHex(4)}.jpg`, mimeType: 'image/jpeg', kind: 'image', data: buf.toString('base64') });
        } else if (it.type === 4 && it.file_item?.media?.full_url) {
          const name = it.file_item.file_name ?? `file-${randomHex(4)}.bin`;
          const mime = guessMime(name);
          const buf = await downloadMedia(it.file_item.media);
          out.push({ name, mimeType: mime, kind: attachmentKindFor(mime), data: buf.toString('base64') });
        } else if (it.type === 5 && it.video_item?.media?.full_url) {
          const buf = await downloadMedia(it.video_item.media);
          out.push({ name: `video-${randomHex(4)}.mp4`, mimeType: 'video/mp4', kind: 'file', data: buf.toString('base64') });
        }
      } catch (error) {
        ctx.logger.warn('media download/decrypt failed', error);
      }
    }
    return out;
  };

  const handleInbound = async (msg: WeixinInboundMessage) => {
    const peerId = msg.from_user_id;
    if (!peerId) return;

    // 每条消息都下发新的 context_token，覆盖存最新值，回复时统一取用。
    if (msg.context_token) {
      await ctx.storage.set(`${CTOKEN_PREFIX}${peerId}`, msg.context_token);
    }

    const { autoReply } = readConfig();
    const owner = await ctx.storage.get<string>(KEY_OWNER_USER);
    if (owner && peerId !== owner) {
      ctx.logger.debug('message is not from the logged-in owner, skip', { peerId });
      return;
    }
    if (!owner) await ctx.storage.set(KEY_OWNER_USER, peerId);

    let text = extractText(msg);
    const attachments = await extractAttachments(msg);
    // 有附件但没文字时，给一句占位说明，便于模型理解语境。
    if (!text && attachments.length) {
      const kinds = attachments.map((a) => a.kind === 'image' ? 'image' : 'file').join(', ');
      text = `[WeChat ${kinds}]`;
    }
    if (!text && !attachments.length) return; // 纯不支持类型，忽略

    const sessionId = await ensureActiveWechatSession(peerId, msg.from_nickname, msg.context_token);
    const idempotencyKey = `wx:${peerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const receipt = await ctx.sessions.send(sessionId, {
      text,
      idempotencyKey,
      ...(attachments.length ? { attachments } : {}),
    });

    if (receipt.state === 'rejected') {
      ctx.logger.warn('session queue full', { peerId, code: receipt.code });
      if (autoReply) await sendWeixinText(peerId, msg.context_token, '我现在有点忙，请稍后再试。').catch(() => {});
      return;
    }
    await ctx.storage.set(`${TURN_MAP_PREFIX}${receipt.turnId}`, {
      peerId,
      contextToken: msg.context_token,
    });
    // 模型开始处理 → 给微信发 typing（结束在 turn.completed/failed 时取消）。
    if (autoReply) void startTyping(peerId, msg.context_token);
    deliveredCount += 1;
    
  };

  // ── Space 任务会话登记表 ────────────────────────────────────────────────
  const getTask = (sessionId: string) => ctx.storage.get<TaskRecord>(`${TASK_PREFIX}${sessionId}`);

  const saveTask = async (task: TaskRecord) => {
    await ctx.storage.set(`${TASK_PREFIX}${task.sessionId}`, task);
    const index = (await ctx.storage.get<string[]>(TASK_INDEX_KEY)) ?? [];
    if (!index.includes(task.sessionId)) {
      index.push(task.sessionId);
      await ctx.storage.set(TASK_INDEX_KEY, index);
    }
  };

  const listTasks = async (): Promise<TaskRecord[]> => {
    const index = (await ctx.storage.get<string[]>(TASK_INDEX_KEY)) ?? [];
    const out: TaskRecord[] = [];
    for (const id of index) {
      const t = await getTask(id);
      if (t) out.push(t);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  };

  /** 把任务执行状态回馈到微信联系人（若登记了 notifyPeerId）。 */
  const notifyTaskResult = async (task: TaskRecord) => {
    if (!task.notifyPeerId) return;
    const contextToken = await ctx.storage.get<string>(`${CTOKEN_PREFIX}${task.notifyPeerId}`);
    const label = task.title ? `「${task.title}」` : '任务';
    const body = task.status === 'completed'
      ? `✅ ${label}已完成：\n${(task.lastOutput ?? '').trim() || '（无文本输出）'}`
      : `❌ ${label}执行失败：${task.lastError ?? '未知错误'}`;
    try {
      await sendWeixinText(task.notifyPeerId, contextToken, body);
      ctx.logger.info('task result pushed to wechat', { sessionId: task.sessionId, status: task.status });
    } catch (error) {
      ctx.logger.error('notify task result failed', error);
    }
  };

  const applyTaskTerminal = async (
    task: TaskRecord,
    event: Extract<finch.SessionDurableEvent, { type: 'turn.completed' | 'turn.failed' }>,
    notify: boolean,
  ) => {
    // A newer turn may already be queued/running. Its state is authoritative;
    // a late terminal event from an older turn must not flip the task back to
    // completed/failed or replace the latest output.
    if (task.lastTurnId && task.lastTurnId !== event.turnId) return;
    task.lastTurnId = event.turnId;
    task.updatedAt = Date.now();
    if (event.type === 'turn.completed') {
      task.status = 'completed';
      task.lastOutput = event.outputText || task.lastOutput;
      task.lastError = undefined;
    } else {
      task.status = 'failed';
      task.lastError = event.code;
    }
    await saveTask(task);
    if (notify) await notifyTaskResult(task);
    
  };

  /** 更新 Space 任务状态；任务事件不再进入微信联系人自动回复逻辑。 */
  const handleTaskEvent = async (event: finch.SessionBridgeEvent): Promise<boolean> => {
    if (event.type === 'assistant.delta' || event.type === 'assistant.message') return false;
    const task = await getTask(event.sessionId);
    if (!task) return false;
    if (event.type === 'turn.waiting') {
      if (!task.lastTurnId || task.lastTurnId === event.turnId) {
        task.status = 'waiting';
        task.lastTurnId = event.turnId;
        task.updatedAt = Date.now();
        await saveTask(task);
        
      }
      return true;
    }
    await applyTaskTerminal(task, event, true);
    return true;
  };

  /** 等待当前任务 turn 的终态。timeout 只结束本次等待，不取消子会话。 */
  const waitForTask = async (task: TaskRecord, timeoutMs: number): Promise<TaskRecord> => {
    if ((task.status !== 'running' && task.status !== 'waiting') || !task.lastTurnId) return task;
    try {
      const result = await ctx.sessions.waitForTurn(task.sessionId, task.lastTurnId, { timeoutMs });
      if (result.state === 'timeout') return task;
      if (task.lastTurnId !== result.turnId) return task;
      task.updatedAt = Date.now();
      if (result.state === 'completed') {
        task.status = 'completed';
        task.lastOutput = result.outputText || task.lastOutput;
        task.lastError = undefined;
      } else {
        task.status = 'failed';
        task.lastError = result.code;
      }
      await saveTask(task);
      
    } catch (error) {
      ctx.logger.debug('task wait failed', { sessionId: task.sessionId, error: String(error) });
    }
    return task;
  };

  // Session 回复 → 微信
  ctx.subscriptions.push(
    ctx.sessions.onDidReceiveEvent(async (event) => {
      // Space 派发任务会话优先：更新任务状态并回馈微信，不走联系人回复逻辑。
      if (await handleTaskEvent(event)) return;

      // 微信联系人会话只在 turn 结束时发送最终回复。
      if (event.type !== 'turn.completed' && event.type !== 'turn.failed') return;
      const { autoReply } = readConfig();
      const turnKey = `${TURN_MAP_PREFIX}${event.turnId}`;
      let target = await ctx.storage.get<{ peerId: string; contextToken?: string }>(turnKey);
      await ctx.storage.delete(turnKey);
      if (!target) {
        const bySession = await ctx.storage.get<{ peerId: string; contextToken?: string }>(
          `${SESSION_MAP_PREFIX}${event.sessionId}`,
        );
        if (bySession) target = bySession;
      }
      if (!target?.peerId) return;

      // 无论成功失败，先取消该联系人的 typing 状态。
      await stopTyping(target.peerId);

      if (event.type === 'turn.failed') {
        ctx.logger.warn('turn failed', { peerId: target.peerId, code: event.code });
        return;
      }

      const reply = event.outputText.trim();
      if (!reply) return;
      if (!autoReply) {
        ctx.logger.info('autoReply off, not pushing to wechat', { peerId: target.peerId });
        return;
      }
      try {
        await sendWeixinText(target.peerId, target.contextToken, reply);
        ctx.logger.info('replied to wechat', { peerId: target.peerId, chars: reply.length });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        ctx.logger.error('reply to wechat failed', error);
        toast('微信回复失败', '消息暂时无法发送，请稍后重试。', 'error');
      }
    }),
  );

  // 长轮询收消息
  const messageLoop = async () => {
    if (messageRunning) return;
    messageRunning = true;
    stopMessageLoop = false;
    lastError = undefined;
    
    ctx.logger.info('wechat message loop started');

    while (!stopMessageLoop) {
      try {
        const baseUrl = await ctx.storage.get<string>(KEY_BASE_URL);
        const token = await ctx.storage.get<string>(KEY_TOKEN);
        if (!baseUrl || !token) {
          ctx.logger.info('not logged in, stopping message loop');
          break;
        }
        const cursor = (await ctx.storage.get<string>(KEY_CURSOR)) ?? '';
        const resp = await post<GetUpdatesResponse>(baseUrl, 'ilink/bot/getupdates', { get_updates_buf: cursor, base_info: buildBaseInfo() }, token);

        // 成功响应通常不带 ret；仅当 ret / errcode 明确非 0 才算失败（对齐 openclaw monitor）。
        const failed =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);
        if (failed) {
          // -14 = 会话超时（token 失效），需要重新登录。
          if (resp.errcode === -14 || resp.ret === -14) {
            ctx.logger.warn('session expired (-14), require re-login');
            toast('微信登录已失效', '请重新扫码登录。', 'warning');
            await logout();
            break;
          }
          throw new Error(`getUpdates ret=${resp.ret ?? '-'} errcode=${resp.errcode ?? '-'} ${resp.errmsg ?? ''}`);
        }

        if (resp.get_updates_buf !== undefined) await ctx.storage.set(KEY_CURSOR, resp.get_updates_buf);
        for (const msg of resp.msgs ?? []) {
          try {
            await handleInbound(msg);
          } catch (error) {
            // 重新登录后旧 Session 可能已失效；清除指针，让下一条消息自动创建新的微信会话。
            await ctx.storage.delete(KEY_ACTIVE_SESSION);
            const detail = error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { value: String(error) };
            ctx.logger.error('handle inbound failed', { peerId: msg.from_user_id, detail });
          }
        }
        backoffIndex = 0;
        lastError = undefined;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        ctx.logger.warn('getUpdates failed, backing off', { error: lastError });
        
        const delay = RECONNECT_BACKOFF_MS[Math.min(backoffIndex, RECONNECT_BACKOFF_MS.length - 1)];
        backoffIndex += 1;
        await sleep(delay, () => stopMessageLoop);
      }
    }

    messageRunning = false;
    
    ctx.logger.info('wechat message loop stopped');
  };

  const startMessageLoop = () => {
    if (messageRunning) return;
    void messageLoop();
  };

  // ── 微信 inbox SessionView 菜单 ───────────────────────────────────────────────

  settingsMenu = ctx.sessionContainers.registerSettingsMenu(CONTAINER_ID, {
    async getMenu() {
      const loggedIn = await isLoggedIn();
      const items: finch.ComposerActionMenuItem[] = [{
        id: 'status',
        label: '连接状态',
        description: loginPhase === 'verify'
          ? '等待输入配对码'
          : loginRunning
            ? loginPhase === 'scanned' ? '已扫码，等待手机确认' : '等待扫码'
            : loggedIn && messageRunning
              ? '已连接'
              : loggedIn
                ? '已登录，等待重新连接'
                : lastError ? '连接异常，请重新登录' : '未登录',
        iconName: wechatIcon('activity'),
      }];

      // separator 只负责画线；登录是独立且始终存在的可点击菜单项。
      items.push(
        { id: 'connection-divider', label: '', separator: true },
        {
          id: 'login',
          label: loginPhase === 'verify' ? '重新获取二维码' : loginRunning ? '再次显示二维码' : loggedIn ? '重新登录' : '登录微信',
          iconName: wechatIcon('qr-code'),
          hoverText: '直接打开微信扫码登录弹窗；已登录时会先清除旧连接。',
        },
      );

      if (loggedIn) {
        if (!messageRunning) {
          items.push({
            id: 'reconnect',
            label: '重新连接',
            iconName: wechatIcon('play'),
            hoverText: '使用现有登录状态恢复接收微信消息。',
          });
        }
        items.push({
          id: 'logout',
          label: '退出登录',
          iconName: wechatIcon('log-out'),
          hoverText: '清除登录状态并停止接收微信消息。',
        });
      }
      return items;
    },

    async execute(_menuContext, itemId) {
      try {
        if (itemId === 'login') {
          if (await isLoggedIn()) await logout();
          return void (await showLoginDialog());
        }
        if (itemId === 'logout') return void (await logout());
        if (itemId === 'reconnect') return startMessageLoop();
        if (itemId === 'status') {
          const loggedIn = await isLoggedIn();
          ctx.ui.notify(
            messageRunning
              ? `微信已连接，已接收 ${deliveredCount} 条消息。`
              : loggedIn
                ? '登录状态仍然有效，但当前未在接收消息。'
                : lastError ? '微信连接异常，请重新登录。' : '微信尚未登录。',
            lastError ? 'warning' : 'info',
          );
        }
      } catch (error) {
        ctx.logger.error('wechat SessionView menu failed', itemId, error);
        toast('操作失败', '请稍后重试。', 'error');
      }
    },
  });
  ctx.subscriptions.push(settingsMenu);

  // Agent 工具：切断当前微信上下文并创建新的 inbox Session。
  ctx.subscriptions.push(ctx.tools.register({
    name: 'wechat_new',
    title: '开启微信新对话',
    description: 'Start a fresh Finch Session for the logged-in WeChat account. The previous Session remains in the WeChat inbox, while subsequent WeChat messages use the new Session.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional title for the new Session.' },
      },
    },
    defaultEnabled: true,
    risk: 'medium',
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { title?: unknown };
      const requestedTitle = typeof input.title === 'string' ? input.title.trim() : '';
      const ownerUserId = await ctx.storage.get<string>(KEY_OWNER_USER);
      if (!ownerUserId || !(await isLoggedIn())) {
        return { content: [{ type: 'text', text: 'WeChat is not logged in.' }], isError: true };
      }
      try {
        const previousSessionId = await ctx.storage.get<string>(KEY_ACTIVE_SESSION);
        const contextToken = await ctx.storage.get<string>(`${CTOKEN_PREFIX}${ownerUserId}`);
        const sessionId = await createWechatSession(
          ownerUserId,
          contextToken,
          requestedTitle || undefined,
        );
        ctx.logger.info('created fresh wechat session', { previousSessionId, sessionId });
        return {
          content: [{
            type: 'text',
            text: `A new WeChat Session is active. New sessionId: ${sessionId}. The previous Session remains in the inbox.`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Failed to start a new WeChat Session: ${message}` }], isError: true };
      }
    },
  }));

  // Agent 工具：允许其他 Agent 主动向微信联系人发送文本。
  ctx.subscriptions.push(ctx.tools.register({
    name: 'wechat_send',
    title: '发送微信消息',
    description: 'Send a text message to WeChat. Omit recipient to use the account that completed QR login, or provide a known WeChat userId.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text message to send.' },
        recipient: { type: 'string', description: 'Optional WeChat userId. Defaults to the account that completed QR login.' },
      },
      required: ['message'],
    },
    defaultEnabled: true,
    risk: 'medium',
    callDisplay: { inline: { mode: 'single', fields: [{ path: 'recipient', label: '发送给' }] } },
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { message?: unknown; recipient?: unknown };
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      const requestedRecipient = typeof input.recipient === 'string' ? input.recipient.trim() : '';
      if (!message) return { content: [{ type: 'text', text: 'A message is required.' }], isError: true };
      const recipient = requestedRecipient || await ctx.storage.get<string>(KEY_OWNER_USER) || '';
      if (!recipient) return { content: [{ type: 'text', text: 'No recipient is known. Log in to WeChat first or provide recipient.' }], isError: true };
      try {
        const contextToken = await ctx.storage.get<string>(`${CTOKEN_PREFIX}${recipient}`);
        await sendWeixinText(recipient, contextToken, message);
        return { content: [{ type: 'text', text: `WeChat message sent to ${requestedRecipient ? recipient : 'the logged-in account'}.` }] };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Failed to send WeChat message: ${detail}` }], isError: true };
      }
    },
  }));

  // ───────────────────────────────────────────────────────────────────────────
  // Agent 工具：向指定 Space 创建一条归属该空间的对话，并发送首条消息。
  // spaceId 由主 Finch agent 通过 AppCall listSpaces 解析后传入。
  // ───────────────────────────────────────────────────────────────────────────
  ctx.subscriptions.push(ctx.tools.register({
    name: 'wechat_space_task',
    title: '管理微信空间任务',
    description: `Manage tasks dispatched from WeChat to Finch Spaces.
action:
  create — create a task in a Space (requires spaceId and message; title and notifyPeerId are optional)
  send   — send another message to an existing task (requires taskId and message)
  status — inspect one task or list all tasks (taskId and waitMs are optional)`, 
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'send', 'status'], description: 'Task operation to perform.' },
        spaceId: { type: 'string', description: 'create: target Space id.' },
        taskId: { type: 'string', description: 'send/status: task id.' },
        message: { type: 'string', description: 'create/send: message to send.' },
        title: { type: 'string', description: 'create: optional task title.' },
        notifyPeerId: { type: 'string', description: 'create: optional WeChat userId to notify when the task finishes.' },
        waitMs: { type: 'number', minimum: 0, maximum: 600000, description: 'status: optional wait time; returns immediately by default.' },
      },
      required: ['action'],
    },
    defaultEnabled: true,
    risk: 'medium',
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { action?: unknown; spaceId?: unknown; taskId?: unknown; message?: unknown; title?: unknown; notifyPeerId?: unknown; waitMs?: unknown };
      const taskAction = typeof input.action === 'string' ? input.action : '';
      const spaceId = typeof input.spaceId === 'string' ? input.spaceId.trim() : '';
      const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const notifyPeerId = typeof input.notifyPeerId === 'string' ? input.notifyPeerId.trim() : '';
      const waitMs = typeof input.waitMs === 'number' && Number.isFinite(input.waitMs) ? Math.max(0, input.waitMs) : 0;

      if (taskAction === 'send') {
        if (!taskId || !message) return { content: [{ type: 'text', text: 'send requires taskId and message.' }], isError: true };
        const task = await getTask(taskId);
        if (!task) return { content: [{ type: 'text', text: `Task not found: ${taskId}` }], isError: true };
        const receipt = await ctx.sessions.send(task.sessionId, {
          text: message,
          idempotencyKey: `wx-task:${taskId}:${Date.now()}-${randomHex(4)}`,
        });
        if (receipt.state === 'rejected') return { content: [{ type: 'text', text: `The task queue rejected the message. Retry after ${receipt.retryAfterMs}ms.` }], isError: true };
        task.status = 'running';
        task.lastTurnId = receipt.turnId;
        task.updatedAt = Date.now();
        await saveTask(task);
        return { content: [{ type: 'text', text: `Message sent to task ${taskId}.` }] };
      }

      if (taskAction === 'status') {
        const formatTask = (task: TaskRecord) => [
          `${task.title || 'Untitled task'} · ${task.status}`,
          `taskId: ${task.sessionId}`,
          `spaceId: ${task.spaceId}`,
          task.lastError ? `Error: ${task.lastError}` : '',
          task.lastOutput ? `Latest output:\n${task.lastOutput}` : '',
        ].filter(Boolean).join('\n');
        if (taskId) {
          const stored = await getTask(taskId);
          if (!stored) return { content: [{ type: 'text', text: `Task not found: ${taskId}` }], isError: true };
          const task = waitMs > 0 ? await waitForTask(stored, waitMs) : stored;
          return { content: [{ type: 'text', text: formatTask(task) }] };
        }
        const tasks = await listTasks();
        return { content: [{ type: 'text', text: tasks.length ? tasks.map(formatTask).join('\n\n') : 'There are no Space tasks.' }] };
      }

      if (taskAction !== 'create') return { content: [{ type: 'text', text: 'action must be create, send, or status.' }], isError: true };
      if (!spaceId || !message) return { content: [{ type: 'text', text: 'create requires spaceId and message.' }], isError: true };
      try {
        const session = await ctx.sessions.create({
          space: { spaceId },
          ...(title ? { title } : {}),
          permissionMode: 'acceptCalls',
        });
        const now = Date.now();
        const task: TaskRecord = {
          sessionId: session.sessionId,
          spaceId,
          title: title || undefined,
          notifyPeerId: notifyPeerId || undefined,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        };
        // Register ownership before dispatching the first turn so even a very
        // fast completion event cannot arrive before the task exists.
        await saveTask(task);
        const receipt = await ctx.sessions.send(session.sessionId, {
          text: message,
          idempotencyKey: `wx-space:${spaceId}:${Date.now()}-${randomHex(4)}`,
        });
        if (receipt.state === 'rejected') {
          task.status = 'failed';
          task.lastError = receipt.code;
          task.updatedAt = Date.now();
          await saveTask(task);
          throw new Error(`The initial message was rejected (${receipt.code})`);
        }
        task.lastTurnId = receipt.turnId;
        task.updatedAt = Date.now();
        await saveTask(task);
        ctx.logger.info('created space task session', { spaceId, sessionId: session.sessionId, notifyPeerId });
        const note = notifyPeerId ? `\nThe result will be sent to WeChat user ${notifyPeerId}.` : '';
        return { content: [{ type: 'text', text: `Task created in Space ${spaceId}.\ntaskId: ${session.sessionId}${note}` }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.logger.error('create space session failed', error);
        return { content: [{ type: 'text', text: `Failed to create task: ${msg}` }], isError: true };
      }
    },
  }));



  // 停用时清理
  ctx.subscriptions.push({
    dispose: () => {
      loginAttempt += 1;
      loginCancel = true;
      void activeLoginDialog?.close('disposed');
      activeLoginDialog = undefined;
      stopMessageLoop = true;
      // 清理所有 typing 保活定时器，避免泄漏。
      for (const state of typingState.values()) clearInterval(state.timer);
      typingState.clear();
    },
  });

  // 启动时若已登录，自动恢复接收。
  if (await isLoggedIn()) startMessageLoop();

  const info = await ctx.app.getInfo();
  ctx.logger.info('WeChat Bot activated', {
    app: info.versionDisplay,
    loggedIn: await isLoggedIn(),
  });
}

export function deactivate(): void {
  // 订阅在 ctx.subscriptions 中自动清理；循环标志会终止轮询。
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

/** 可取消的 sleep：每 250ms 检查一次取消标志。 */
function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const step = 250;
    let elapsed = 0;
    const tick = () => {
      if (cancelled() || elapsed >= ms) {
        resolve();
        return;
      }
      elapsed += step;
      setTimeout(tick, Math.min(step, ms - elapsed));
    };
    setTimeout(tick, Math.min(step, ms));
  });
}
