import type * as finch from 'finch';
import { WeComTransport, type RawInbound } from './wecom-client';
import { randomHex, guessMime, attachmentKindFor } from './utils';

/**
 * 媒体管理器：入站媒体下载解密 → Finch Session 附件；本地文件 → 企微 media_id。
 *
 * 入站：企微的图片/文件/视频 url 均为 AES-256-CBC 加密（aeskey 每文件独立），
 * 必须在 5 分钟有效期内下载并解密，转成 Finch 附件（base64）交给模型。
 * 出站：Finch 回复中的本地图片先上传为临时素材（media_id），再通过回复/主动推送发送。
 */
export class MediaManager {
  constructor(
    private ctx: finch.MiniToolContext,
    private getTransport: () => WeComTransport | undefined,
  ) {}

  private requireTransport(): WeComTransport {
    const t = this.getTransport();
    if (!t) throw new Error('WeCom is not connected');
    return t;
  }

  /** 把入站媒体下载解密为 Finch Session 附件。 */
  async extractAttachments(inbound: RawInbound): Promise<finch.SessionMessageAttachment[]> {
    const out: finch.SessionMessageAttachment[] = [];
    for (const item of inbound.media) {
      try {
        const { buffer, filename } = await this.requireTransport().downloadMedia(item.url, item.aeskey);
        const name = filename ?? item.name ?? defaultNameFor(item.kind);
        const mime = guessMime(name);
        out.push({
          name,
          mimeType: mime,
          kind: attachmentKindFor(mime),
          data: buffer.toString('base64'),
        });
      } catch (error) {
        this.ctx.logger.warn('wecom media download/decrypt failed', { kind: item.kind, error: String(error) });
      }
    }
    return out;
  }

  /** 回复媒体（基于收到消息的帧，透传 req_id）。 */
  async replyMedia(frame: Parameters<WeComTransport['replyMedia']>[0], data: Buffer, fileName: string): Promise<void> {
    await this.requireTransport().replyMedia(frame, data, fileName);
  }

  /** 主动推送媒体。 */
  async sendMedia(peerKey: string, data: Buffer, fileName: string): Promise<void> {
    await this.requireTransport().sendMedia(peerKey, data, fileName);
  }
}

function defaultNameFor(kind: RawInbound['media'][number]['kind']): string {
  switch (kind) {
    case 'image': return `image-${randomHex(4)}.jpg`;
    case 'video': return `video-${randomHex(4)}.mp4`;
    default: return `file-${randomHex(4)}.bin`;
  }
}
