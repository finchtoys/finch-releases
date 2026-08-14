import type * as finch from 'finch';
import AiBot, {
  WSClient,
  EventType,
  MessageType,
  WSAuthFailureError,
  WSReconnectExhaustedError,
  type Logger,
  type SendMsgBody,
  type TextMessage,
  type ImageMessage,
  type MixedMessage,
  type VoiceMessage,
  type FileMessage,
  type VideoMessage,
  type WsFrame,
  type WsFrameHeaders,
  type WeComMediaType,
} from '@wecom/aibot-node-sdk';

/** 入站消息的原始解析结果（供 index.ts 组装 WeComInbound）。 */
export interface RawInbound {
  msgid: string;
  chattype: 'single' | 'group';
  chatid?: string;
  userid: string;
  /** 文本（text / voice 转文本 / mixed 文本项）。 */
  text: string;
  /** 媒体项（image/file/video，未下载，含 url 与可选 aeskey）。 */
  media: Array<{ kind: 'image' | 'file' | 'video'; url: string; aeskey?: string; name?: string }>;
  /** 原始帧，供 reply 透传 req_id。 */
  frame: WsFrameHeaders;
}

export type WeComInboundListener = (inbound: RawInbound) => void;
export type WeComEventType = 'connected' | 'authenticated' | 'disconnected' | 'reconnecting' | 'error';

export type { WsFrameHeaders }; // 透传 SDK 帧头类型（req_id 透传回复用）

export interface WeComClientOptions {
  botId: string;
  secret: string;
  wsUrl?: string;
  logger: Logger;
}

/**
 * 企微智能机器人传输层封装。
 *
 * 基于官方 @wecom/aibot-node-sdk（WebSocket 长连接通道）：
 * - 自动认证帧（aibot_subscribe）、心跳保活、指数退避重连、认证失败/重连次数耗尽报错
 * - 消息分发事件 message.text/image/mixed/voice/file/video
 * - 事件回调 event.enter_chat / event.template_card_event / event.disconnected_event 等
 * - 串行回复队列（同一 req_id 串行等待回执）、流式回复、模板卡片、主动推送、媒体上传/下载解密
 */
export class WeComTransport {
  private client: WSClient | undefined;
  private onInbound: WeComInboundListener;
  private onEvent: (type: WeComEventType, detail?: string) => void;
  private manualClose = false;
  private logger: Logger;

  constructor(
    private ctx: finch.MiniToolContext,
    private options: WeComClientOptions,
    onInbound: WeComInboundListener,
    onEvent: (type: WeComEventType, detail?: string) => void,
  ) {
    this.onInbound = onInbound;
    this.onEvent = onEvent;
    this.logger = options.logger;
  }

  /** 建立连接（幂等：已连接时忽略）。 */
  connect(): void {
    if (this.client?.isConnected) return;
    this.manualClose = false;
    this.logger.info('wecom connect', { botId: this.options.botId });
    const client = new AiBot.WSClient({
      botId: this.options.botId,
      secret: this.options.secret,
      ...(this.options.wsUrl ? { wsUrl: this.options.wsUrl } : {}),
      logger: this.logger,
    });
    this.client = client;

    client.on('connected', () => this.onEvent('connected'));
    client.on('authenticated', () => {
      this.onEvent('authenticated');
      this.logger.info('wecom authenticated');
    });
    client.on('disconnected', (reason: string) => {
      // 手动断开或被服务端踢下线（disconnected_event）时不视为错误
      if (!this.manualClose) this.onEvent('disconnected', reason);
    });
    client.on('reconnecting', (attempt: number) => this.onEvent('reconnecting', String(attempt)));
    client.on('error', (error: Error) => {
      this.logger.warn('wecom ws error', String(error));
      if (error instanceof WSAuthFailureError) {
        this.onEvent('error', `auth_failure:${error.code}`);
      } else if (error instanceof WSReconnectExhaustedError) {
        this.onEvent('error', `reconnect_exhausted:${error.code}`);
      } else {
        this.onEvent('error', error.message);
      }
    });

    client.on('message.text', (frame: WsFrame<TextMessage>) => {
      const body = frame.body;
      if (!body) return;
      this.onInbound({
        msgid: body.msgid,
        chattype: body.chattype,
        chatid: body.chatid,
        userid: body.from?.userid ?? '',
        text: body.text?.content ?? '',
        media: [],
        frame,
      });
    });

    client.on('message.voice', (frame: WsFrame<VoiceMessage>) => {
      const body = frame.body;
      if (!body) return;
      this.onInbound({
        msgid: body.msgid,
        chattype: body.chattype,
        chatid: body.chatid,
        userid: body.from?.userid ?? '',
        text: body.voice?.content ?? '',
        media: [],
        frame,
      });
    });

    client.on('message.image', (frame: WsFrame<ImageMessage>) => {
      const body = frame.body;
      if (!body) return;
      this.onInbound({
        msgid: body.msgid,
        chattype: body.chattype,
        chatid: body.chatid,
        userid: body.from?.userid ?? '',
        text: '',
        media: [{ kind: 'image', url: body.image?.url ?? '', aeskey: body.image?.aeskey }],
        frame,
      });
    });

    client.on('message.file', (frame: WsFrame<FileMessage>) => {
      const body = frame.body;
      if (!body) return;
      const name = (body as FileMessage & { file?: { name?: string } }).file?.name;
      this.onInbound({
        msgid: body.msgid,
        chattype: body.chattype,
        chatid: body.chatid,
        userid: body.from?.userid ?? '',
        text: '',
        media: [{ kind: 'file', url: body.file?.url ?? '', aeskey: body.file?.aeskey, name }],
        frame,
      });
    });

    client.on('message.video', (frame: WsFrame<VideoMessage>) => {
      const body = frame.body;
      if (!body) return;
      this.onInbound({
        msgid: body.msgid,
        chattype: body.chattype,
        chatid: body.chatid,
        userid: body.from?.userid ?? '',
        text: '',
        media: [{ kind: 'video', url: body.video?.url ?? '', aeskey: body.video?.aeskey }],
        frame,
      });
    });

    client.on('message.mixed', (frame: WsFrame<MixedMessage>) => {
      const body = frame.body;
      if (!body) return;
      const textParts: string[] = [];
      const media: RawInbound['media'] = [];
      for (const item of body.mixed?.msg_item ?? []) {
        if (item.msgtype === 'text' && item.text?.content) textParts.push(item.text.content);
        if (item.msgtype === 'image' && item.image?.url) {
          media.push({ kind: 'image', url: item.image.url, aeskey: item.image.aeskey });
        }
      }
      this.onInbound({
        msgid: body.msgid,
        chattype: body.chattype,
        chatid: body.chatid,
        userid: body.from?.userid ?? '',
        text: textParts.join('\n'),
        media,
        frame,
      });
    });

    // 事件：进入会话（欢迎语）、模板卡片、被踢下线
    client.on('event', (frame: WsFrame) => {
      const body = frame.body as { event?: { eventtype?: string } } | undefined;
      const eventtype = body?.event?.eventtype;
      if (eventtype === EventType.Disconnected) {
        this.logger.warn('wecom kicked by a newer connection (disconnected_event)');
        this.onEvent('disconnected', 'kicked');
      }
    });

    client.connect();
  }

  /** 主动断开（不触发自动重连）。 */
  disconnect(): void {
    this.manualClose = true;
    this.client?.disconnect();
    this.client = undefined;
  }

  get isConnected(): boolean {
    return Boolean(this.client?.isConnected);
  }

  /** 终态回复：文本（流式 finish=true，一次性消息）。 */
  async replyText(frame: WsFrameHeaders, text: string): Promise<void> {
    if (!this.client) throw new Error('WeCom is not connected');
    const streamId = `f${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const result = await this.client.replyStream(frame, streamId, text, true);
    this.throwIfErrcode(result, 'replyText');
  }

  /** 终态回复：媒体（先上传拿 media_id）。 */
  async replyMedia(frame: WsFrameHeaders, buffer: Buffer, fileName: string): Promise<void> {
    if (!this.client) throw new Error('WeCom is not connected');
    const mediaType = mediaTypeFor(fileName);
    const uploaded = await this.client.uploadMedia(buffer, { type: mediaType, filename: fileName });
    const result = await this.client.replyMedia(frame, mediaType, uploaded.media_id);
    this.throwIfErrcode(result, 'replyMedia');
  }

  /** 主动推送文本（markdown）。 */
  async sendText(peerKey: string, text: string): Promise<void> {
    if (!this.client) throw new Error('WeCom is not connected');
    const body: SendMsgBody = { msgtype: 'markdown', markdown: { content: text } };
    const result = await this.client.sendMessage(peerKey, body);
    this.throwIfErrcode(result, 'sendText');
  }

  /** 主动推送媒体。 */
  async sendMedia(peerKey: string, buffer: Buffer, fileName: string): Promise<void> {
    if (!this.client) throw new Error('WeCom is not connected');
    const mediaType = mediaTypeFor(fileName);
    const uploaded = await this.client.uploadMedia(buffer, { type: mediaType, filename: fileName });
    const result = await this.client.sendMediaMessage(peerKey, mediaType, uploaded.media_id);
    this.throwIfErrcode(result, 'sendMedia');
  }

  /** 下载并解密入站媒体（AES-256-CBC，aeskey 每文件独立）。 */
  async downloadMedia(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }> {
    if (!this.client) throw new Error('WeCom is not connected');
    return this.client.downloadFile(url, aesKey);
  }

  /** 上传媒体为临时素材（3 天内有效）。 */
  async uploadMedia(buffer: Buffer, fileName: string): Promise<string> {
    if (!this.client) throw new Error('WeCom is not connected');
    const mediaType = mediaTypeFor(fileName);
    const uploaded = await this.client.uploadMedia(buffer, { type: mediaType, filename: fileName });
    return uploaded.media_id;
  }

  private throwIfErrcode(result: WsFrame, op: string): void {
    if (result.errcode !== undefined && result.errcode !== 0) {
      throw new Error(`${op} failed: errcode=${result.errcode} ${result.errmsg ?? ''}`);
    }
  }
}

/** 根据文件名推断企微媒体类型（file/image/voice/video）。 */
export function mediaTypeFor(fileName: string): WeComMediaType {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return 'video';
  if (['amr', 'mp3', 'wav', 'silk'].includes(ext)) return 'voice';
  return 'file';
}

/** 消息类型常量（供上层判断）。 */
export { MessageType, EventType };
