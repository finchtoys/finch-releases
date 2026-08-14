import type * as finch from 'finch';

// ─────────────────────────────────────────────────────────────────────────────
// 通用工具函数
// ─────────────────────────────────────────────────────────────────────────────

/** 可取消的 sleep：每 250ms 检查一次取消标志。 */
export function sleep(ms: number, cancelled: () => boolean): Promise<void> {
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

/** n 字节的随机十六进制串。 */
export const randomHex = (bytes: number): string =>
  Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join('');

/** 从文件名猜 MIME。 */
export const guessMime = (name: string): string => {
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

export const attachmentKindFor = (mime: string): finch.SessionMessageAttachmentKind =>
  mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : mime.startsWith('text/') ? 'text' : 'file';

/** 正则转义（用于按机器人名精确匹配 @前缀）。 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 剥离群聊消息开头的 @机器人 前缀。
 *
 * - 提供 botName 时按 `@名字` 字面量前缀精确剥离（兼容有/无空格场景，
 *   如 "@Finch 帮我" 与 "@Finch帮我"）；剥离后为空（纯 @ 消息）时保留原文。
 * - 未提供 botName 时做保守的通用剥离：只剥第一个 token，
 *   且要求 token 后是空格/标点/结尾（防止吞掉正文）。
 */
export function stripBotMention(text: string, botName?: string): string {
  let t = text.trim();
  if (!t.startsWith('@')) return t;
  if (botName) {
    const exact = new RegExp(`^@${escapeRegExp(botName)}`);
    const exactMatch = t.match(exact);
    if (exactMatch) {
      const rest = t.slice(exactMatch[0].length).trim();
      return rest || t;
    }
  }
  const mentionRe = /^@([^\s@，,。:：]{1,32})(?=[\s，,。:：]|$)/;
  const match = t.match(mentionRe);
  if (!match) return t;
  return t.slice(match[0].length).trim();
}

/** 把会话标题里的冒号等不友好字符清理掉。 */
export function sanitizeTitle(label: string): string {
  return label.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40);
}

/** 生成唯一 idempotencyKey 的辅助。 */
export function idempotencyKey(prefix: string): string {
  return `${prefix}:${Date.now()}-${randomHex(4)}`;
}
