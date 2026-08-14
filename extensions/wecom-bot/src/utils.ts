import type { WsFrame } from '@wecom/aibot-node-sdk';
import type { WeComPeer } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 通用工具函数（对齐 WeCom Box 更新版实现）
// ─────────────────────────────────────────────────────────────────────────────

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 剥离群聊消息开头的 @机器人 前缀。
 * - 提供 botName 时按 `@名字` 字面量前缀精确剥离（兼容有/无空格）；
 *   剥离后为空（纯 @ 消息）时保留原文。
 * - 未提供时做保守的通用剥离：token 后需是空格/标点/结尾；剥离后为空则保留原文。
 */
export function stripBotMention(text: string, botName?: string): string {
  const value = text.trim();
  if (!value.startsWith('@')) return value;
  const name = botName?.trim();
  if (name) {
    const match = value.match(new RegExp(`^@${escapeRegExp(name)}`));
    if (match) {
      const rest = value.slice(match[0].length).trim();
      return rest || value;
    }
  }
  const generic = value.match(/^@([^\s@，,。:：]{1,32})(?=[\s，,。:：]|$)/);
  if (!generic) return value;
  return value.slice(generic[0].length).trim() || value;
}

/** 根据文件名推断企微媒体类型（file/image/voice/video）。 */
export function mediaTypeFor(fileName: string): 'file' | 'image' | 'voice' | 'video' {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif'].includes(ext)) return 'image';
  if (ext === 'mp4') return 'video';
  if (ext === 'amr') return 'voice';
  return 'file';
}

/** 存储键安全编码（base64url）。 */
export function safeKey(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** 从企微消息帧解析对端；无法解析（缺 userid / 群聊缺 chatid）时返回 undefined。 */
export function peerFromMessage(message: WsFrame['body'] & { from?: { userid?: string } }): WeComPeer | undefined {
  const userId = message?.from?.userid?.trim();
  if (!userId) return undefined;
  if (message.chattype === 'group') {
    const chatId = message.chatid?.trim();
    if (!chatId) return undefined;
    return { key: `group:${chatId}`, chatId, chatType: 'group', userId };
  }
  return { key: `single:${userId}`, chatId: userId, chatType: 'single', userId };
}

/** 按媒体 kind 与文件名推断 MIME。 */
export function mimeFor(kind: 'image' | 'video' | 'voice' | 'file', fileName?: string): string {
  const ext = (fileName ?? '').toLowerCase().split('.').pop();
  if (kind === 'image') {
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    return 'image/jpeg';
  }
  if (kind === 'video') return 'video/mp4';
  if (kind === 'voice') return 'audio/amr';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'txt' || ext === 'md') return 'text/plain';
  return 'application/octet-stream';
}

/** MIME → Finch 附件 kind。 */
export function attachmentKind(mimeType: string): 'image' | 'pdf' | 'text' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('text/')) return 'text';
  return 'file';
}

/** 超长内容按 UTF-8 字节截断（企微单条回复上限），并附加截断标记。 */
export function truncateUtf8(text: string, maxBytes = 20_000): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = text;
  while (out && Buffer.byteLength(`${out}\n\n（内容已截断）`) > maxBytes) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return `${out}\n\n（内容已截断）`;
}

/** 错误归一化为字符串。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
