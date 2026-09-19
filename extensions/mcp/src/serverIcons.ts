import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { McpServerIcon } from './client.js';

const MAX_ICON_BYTES = 256 * 1024;
const MAX_STANDARD_ICON_DATA_URL_LENGTH = 350_000;
const MAX_STANDARD_ICON_URL_LENGTH = 2_048;
const MAX_REDIRECTS = 2;
const REQUEST_TIMEOUT_MS = 3_000;
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000;
const FAILURE_TTL_MS = 10 * 60 * 1_000;
const SAFE_ICON_DATA_URL = /^data:image\/(?:png|jpe?g|webp);base64,([a-z0-9+/]+=*)$/i;

interface CacheEntry {
  expiresAt: number;
  value?: string;
  pending?: Promise<string | undefined>;
}

export interface McpServerIconResolverDependencies {
  fetch?: typeof globalThis.fetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  now?: () => number;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized === '::' || normalized === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff');
}

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((record) => record.address);
}

function detectedImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return undefined;
}

function normalizeDataUrl(value: string): string | undefined {
  if (value.length > MAX_STANDARD_ICON_DATA_URL_LENGTH) return undefined;
  const match = SAFE_ICON_DATA_URL.exec(value);
  if (!match) return undefined;
  const bytes = Buffer.from(match[1], 'base64');
  const mime = detectedImageMime(bytes);
  return mime && bytes.byteLength <= MAX_ICON_BYTES
    ? `data:${mime};base64,${bytes.toString('base64')}`
    : undefined;
}

async function readLimitedBody(response: Response): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ICON_BYTES) throw new Error('MCP icon is too large');
  if (!response.body) throw new Error('MCP icon response is empty');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ICON_BYTES) throw new Error('MCP icon is too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Keep only bounded Icon records from MCP 2025-11-25 serverInfo.icons. */
export function normalizeMcpServerIcons(value: readonly McpServerIcon[] | undefined): McpServerIcon[] {
  if (!Array.isArray(value)) return [];
  const icons: McpServerIcon[] = [];
  for (const candidate of value.slice(0, 8)) {
    if (!candidate || typeof candidate.src !== 'string') continue;
    const src = candidate.src.trim();
    const safeData = src.length <= MAX_STANDARD_ICON_DATA_URL_LENGTH && SAFE_ICON_DATA_URL.test(src);
    let safeHttps = false;
    if (!safeData && src.length <= MAX_STANDARD_ICON_URL_LENGTH) {
      try {
        const url = new URL(src);
        safeHttps = url.protocol === 'https:' && !url.username && !url.password;
      } catch {
        safeHttps = false;
      }
    }
    if (!safeData && !safeHttps) continue;
    icons.push({
      src,
      ...(typeof candidate.mimeType === 'string' ? { mimeType: candidate.mimeType } : {}),
      ...(Array.isArray(candidate.sizes)
        ? { sizes: candidate.sizes.filter((size: unknown): size is string => typeof size === 'string').slice(0, 16) }
        : {}),
      ...(candidate.theme === 'light' || candidate.theme === 'dark' ? { theme: candidate.theme } : {}),
    });
  }
  return icons;
}

/** Resolves MCP-declared icon sources before any result leaves the MCP mini tool. */
export class McpServerIconResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly resolveAddresses: (hostname: string) => Promise<string[]>;
  private readonly now: () => number;

  constructor(dependencies: McpServerIconResolverDependencies = {}) {
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.resolveAddresses = dependencies.resolveAddresses ?? defaultResolveAddresses;
    this.now = dependencies.now ?? Date.now;
  }

  async resolve(icons: readonly McpServerIcon[]): Promise<string | undefined> {
    for (const icon of icons.slice(0, 3)) {
      const resolved = await this.get(icon.src);
      if (resolved) return resolved;
    }
    return undefined;
  }

  private async get(source: string): Promise<string | undefined> {
    const dataUrl = normalizeDataUrl(source);
    if (dataUrl) return dataUrl;
    let target: URL;
    try {
      target = new URL(source);
    } catch {
      return undefined;
    }
    if (source.length > MAX_STANDARD_ICON_URL_LENGTH || target.protocol !== 'https:' || target.username || target.password) return undefined;
    const key = target.toString();
    const cached = this.cache.get(key);
    if (cached?.pending) return cached.pending;
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const pending = this.fetchIcon(target).catch(() => undefined);
    this.cache.set(key, { expiresAt: 0, pending });
    const value = await pending;
    this.cache.set(key, { value, expiresAt: this.now() + (value ? SUCCESS_TTL_MS : FAILURE_TTL_MS) });
    return value;
  }

  private async fetchIcon(initialUrl: URL): Promise<string> {
    let target = initialUrl;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await this.assertPublicHost(target.hostname);
      const response = await this.fetchImpl(target, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: 'image/png,image/jpeg,image/webp' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === MAX_REDIRECTS) throw new Error('Invalid MCP icon redirect');
        const redirected = new URL(location, target);
        if (redirected.origin !== initialUrl.origin || redirected.protocol !== 'https:'
          || redirected.username || redirected.password) throw new Error('Cross-origin MCP icon redirect');
        target = redirected;
        continue;
      }
      if (!response.ok) throw new Error(`MCP icon request failed (${response.status})`);
      const bytes = await readLimitedBody(response);
      const mime = detectedImageMime(bytes);
      if (!mime) throw new Error('Unsupported MCP icon format');
      return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    }
    throw new Error('Too many MCP icon redirects');
  }

  private async assertPublicHost(hostname: string): Promise<void> {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost')
      || (isIP(normalized) !== 0 && isPrivateAddress(normalized))) throw new Error('Private MCP icon host is not allowed');
    const addresses = await this.resolveAddresses(normalized);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error('Private MCP icon host is not allowed');
  }
}
