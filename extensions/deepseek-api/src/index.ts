import type * as finch from 'finch';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * DeepSeek exposes three raw JSON tool APIs behind the same Bearer key:
 *   POST /v1/tools/search  — web search, structured results
 *   POST /v1/tools/fetch   — read one page as Markdown
 *   POST /v1/tools/ocr     — multipart OCR of PDF / Word / PowerPoint / images
 * One key unlocks all three, so the mini tool collects exactly one secret and
 * presents the capabilities as a single tool with an `action` parameter.
 */
const BASE_URL = 'https://api.deepseek.com';
const API_KEY_SECRET = 'deepseek.apiKey';
/** Documented hard limit of the OCR endpoint. */
const MAX_OCR_BYTES = 100 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 90_000;
/** OCR may legitimately run for 180 s server-side; keep the client slightly above it. */
const OCR_TIMEOUT_MS = 200_000;
/** Guard rails so one tool result cannot flood the model context. */
const MAX_FETCH_CHARS = 30_000;
const MAX_CONTENT_CHARS = 6_000;

/** The OCR endpoint decides the format from the file bytes, but a correct MIME
 *  still helps the multipart parser; unknown extensions fall back to octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

type Json = Record<string, any>;

interface DeepSeekInput {
  action?: 'search' | 'fetch' | 'ocr' | 'status';
  query?: string;
  count?: number;
  need_content?: boolean;
  url?: string;
  path?: string;
  purpose?: string;
}

function t(ctx: finch.MiniToolContext, key: string, values?: Record<string, string | number | boolean>): string {
  return ctx.i18n?.t ? ctx.i18n.t(key, values) : key;
}

function text(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

/** The API key lives in system secure storage only; nothing is cached in ctx.storage. */
async function readApiKey(ctx: finch.MiniToolContext): Promise<string | undefined> {
  const raw = await ctx.secrets.get(API_KEY_SECRET);
  const key = typeof raw === 'string' ? raw.trim() : '';
  return key || undefined;
}

function extractError(data: Json, raw: string): string {
  const nested = data?.error?.message ?? data?.error ?? data?.message ?? data?.detail;
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 300) : 'unknown error';
}

async function postJson(
  ctx: finch.MiniToolContext,
  apiKey: string,
  endpoint: string,
  body: Json,
  timeoutMs: number,
): Promise<Json> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await parseResponse(ctx, res, timeoutMs);
  } catch (err) {
    throw translate(ctx, err, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

async function parseResponse(ctx: finch.MiniToolContext, res: Response, timeoutMs: number): Promise<Json> {
  // OCR streams newline keep-alives before the JSON body; JSON.parse tolerates
  // that leading whitespace, so the raw text is parsed as-is.
  const raw = await res.text();
  let data: Json = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw) as Json;
    } catch {
      data = { message: raw };
    }
  }
  if (!res.ok) throw new Error(t(ctx, 'error.http', { status: res.status, message: extractError(data, raw) }));
  if (data && data.error) throw new Error(extractError(data, raw));
  return data;
}

function translate(ctx: finch.MiniToolContext, err: unknown, timeoutMs: number): Error {
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error(t(ctx, 'error.timeout', { seconds: Math.round(timeoutMs / 1000) }));
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Balance lookup doubles as a cheap "does this key work" probe. */
async function fetchBalance(ctx: finch.MiniToolContext, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${BASE_URL}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const data = await parseResponse(ctx, res, 20_000);
    const balances = Array.isArray(data?.balances) ? data.balances : [];
    if (!balances.length) return t(ctx, 'status.noBalanceInfo');
    return balances
      .map((item: Json) => `${item.type ?? 'balance'}: ${item.total_balance ?? '?'} ${item.currency ?? ''}`.trim())
      .join(' | ');
  } finally {
    clearTimeout(timer);
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function formatSearch(ctx: finch.MiniToolContext, query: string, results: Json[]): string {
  if (!results.length) return t(ctx, 'search.empty', { query });
  const blocks = results.map((item, index) => {
    const meta: string[] = [];
    if (item.site_name) meta.push(String(item.site_name));
    if (item.date) meta.push(String(item.date).slice(0, 10));
    if (typeof item.rerank_score === 'number') meta.push(`rerank ${item.rerank_score}`);
    const lines = [`${index + 1}. ${item.title || '(untitled)'}`, `   ${item.url}`];
    if (meta.length) lines.push(`   ${meta.join(' · ')}`);
    const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
    if (summary) lines.push(`   ${summary.replace(/\s+/g, ' ')}`);
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (content) {
      lines.push('');
      lines.push(content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}\n…(truncated)` : content);
    }
    return lines.join('\n');
  });
  return `${t(ctx, 'search.header', { count: results.length, query })}\n\n${blocks.join('\n\n')}`;
}

/** OCR accepts a local path or a remote URL; both end up as an uploadable Blob + filename. */
async function readOcrInput(
  ctx: finch.MiniToolContext,
  input: DeepSeekInput,
): Promise<{ blob: Blob; filename: string }> {
  const localPath = String(input.path ?? '').trim();
  if (localPath) {
    const abs = path.resolve(localPath);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new Error(t(ctx, 'error.ocrNotFile', { path: abs }));
    if (stat.size > MAX_OCR_BYTES) throw new Error(t(ctx, 'error.ocrTooLarge', { size: stat.size }));
    const buf = await fs.readFile(abs);
    const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    return { blob: new Blob([buf], { type: mime }), filename: path.basename(abs) };
  }

  const remote = String(input.url ?? '').trim();
  if (remote) {
    const res = await fetch(remote);
    if (!res.ok) throw new Error(t(ctx, 'error.http', { status: res.status, message: remote }));
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_OCR_BYTES) throw new Error(t(ctx, 'error.ocrTooLarge', { size: buffer.byteLength }));
    let filename = 'image.png';
    try {
      const name = path.basename(new URL(remote).pathname);
      if (name && name.includes('.')) filename = name;
    } catch {
      // Keep the default file name for unparseable URLs.
    }
    const mime = MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
    return { blob: new Blob([buffer], { type: mime }), filename };
  }

  throw new Error(t(ctx, 'error.ocrNoInput'));
}

async function runOcr(ctx: finch.MiniToolContext, apiKey: string, input: DeepSeekInput, exec: any): Promise<string> {
  const purpose = input.purpose === 'rich_layout_recognition' ? 'rich_layout_recognition' : 'text_recognition';
  const { blob, filename } = await readOcrInput(ctx, input);
  // exec is always provided by Finch; the guard keeps a direct call from throwing.
  exec?.progress?.report({ message: t(ctx, 'ocr.progress', { filename }) });

  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', blob, filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
  let data: Json;
  try {
    // No manual Content-Type here: fetch must generate the multipart boundary.
    const res = await fetch(`${BASE_URL}/v1/tools/ocr`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    data = await parseResponse(ctx, res, OCR_TIMEOUT_MS);
  } catch (err) {
    throw translate(ctx, err, OCR_TIMEOUT_MS);
  } finally {
    clearTimeout(timer);
  }

  const pages = Array.isArray(data.pages) ? data.pages : [];
  if (!pages.length) return t(ctx, 'ocr.empty', { filename });
  const body = pages
    .map((page: Json) => {
      const note = page.finish_reason === 'length' ? ` (${t(ctx, 'ocr.incomplete')})` : '';
      return `--- ${t(ctx, 'ocr.page', { index: Number(page.index ?? 0) + 1 })}${note} ---\n${String(page.text ?? '')}`;
    })
    .join('\n\n');
  const usage = data.usage ?? {};
  const tail = typeof usage.total_tokens === 'number'
    ? `\n\n${t(ctx, 'ocr.usage', { input: usage.input_tokens ?? '?', output: usage.output_tokens ?? '?' })}`
    : '';
  return `${t(ctx, 'ocr.header', { filename, pages: data.page_count ?? pages.length, purpose })}\n\n${body}${tail}`;
}

function registerSettingsMenu(ctx: finch.MiniToolContext): void {
  const menu = ctx.settingsMenu.register({
    async getMenu() {
      const configured = Boolean(await readApiKey(ctx));
      const rows = [
        {
          id: 'status',
          label: t(ctx, 'settings.status.label'),
          description: t(ctx, configured ? 'settings.status.configured' : 'settings.status.unconfigured'),
          iconName: configured ? 'toggle-right' : 'toggle-left',
          disabled: true,
        },
        { id: 'divider', label: '', separator: true },
        {
          id: 'configure',
          label: t(ctx, configured ? 'settings.configure.update' : 'settings.configure.add'),
          iconName: 'settings',
          hoverText: t(ctx, 'settings.configure.hover'),
        },
      ];
      if (configured) {
        rows.push({ id: 'clearDivider', label: '', separator: true } as never);
        rows.push({
          id: 'clear',
          label: t(ctx, 'settings.clear'),
          iconName: 'trash-2',
          hoverText: t(ctx, 'settings.clear.hover'),
        } as never);
      }
      return rows;
    },

    async execute(_menuContext, itemId) {
      if (itemId === 'clear') {
        const result = await ctx.ui.showModalDialog({
          title: t(ctx, 'settings.clearDialog.title'),
          message: t(ctx, 'settings.clearDialog.message'),
          actions: [
            { id: 'cancel', label: t(ctx, 'settings.dialog.cancel') },
            { id: 'clear', label: t(ctx, 'settings.clearDialog.confirm'), variant: 'primary' },
          ],
        });
        if (result.action !== 'clear') return;
        await ctx.secrets.delete(API_KEY_SECRET);
        menu.notifyUpdate();
        await ctx.ui.showToast({ title: t(ctx, 'toast.cleared.title'), description: t(ctx, 'toast.cleared.description'), variant: 'info' });
        return;
      }

      if (itemId !== 'configure') return;
      const result = await ctx.ui.showModalDialog({
        title: t(ctx, 'settings.dialog.title'),
        message: t(ctx, 'settings.dialog.message'),
        actions: [
          { id: 'cancel', label: t(ctx, 'settings.dialog.cancel') },
          { id: 'save', label: t(ctx, 'settings.dialog.save'), variant: 'primary' },
        ],
        fields: [{
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          secret: true,
          required: true,
          placeholder: 'sk-…',
          description: t(ctx, 'form.setup.apiKey.description'),
        }],
      });
      if (result.action !== 'save') return;

      const apiKey = String(result.values?.apiKey ?? '').trim();
      if (!apiKey) return;
      await ctx.secrets.set(API_KEY_SECRET, apiKey);
      menu.notifyUpdate();
      await ctx.ui.showToast({ title: t(ctx, 'toast.saved.title'), description: t(ctx, 'toast.saved.description'), variant: 'success' });
    },
  });
  ctx.subscriptions.push(menu);
}

function registerSetupTool(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'setup_deepseek_api',
    title: 'Set up DeepSeek API',
    description: 'Collect the DeepSeek API key through a secure form and store it in system secure storage. Call this when deepseek_api reports that no key is configured, or when the user asks to connect or replace the DeepSeek key.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'medium',
    async execute(_input, exec) {
      const result = await exec.ui.requestForm({
        title: t(ctx, 'form.setup.title'),
        description: t(ctx, 'form.setup.description'),
        submitLabel: t(ctx, 'form.setup.submit'),
        fields: [{
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          secret: true,
          required: true,
          placeholder: 'sk-…',
          description: t(ctx, 'form.setup.apiKey.description'),
        }],
      });

      if (!result.submitted) {
        return text(t(ctx, 'setup.cancelled', { reason: result.reason ?? 'cancelled' }));
      }
      const apiKey = String(result.values.apiKey ?? '').trim();
      if (!apiKey) return text(t(ctx, 'setup.noKey'), true);

      await ctx.secrets.set(API_KEY_SECRET, apiKey);
      let validation: string;
      try {
        validation = t(ctx, 'setup.verified', { balance: await fetchBalance(ctx, apiKey) });
      } catch (err) {
        validation = t(ctx, 'setup.unverified', { message: err instanceof Error ? err.message : String(err) });
      }
      await ctx.ui.showToast({ title: t(ctx, 'toast.saved.title'), description: t(ctx, 'toast.saved.description'), variant: 'success' });
      return text(t(ctx, 'setup.saved', { validation }));
    },
  }));
}

function registerApiTool(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'deepseek_api',
    title: 'DeepSeek API',
    description: `DeepSeek tool APIs behind a single API key: web search, page reading, and OCR.
action:
  search — search the web by query, returns ranked results with url, snippet, summary and optional full content
  fetch  — read one web page and return its Markdown content
  ocr    — recognize text in a local file or image (PDF, Word, PowerPoint, PNG/JPEG/WebP/GIF/BMP/TIFF)
  status — report whether an API key is configured and show the account balance
If the tool reports no API key, call setup_deepseek_api first.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'fetch', 'ocr', 'status'] },
        query: { type: 'string', description: 'search: 1–128 characters. Supports site:, -site:, and quoted phrases.' },
        count: { type: 'number', description: 'search: number of results, 1–20, default 5.' },
        need_content: { type: 'boolean', description: 'search: also return full page content per result, default false.' },
        url: { type: 'string', description: 'fetch: page to read. ocr: alternative to path for a remote file.' },
        path: { type: 'string', description: 'ocr: absolute path to a local file (max 100 MiB).' },
        purpose: {
          type: 'string',
          enum: ['text_recognition', 'rich_layout_recognition'],
          description: 'ocr: text_recognition (default) or rich_layout_recognition (page-by-page layout with coordinates).',
        },
      },
      required: ['action'],
    },
    // OCR runs up to 180 s server-side, so the platform timeout must cover it.
    timeoutMs: 240_000,
    risk: 'medium',
    async execute(input, exec) {
      const args = (input ?? {}) as DeepSeekInput;
      const apiKey = await readApiKey(ctx);
      if (!apiKey) return text(t(ctx, 'error.noKey'), true);

      try {
        switch (args.action) {
          case 'search': {
            const query = String(args.query ?? '').trim();
            if (!query) throw new Error(t(ctx, 'error.missingParam', { param: 'query' }));
            const length = Array.from(query).length;
            if (length > 128) throw new Error(t(ctx, 'error.queryLength', { length }));
            const data = await postJson(ctx, apiKey, '/v1/tools/search', {
              query,
              count: clampNumber(args.count, 5, 1, 20),
              need_content: args.need_content === true,
            }, SEARCH_TIMEOUT_MS);
            return text(formatSearch(ctx, query, Array.isArray(data.results) ? data.results : []));
          }
          case 'fetch': {
            const url = String(args.url ?? '').trim();
            if (!url) throw new Error(t(ctx, 'error.missingParam', { param: 'url' }));
            const data = await postJson(ctx, apiKey, '/v1/tools/fetch', { url }, FETCH_TIMEOUT_MS);
            const title = String(data.title ?? '').trim();
            let content = String(data.content ?? '');
            if (content.length > MAX_FETCH_CHARS) content = `${content.slice(0, MAX_FETCH_CHARS)}\n…(truncated)`;
            // DeepSeek often already starts the Markdown body with the page title,
            // so only prepend it when it is genuinely missing.
            const needsTitle = title && !content.trimStart().startsWith(`# ${title}`) && !content.trimStart().startsWith(title);
            return text(`${needsTitle ? `# ${title}\n\n` : ''}${content}`);
          }
          case 'ocr':
            return text(await runOcr(ctx, apiKey, args, exec));
          case 'status': {
            const lines = [t(ctx, 'settings.status.configured')];
            try {
              lines.push(await fetchBalance(ctx, apiKey));
            } catch (err) {
              lines.push(t(ctx, 'status.balanceFailed', { message: err instanceof Error ? err.message : String(err) }));
            }
            return text(lines.join('\n'));
          }
          default:
            return text(t(ctx, 'error.unknownAction', { action: String(args.action ?? '') }), true);
        }
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    },
  }));
}

export function activate(ctx: finch.MiniToolContext): void {
  ctx.logger.info('DeepSeek API extension activated');
  registerSettingsMenu(ctx);
  registerSetupTool(ctx);
  registerApiTool(ctx);
}

export function deactivate(): void {
  // Nothing to tear down: the key lives in secure storage and every disposable
  // (tools, settings menu) was pushed to ctx.subscriptions.
}
