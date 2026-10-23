import { readFile } from 'node:fs/promises';
import type * as finch from 'finch';
import { KEY_OWNER_USER } from './types';
import type { MediaManager } from './media';

/** Rejections use the host's exception path; never return a normal-looking result for failed delivery. */
export async function executeWechatSend(
  ctx: finch.MiniToolContext, media: MediaManager, rawInput: unknown, signal?: AbortSignal,
): Promise<finch.ToolResult> {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : '';
  const imageUrl = typeof input.imageUrl === 'string' ? input.imageUrl.trim() : '';
  const requestedRecipient = typeof input.recipient === 'string' ? input.recipient.trim() : '';
  if (!message && !filePath && !imageUrl) throw new Error('Provide message, filePath, or imageUrl.');
  const recipient = requestedRecipient || await ctx.storage.get<string>(KEY_OWNER_USER) || '';
  if (!recipient) throw new Error('No recipient is known. Log in to WeChat first or provide recipient.');
  try {
    await media.assertCanSend(recipient, signal);
    if (filePath) {
      const data = await readFile(filePath);
      await media.sendMediaByMime(recipient, data, filePath.split('/').pop() ?? 'file', message || undefined, signal);
    } else if (imageUrl) {
      const res = await fetch(imageUrl, { signal });
      if (!res.ok) throw new Error(`Failed to download media: HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') ?? '';
      const fileName = new URL(imageUrl).pathname.split('/').pop() || (contentType.startsWith('image/') ? 'image.jpg' : 'file');
      await media.sendMediaByMime(recipient, data, fileName, message || undefined, signal);
    } else {
      await media.sendText(recipient, message, signal);
    }
    return { content: [{ type: 'text', text: 'WeChat accepted the send request(s). This is not a device delivery receipt.' }] };
  } catch (error) {
    let detail = error instanceof Error ? error.message : String(error);
    for (const value of [message, filePath, imageUrl, recipient]) {
      if (value) detail = detail.split(value).join('[redacted]');
    }
    throw new Error(`Failed to send WeChat message: ${detail}`);
  }
}
