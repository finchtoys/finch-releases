import { createCipheriv, createDecipheriv } from 'node:crypto';
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

/** n 字节的随机十六进制串，用于生成唯一 client_id。 */
export const randomHex = (bytes: number): string =>
  Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join('');

/** X-WECHAT-UIN header：随机 uint32 → 十进制字符串 → base64。 */
export const randomWechatUin = (): string =>
  Buffer.from(String(Math.floor(Math.random() * 0xffffffff)), 'utf8').toString('base64');

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

// ─────────────────────────────────────────────────────────────────────────────
// AES-128-ECB 加解密
// ─────────────────────────────────────────────────────────────────────────────

/** aes_key 有两种编码：base64(raw 16 字节) 或 base64(hex 32 字符)。 */
export const parseAesKey = (aesKeyBase64: string): Buffer => {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`Invalid aes_key: decoded to ${decoded.length} bytes`);
};

export const decryptAesEcb = (ciphertext: Buffer, key: Buffer): Buffer => {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

export const encryptAesEcb = (plaintext: Buffer, key: Buffer): Buffer => {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
};

/** 计算 AES-128-ECB PKCS7 填充后的密文大小。 */
export const aesEcbPaddedSize = (plaintextSize: number): number =>
  Math.ceil((plaintextSize + 1) / 16) * 16;
