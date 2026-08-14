import type * as finch from 'finch';
import {
  EventType,
  WSClient,
  WSAuthFailureError,
  WSReconnectExhaustedError,
  generateReqId,
  type WsFrame,
  type WsFrameHeaders,
} from '@wecom/aibot-node-sdk';
import {
  BOT_ID_SECRET, BOT_SECRET_SECRET,
  CONTAINER_ID,
  PEER_PREFIX, SEEN_INDEX_KEY, SEEN_PREFIX, SESSION_PREFIX, TURN_PREFIX,
  MAX_SEEN_MESSAGES,
  PROCESSING_TEXT, BUSY_TEXT, WELCOME_TEXT,
  type WeComPeer, type WeComRuntimeState,
} from './types';
import {
  attachmentKind, errorText, mediaTypeFor, mimeFor, peerFromMessage, safeKey, stripBotMention, truncateUtf8,
} from './utils';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * WeCom Bridge：企微智能机器人（长连接）与 Finch Session 的桥接层。
 *
 * - 凭证：BotID / Secret 存 Finch 系统安全存储（ctx.secrets），不落明文 storage。
 * - 入站：msgid 持久化去重 → 解析各消息类型（文本/语音转写/图片/文件/视频/图文混排）
 *   → 媒体即时下载解密为 Finch 附件 → 路由到对应对端 Session。
 * - 出站：回复走原始 req_id 流式消息（先发「正在处理」占位，turn 完成发 finish=true）；
 *   进程重启后 liveTurns 丢失，回退为按 chatid 主动推送。
 * - 会话：每个 userid/chatid 独立 Finch Session，互不干扰。
 */
export class WecomBridge {
  private ctx: finch.MiniToolContext;
  private state: WeComRuntimeState = {
    client: undefined,
    connecting: false,
    authenticated: false,
    lastError: undefined,
    receivedCount: 0,
    menu: undefined,
  };
  /** 内存中的活跃 turn 路由（含原始帧，可透传 req_id 做流式终态回复）。 */
  private liveTurns = new Map<string, { peer: WeComPeer; streamId: string; frame: WsFrameHeaders }>();

  constructor(ctx: finch.MiniToolContext) {
    this.ctx = ctx;
  }

  get runtime(): WeComRuntimeState {
    return this.state;
  }

  setMenu(menu: WeComRuntimeState['menu']): void {
    this.state.menu = menu;
  }

  private autoReply(): boolean {
    return this.ctx.settings.get<boolean>('autoReply') ?? true;
  }

  private botName(): string {
    return (this.ctx.settings.get<string>('botName') ?? '').trim();
  }

  // ── 凭证（ctx.secrets） ────────────────────────────────────────────────────

  async hasCredentials(): Promise<boolean> {
    return Boolean(await this.ctx.secrets.get(BOT_ID_SECRET) && await this.ctx.secrets.get(BOT_SECRET_SECRET));
  }

  async saveCredentials(botId: string, secret: string): Promise<void> {
    await this.ctx.secrets.set(BOT_ID_SECRET, botId.trim());
    try {
      await this.ctx.secrets.set(BOT_SECRET_SECRET, secret.trim());
    } catch (error) {
      await this.ctx.secrets.delete(BOT_ID_SECRET);
      throw error;
    }
  }

  async clearCredentials(): Promise<void> {
    this.disconnect();
    await this.ctx.secrets.delete(BOT_ID_SECRET);
    await this.ctx.secrets.delete(BOT_SECRET_SECRET);
    this.state.lastError = undefined;
    this.state.menu?.notifyUpdate();
  }

  // ── 连接生命周期 ───────────────────────────────────────────────────────────

  connect(): void {
    if (this.state.connecting || this.state.authenticated || this.state.client) return;
    this.state.connecting = true;
    this.state.lastError = undefined;
    this.state.menu?.notifyUpdate();
    void this.createClient().catch((error: unknown) => {
      this.state.connecting = false;
      this.state.authenticated = false;
      this.state.lastError = errorText(error);
      this.ctx.logger.error('wecom connect failed', error);
      this.state.menu?.notifyUpdate();
    });
  }

  private async createClient(): Promise<void> {
    const botId = await this.ctx.secrets.get(BOT_ID_SECRET);
    const secret = await this.ctx.secrets.get(BOT_SECRET_SECRET);
    if (!botId || !secret) throw new Error('WeCom BotID or Secret is not configured.');

    const logger = {
      debug: (message: string, ...args: unknown[]) => this.ctx.logger.debug(message, ...args),
      info: (message: string, ...args: unknown[]) => this.ctx.logger.info(message, ...args),
      warn: (message: string, ...args: unknown[]) => this.ctx.logger.warn(message, ...args),
      error: (message: string, ...args: unknown[]) => this.ctx.logger.error(message, ...args),
    };

    const client = new WSClient({
      botId,
      secret,
      maxReconnectAttempts: -1, // 无限重连，避免进程长期运行后连接丢失
      heartbeatInterval: 30_000,
      logger,
    });
    this.state.client = client;

    client.on('connected', () => {
      this.state.connecting = true;
      this.state.menu?.notifyUpdate();
    });
    client.on('authenticated', () => {
      this.state.connecting = false;
      this.state.authenticated = true;
      this.state.lastError = undefined;
      this.ctx.logger.info('wecom authenticated');
      this.state.menu?.notifyUpdate();
    });
    client.on('reconnecting', (attempt: number) => {
      this.state.connecting = true;
      this.state.authenticated = false;
      this.ctx.logger.warn('wecom reconnecting', { attempt });
      this.state.menu?.notifyUpdate();
    });
    client.on('disconnected', (reason: string) => {
      this.state.connecting = false;
      this.state.authenticated = false;
      this.state.lastError = reason || 'Disconnected';
      this.ctx.logger.warn('wecom disconnected', { reason });
      this.state.menu?.notifyUpdate();
    });
    client.on('error', (error: Error) => {
      this.state.connecting = false;
      this.state.authenticated = false;
      this.state.lastError = error instanceof WSAuthFailureError
        ? `认证失败（${error.code}）`
        : error instanceof WSReconnectExhaustedError
          ? `重连次数已用尽（${error.code}）`
          : error.message;
      this.ctx.logger.error('wecom websocket error', error);
      this.state.menu?.notifyUpdate();
    });

    client.on('message', (frame: WsFrame) => {
      void this.handleInbound(frame).catch((error: unknown) => {
        this.ctx.logger.error('wecom inbound handling failed', error);
      });
    });

    // 用户首次进入单聊会话 → 欢迎语（5 秒内回复）
    client.on('event.enter_chat', (frame: WsFrame) => {
      void client.replyWelcome(frame, { msgtype: 'text', text: { content: WELCOME_TEXT } })
        .then((result) => this.assertSdkSuccess(result, 'replyWelcome'))
        .catch((error: unknown) => this.ctx.logger.warn('wecom welcome reply failed', error));
    });

    // 被同一 BotID 的新连接顶替
    client.on('event', (frame: WsFrame) => {
      const eventType = (frame.body as { event?: { eventtype?: string } } | undefined)?.event?.eventtype;
      if (eventType !== EventType.Disconnected) return;
      this.state.connecting = false;
      this.state.authenticated = false;
      this.state.lastError = '连接已被同一 BotID 的新连接替换';
      this.ctx.logger.warn('wecom connection replaced by a newer connection');
      this.state.menu?.notifyUpdate();
    });

    client.connect();
  }

  disconnect(): void {
    (this.state.client as WSClient | undefined)?.disconnect();
    this.state.client = undefined;
    this.state.connecting = false;
    this.state.authenticated = false;
    this.state.menu?.notifyUpdate();
  }

  reconnect(): void {
    this.disconnect();
    this.connect();
  }

  dispose(): void {
    this.disconnect();
    this.liveTurns.clear();
  }

  // ── 去重 ───────────────────────────────────────────────────────────────────

  private async isDuplicate(msgId: string): Promise<boolean> {
    if (!msgId) return false;
    const key = `${SEEN_PREFIX}${safeKey(msgId)}`;
    if (await this.ctx.storage.get(key)) return true;
    await this.ctx.storage.set(key, true);
    const index = (await this.ctx.storage.get<string[]>(SEEN_INDEX_KEY)) ?? [];
    index.push(key);
    while (index.length > MAX_SEEN_MESSAGES) {
      const oldest = index.shift();
      if (oldest) await this.ctx.storage.delete(oldest);
    }
    await this.ctx.storage.set(SEEN_INDEX_KEY, index);
    return false;
  }

  // ── 会话映射 ───────────────────────────────────────────────────────────────

  private async ensureSession(peer: WeComPeer): Promise<string> {
    const key = `${SESSION_PREFIX}${safeKey(peer.key)}`;
    const existing = await this.ctx.storage.get<string>(key);
    if (existing && await this.ctx.sessions.get(existing)) return existing;
    const label = peer.chatType === 'group' ? `群聊 ${peer.chatId.slice(-8)}` : `成员 ${peer.userId.slice(-8)}`;
    const created = await this.ctx.sessions.create({
      containerId: CONTAINER_ID,
      title: `企业微信 · ${label}`,
      activity: 'background',
      permissionMode: 'acceptCalls',
    });
    await this.ctx.storage.set(key, created.sessionId);
    await this.ctx.storage.set(`${PEER_PREFIX}${created.sessionId}`, peer);
    return created.sessionId;
  }

  async createFreshSession(peerKey: string, title?: string): Promise<string> {
    const peer = await this.findPeer(peerKey);
    if (!peer) throw new Error(`Unknown WeCom peer: ${peerKey}`);
    const created = await this.ctx.sessions.create({
      containerId: CONTAINER_ID,
      title: title?.trim() || `企业微信 · ${peer.chatType === 'group' ? '群聊' : '单聊'}`,
      activity: 'background',
      permissionMode: 'acceptCalls',
    });
    await this.ctx.storage.set(`${SESSION_PREFIX}${safeKey(peer.key)}`, created.sessionId);
    await this.ctx.storage.set(`${PEER_PREFIX}${created.sessionId}`, peer);
    return created.sessionId;
  }

  private async findPeer(peerKey: string): Promise<WeComPeer | undefined> {
    const direct = await this.ctx.storage.get<WeComPeer>(`${PEER_PREFIX}known:${safeKey(peerKey)}`);
    if (direct) return direct;
    const keys = await this.ctx.storage.keys();
    for (const key of keys.filter((item) => item.startsWith(PEER_PREFIX) && !item.startsWith(`${PEER_PREFIX}known:`))) {
      const peer = await this.ctx.storage.get<WeComPeer>(key);
      if (peer?.key === peerKey || peer?.chatId === peerKey || peer?.userId === peerKey) return peer;
    }
    return undefined;
  }

  async listPeers(): Promise<WeComPeer[]> {
    const keys = (await this.ctx.storage.keys()).filter((key) => key.startsWith(`${PEER_PREFIX}known:`));
    const peers = await Promise.all(keys.map((key) => this.ctx.storage.get<WeComPeer>(key)));
    return peers.filter((peer): peer is WeComPeer => Boolean(peer));
  }

  // ── 入站消息 ───────────────────────────────────────────────────────────────

  private async downloadAttachment(
    client: WSClient,
    media: { url?: string; aeskey?: string },
    kind: 'image' | 'video' | 'voice' | 'file',
    fallbackName: string,
  ): Promise<finch.SessionMessageAttachment | undefined> {
    if (!media.url) return undefined;
    const result = await client.downloadFile(media.url, media.aeskey);
    const name = result.filename || fallbackName;
    const mimeType = mimeFor(kind, name);
    return {
      name,
      mimeType,
      data: result.buffer.toString('base64'),
      kind: attachmentKind(mimeType),
    };
  }

  private async messageContent(frame: WsFrame): Promise<{ text: string; attachments: finch.SessionMessageAttachment[] }> {
    const message = frame.body as {
      msgtype?: string;
      chattype?: 'single' | 'group';
      chatid?: string;
      from?: { userid?: string };
      text?: { content?: string };
      voice?: { content?: string };
      image?: { url?: string; aeskey?: string };
      file?: { url?: string; aeskey?: string };
      video?: { url?: string; aeskey?: string };
      mixed?: { msg_item?: Array<{ msgtype?: string; text?: { content?: string }; image?: { url?: string; aeskey?: string } }> };
      quote?: { text?: { content?: string } };
    };
    const client = this.state.client as WSClient | undefined;
    const attachments: finch.SessionMessageAttachment[] = [];
    let text = '';

    if (message.msgtype === 'text') {
      text = message.text?.content ?? '';
    } else if (message.msgtype === 'voice') {
      text = message.voice?.content ?? '[企业微信语音]';
    } else if (message.msgtype === 'image' && client) {
      const attachment = await this.downloadAttachment(client, message.image ?? {}, 'image', `image-${Date.now()}.jpg`);
      if (attachment) attachments.push(attachment);
      text = '[企业微信图片]';
    } else if (message.msgtype === 'file' && client) {
      const attachment = await this.downloadAttachment(client, message.file ?? {}, 'file', `file-${Date.now()}`);
      if (attachment) attachments.push(attachment);
      text = `[企业微信文件${attachment ? `：${attachment.name}` : ''}]`;
    } else if (message.msgtype === 'video' && client) {
      const attachment = await this.downloadAttachment(client, message.video ?? {}, 'video', `video-${Date.now()}.mp4`);
      if (attachment) attachments.push(attachment);
      text = '[企业微信视频]';
    } else if (message.msgtype === 'mixed' && client) {
      const parts: string[] = [];
      let imageIndex = 0;
      for (const item of message.mixed?.msg_item ?? []) {
        if (item.msgtype === 'text' && item.text?.content) parts.push(item.text.content);
        if (item.msgtype === 'image' && item.image) {
          imageIndex += 1;
          const attachment = await this.downloadAttachment(
            client,
            item.image,
            'image',
            `mixed-image-${imageIndex}-${Date.now()}.jpg`,
          );
          if (attachment) attachments.push(attachment);
        }
      }
      text = parts.join('\n').trim() || '[企业微信图文消息]';
    }

    if (message.chattype === 'group' && (message.msgtype === 'text' || message.msgtype === 'mixed')) {
      text = stripBotMention(text, this.botName());
    }

    const quoted = message.quote?.text?.content;
    if (quoted) {
      text = `> 引用：${quoted}\n\n${text}`;
    }

    if (message.chattype === 'group' && message.from?.userid) {
      text = `[${message.from.userid}] ${text}`.trim();
    }

    return { text: text.trim(), attachments };
  }

  private async handleInbound(frame: WsFrame): Promise<void> {
    const message = frame.body as { msgid?: string } | undefined;
    if (!message?.msgid || await this.isDuplicate(message.msgid)) return;

    const peer = peerFromMessage(frame.body);
    if (!peer) return;

    await this.ctx.storage.set(`${PEER_PREFIX}known:${safeKey(peer.key)}`, peer);

    const { text, attachments } = await this.messageContent(frame);
    if (!text && !attachments.length) return;

    const sessionId = await this.ensureSession(peer);
    const receipt = await this.ctx.sessions.send(sessionId, {
      text,
      idempotencyKey: `wecom:${message.msgid}`,
      ...(attachments.length ? { attachments } : {}),
    });
    if (receipt.state === 'rejected') {
      if (this.autoReply()) {
        void this.replyToFrame(frame, generateReqId('busy'), BUSY_TEXT, true).catch(() => {});
      }
      return;
    }

    const streamId = generateReqId('finch');
    const route = { peer, streamId, frame };
    this.liveTurns.set(receipt.turnId, route);
    const stored = { peer, streamId };
    await this.ctx.storage.set(`${TURN_PREFIX}${receipt.turnId}`, stored);
    this.state.receivedCount += 1;

    // 先发「正在处理」占位（流式中间帧），turn 完成后用同一 streamId 发终态
    if (this.autoReply()) {
      void this.replyToFrame(frame, streamId, PROCESSING_TEXT, false).catch((error: unknown) => {
        this.ctx.logger.debug('wecom processing reply skipped', error);
      });
    }
  }

  // ── 出站：回复 / 主动推送 ───────────────────────────────────────────────────

  private assertSdkSuccess(result: { errcode?: number; errmsg?: string }, operation: string): void {
    if (result.errcode !== undefined && result.errcode !== 0) {
      throw new Error(`${operation} failed: errcode=${result.errcode} ${result.errmsg ?? ''}`.trim());
    }
  }

  private async replyToFrame(frame: WsFrameHeaders, streamId: string, content: string, finish: boolean): Promise<void> {
    const client = this.state.client as WSClient | undefined;
    if (!client?.isConnected) throw new Error('WeCom is not connected.');
    const result = await client.replyStream(frame, streamId, truncateUtf8(content), finish);
    this.assertSdkSuccess(result, 'replyStream');
  }

  private async pushText(peer: WeComPeer, content: string): Promise<void> {
    const client = this.state.client as WSClient | undefined;
    if (!client?.isConnected) throw new Error('WeCom is not connected.');
    const result = await client.sendMessage(peer.chatId, {
      msgtype: 'markdown',
      markdown: { content: truncateUtf8(content) },
    });
    this.assertSdkSuccess(result, 'sendMessage');
  }

  // ── Session 事件 → 企微回复 ─────────────────────────────────────────────────

  registerSessionEvents(): finch.Disposable {
    return this.ctx.sessions.onDidReceiveEvent(async (event) => {
      if (event.type === 'turn.waiting') {
        // 等待卡片不通过企微中继（#code 已简化为桌面端处理），只做提示
        const peer = await this.ctx.storage.get<WeComPeer>(`${PEER_PREFIX}${event.sessionId}`);
        if (peer) {
          await this.pushText(peer, '此任务正在等待确认或补充信息，请在 Finch 桌面端处理后继续。').catch((error: unknown) => {
            this.ctx.logger.warn('failed to relay wait to wecom', error);
          });
        }
        return;
      }

      if (event.type !== 'turn.completed' && event.type !== 'turn.failed') return;
      const key = `${TURN_PREFIX}${event.turnId}`;
      const live = this.liveTurns.get(event.turnId);
      const stored = live ?? await this.ctx.storage.get<{ peer: WeComPeer; streamId: string }>(key);
      this.liveTurns.delete(event.turnId);
      await this.ctx.storage.delete(key);
      if (!stored || !this.autoReply()) return;

      const content = event.type === 'turn.completed'
        ? event.outputText.trim() || '（无文本输出）'
        : `处理失败：${event.code}`;
      try {
        if (live) await this.replyToFrame(live.frame, live.streamId, content, true);
        else await this.pushText(stored.peer, content);
      } catch (error) {
        this.state.lastError = errorText(error);
        this.ctx.logger.error('failed to reply to wecom', error);
      }
    });
  }

  // ── Agent 工具支持 ──────────────────────────────────────────────────────────

  async sendText(peerKey: string, message: string): Promise<void> {
    const peer = await this.findPeer(peerKey);
    if (!peer) throw new Error(`Unknown WeCom peer: ${peerKey}`);
    await this.pushText(peer, message);
  }

  async sendFile(peerKey: string, filePath: string, caption?: string): Promise<void> {
    const peer = await this.findPeer(peerKey);
    if (!peer) throw new Error(`Unknown WeCom peer: ${peerKey}`);
    const client = this.state.client as WSClient | undefined;
    if (!client?.isConnected) throw new Error('WeCom is not connected.');
    const data = await readFile(filePath);
    const fileName = basename(filePath);
    const mediaType = mediaTypeFor(fileName);
    const uploaded = await client.uploadMedia(data, { type: mediaType, filename: fileName });
    if (caption?.trim()) await this.pushText(peer, caption.trim());
    const result = await client.sendMediaMessage(
      peer.chatId,
      mediaType,
      uploaded.media_id,
      mediaType === 'video' ? { title: fileName } : undefined,
    );
    this.assertSdkSuccess(result, 'sendMediaMessage');
  }
}
