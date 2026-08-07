import { createHash, randomBytes } from 'node:crypto';
import type * as finch from 'finch';
import {
  CDN_BASE_URL,
  CTOKEN_PREFIX, KEY_BASE_URL, KEY_TOKEN,
  UPLOAD_MEDIA_IMAGE, UPLOAD_MEDIA_VIDEO, UPLOAD_MEDIA_FILE,
  type GetUploadUrlResponse, type UploadedMediaInfo,
  type WeixinCdnMedia, type WeixinMessageItem, type SendMessageResponse,
} from './types';
import { IlinkClient } from './ilink-client';
import {
  encryptAesEcb, decryptAesEcb, parseAesKey, aesEcbPaddedSize,
  guessMime, attachmentKindFor, randomHex, sleep,
} from './utils';

/**
 * 媒体管理器：CDN 上传/下载 + 发送文本/图片/视频/文件消息。
 */
export class MediaManager {
  constructor(
    private ctx: finch.MiniToolContext,
    private ilink: IlinkClient,
  ) {}

  // ── CDN 下载解密 ────────────────────────────────────────────────────────────

  /** 下载并（按需）解密一个 CDN 媒体，返回明文 Buffer。 */
  async downloadMedia(media: WeixinCdnMedia, aesKeyOverrideHex?: string): Promise<Buffer> {
    if (!media.full_url) throw new Error('Missing full_url for media download');
    const res = await fetch(media.full_url);
    if (!res.ok) throw new Error(`CDN download failed with HTTP ${res.status}`);
    const encrypted = Buffer.from(await res.arrayBuffer());
    const keyB64 = aesKeyOverrideHex
      ? Buffer.from(aesKeyOverrideHex, 'hex').toString('base64')
      : media.aes_key;
    if (!keyB64) return encrypted;
    return decryptAesEcb(encrypted, parseAesKey(keyB64));
  }

  // ── CDN 上传 ────────────────────────────────────────────────────────────────

  /** 调用 getuploadurl 获取 CDN 上传参数。 */
  private async getUploadUrl(
    toUserId: string, filekey: string, mediaType: number,
    rawsize: number, rawfilemd5: string, filesize: number, aeskeyHex: string,
  ): Promise<GetUploadUrlResponse> {
    const baseUrl = await this.ilink.getBaseUrl();
    const token = await this.ilink.getToken();
    if (!baseUrl || !token) throw new Error('WeChat is not logged in');
    return this.ilink.post<GetUploadUrlResponse>(baseUrl, 'ilink/bot/getuploadurl', {
      filekey, media_type: mediaType, to_user_id: toUserId,
      rawsize, rawfilemd5, filesize, no_need_thumb: true, aeskey: aeskeyHex,
      base_info: this.ilink.buildBaseInfo(),
    }, token);
  }

  /** POST 加密数据到 CDN，返回下载引用 (x-encrypted-param)。 */
  private async uploadBufferToCdn(
    plaintext: Buffer, aeskey: Buffer,
    uploadFullUrl: string | undefined, uploadParam: string | undefined,
    filekey: string,
  ): Promise<string> {
    const ciphertext = encryptAesEcb(plaintext, aeskey);
    const trimmedFull = uploadFullUrl?.trim();
    let cdnUrl: string;
    if (trimmedFull) {
      cdnUrl = trimmedFull;
    } else if (uploadParam) {
      cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
    } else {
      throw new Error('CDN upload URL missing (need upload_full_url or upload_param)');
    }

    const maxRetries = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(cdnUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
        });
        if (res.status >= 400 && res.status < 500) {
          const errMsg = res.headers.get('x-error-message') ?? (await res.text());
          throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
        }
        if (res.status !== 200) {
          const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`;
          throw new Error(`CDN upload server error: ${errMsg}`);
        }
        const downloadParam = res.headers.get('x-encrypted-param');
        if (!downloadParam) throw new Error('CDN upload response missing x-encrypted-param header');
        return downloadParam;
      } catch (err) {
        lastError = err;
        if (err instanceof Error && err.message.includes('client error')) throw err;
        if (attempt < maxRetries) {
          this.ctx.logger.warn(`CDN upload attempt ${attempt} failed, retrying`, { error: String(err) });
          await sleep(1000 * attempt, () => false);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`CDN upload failed after ${maxRetries} attempts`);
  }

  /**
   * 完整的媒体上传管线：读取 Buffer → 生成 AES key → getUploadUrl → CDN upload。
   */
  async uploadMediaToCdn(data: Buffer, toUserId: string, mediaType: number, label: string): Promise<UploadedMediaInfo> {
    const rawsize = data.length;
    const rawfilemd5 = createHash('md5').update(data).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = randomBytes(16).toString('hex');
    const aeskey = randomBytes(16);
    const aeskeyHex = aeskey.toString('hex');

    this.ctx.logger.debug(`${label}: uploading rawsize=${rawsize} filesize=${filesize} mediaType=${mediaType}`);

    const uploadResp = await this.getUploadUrl(toUserId, filekey, mediaType, rawsize, rawfilemd5, filesize, aeskeyHex);
    const downloadParam = await this.uploadBufferToCdn(
      data, aeskey,
      uploadResp.upload_full_url?.trim() || undefined,
      uploadResp.upload_param ?? undefined,
      filekey,
    );

    this.ctx.logger.info(`${label}: CDN upload success filekey=${filekey} size=${rawsize}`);
    return { downloadEncryptedQueryParam: downloadParam, aeskeyHex, fileSize: rawsize, fileSizeCiphertext: filesize };
  }

  // ── 发送消息 ────────────────────────────────────────────────────────────────

  /** 发送纯文本消息。 */
  async sendText(toUserId: string, contextToken: string | undefined, text: string): Promise<void> {
    const baseUrl = await this.ilink.getBaseUrl();
    const token = await this.ilink.getToken();
    if (!baseUrl || !token) throw new Error('WeChat is not logged in');
    const latestToken = (await this.ctx.storage.get<string>(`${CTOKEN_PREFIX}${toUserId}`)) ?? contextToken;
    const clientId = `openclaw-weixin:${Date.now()}-${randomHex(4)}`;
    const resp = await this.ilink.post<SendMessageResponse>(baseUrl, 'ilink/bot/sendmessage', {
      msg: {
        from_user_id: '', to_user_id: toUserId, client_id: clientId,
        message_type: 2, message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: latestToken,
      },
      base_info: this.ilink.buildBaseInfo(),
    }, token);
    if (resp.ret !== undefined && resp.ret !== 0) {
      throw new Error(`sendMessage ret=${resp.ret} ${resp.errmsg ?? ''}`);
    }
  }

  /** 发送单个媒体 item（图片/视频/文件），caption 作为独立 TEXT 先发。 */
  private async sendMediaItem(
    toUserId: string, contextToken: string | undefined,
    item: WeixinMessageItem, caption?: string,
  ): Promise<void> {
    const baseUrl = await this.ilink.getBaseUrl();
    const token = await this.ilink.getToken();
    if (!baseUrl || !token) throw new Error('WeChat is not logged in');
    const latestToken = (await this.ctx.storage.get<string>(`${CTOKEN_PREFIX}${toUserId}`)) ?? contextToken;

    if (caption?.trim()) {
      const captionClientId = `openclaw-weixin:${Date.now()}-${randomHex(4)}`;
      await this.ilink.post<SendMessageResponse>(baseUrl, 'ilink/bot/sendmessage', {
        msg: {
          from_user_id: '', to_user_id: toUserId, client_id: captionClientId,
          message_type: 2, message_state: 2,
          item_list: [{ type: 1, text_item: { text: caption } }],
          context_token: latestToken,
        },
        base_info: this.ilink.buildBaseInfo(),
      }, token);
    }

    const clientId = `openclaw-weixin:${Date.now()}-${randomHex(4)}`;
    const resp = await this.ilink.post<SendMessageResponse>(baseUrl, 'ilink/bot/sendmessage', {
      msg: {
        from_user_id: '', to_user_id: toUserId, client_id: clientId,
        message_type: 2, message_state: 2,
        item_list: [item],
        context_token: latestToken,
      },
      base_info: this.ilink.buildBaseInfo(),
    }, token);
    if (resp.ret !== undefined && resp.ret !== 0) {
      throw new Error(`sendMessage(media) ret=${resp.ret} ${resp.errmsg ?? ''}`);
    }
  }

  async sendImage(toUserId: string, contextToken: string | undefined, data: Buffer, caption?: string): Promise<void> {
    const uploaded = await this.uploadMediaToCdn(data, toUserId, UPLOAD_MEDIA_IMAGE, 'sendImage');
    await this.sendMediaItem(toUserId, contextToken, {
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskeyHex, 'hex').toString('base64'),
          encrypt_type: 1,
        },
        mid_size: uploaded.fileSizeCiphertext,
      },
    }, caption);
  }

  async sendVideo(toUserId: string, contextToken: string | undefined, data: Buffer, caption?: string): Promise<void> {
    const uploaded = await this.uploadMediaToCdn(data, toUserId, UPLOAD_MEDIA_VIDEO, 'sendVideo');
    await this.sendMediaItem(toUserId, contextToken, {
      type: 5,
      video_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskeyHex, 'hex').toString('base64'),
          encrypt_type: 1,
        },
        video_size: uploaded.fileSizeCiphertext,
      },
    }, caption);
  }

  async sendFile(toUserId: string, contextToken: string | undefined, data: Buffer, fileName: string, caption?: string): Promise<void> {
    const uploaded = await this.uploadMediaToCdn(data, toUserId, UPLOAD_MEDIA_FILE, 'sendFile');
    await this.sendMediaItem(toUserId, contextToken, {
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskeyHex, 'hex').toString('base64'),
          encrypt_type: 1,
        },
        file_name: fileName,
        len: String(uploaded.fileSize),
      },
    }, caption);
  }

  /** 根据 MIME 类型自动路由到图片/视频/文件发送。 */
  async sendMediaByMime(toUserId: string, contextToken: string | undefined, data: Buffer, fileName: string, caption?: string): Promise<void> {
    const mime = guessMime(fileName);
    if (mime.startsWith('image/')) {
      await this.sendImage(toUserId, contextToken, data, caption);
    } else if (mime.startsWith('video/')) {
      await this.sendVideo(toUserId, contextToken, data, caption);
    } else {
      await this.sendFile(toUserId, contextToken, data, fileName, caption);
    }
  }

  // ── 入站消息解析 ─────────────────────────────────────────────────────────────

  /** 提取文本 + 语音转文字。 */
  extractText(msg: { item_list?: { type: number; text_item?: { text?: string }; voice_item?: { text?: string } }[] | undefined }): string {
    return (msg.item_list ?? [])
      .map((it) => {
        if (it.type === 1 && it.text_item?.text) return it.text_item.text;
        if (it.type === 3 && it.voice_item?.text) return it.voice_item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  /** 解析图片/文件/视频为 Session 附件（下载+解密→base64）。 */
  async extractAttachments(msg: import('./types').WeixinInboundMessage): Promise<finch.SessionMessageAttachment[]> {
    const out: finch.SessionMessageAttachment[] = [];
    for (const it of msg.item_list ?? []) {
      try {
        if (it.type === 2 && it.image_item?.media?.full_url) {
          const buf = await this.downloadMedia(it.image_item.media, it.image_item.aeskey);
          out.push({ name: `image-${randomHex(4)}.jpg`, mimeType: 'image/jpeg', kind: 'image', data: buf.toString('base64') });
        } else if (it.type === 4 && it.file_item?.media?.full_url) {
          const name = it.file_item.file_name ?? `file-${randomHex(4)}.bin`;
          const mime = guessMime(name);
          const buf = await this.downloadMedia(it.file_item.media);
          out.push({ name, mimeType: mime, kind: attachmentKindFor(mime), data: buf.toString('base64') });
        } else if (it.type === 5 && it.video_item?.media?.full_url) {
          const buf = await this.downloadMedia(it.video_item.media);
          out.push({ name: `video-${randomHex(4)}.mp4`, mimeType: 'video/mp4', kind: 'file', data: buf.toString('base64') });
        }
      } catch (error) {
        this.ctx.logger.warn('media download/decrypt failed', error);
      }
    }
    return out;
  }
}
