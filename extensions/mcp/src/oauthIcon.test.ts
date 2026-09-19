import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { mcpOAuthIconUrl } from './oauthIcon.js';

describe('MCP 固定授权图标', () => {
  it('支持内置和 scoped provider 的受信任图标 URI', () => {
    expect(mcpOAuthIconUrl('mcp')).toBe('finch-ext-icon://mcp/assets/mcp-oauth.png');
    expect(mcpOAuthIconUrl('finchtoys@mcp-client')).toBe('finch-ext-icon://finchtoys/mcp-client/assets/mcp-oauth.png');
  });
  it('随包携带有效的透明 PNG，而不是远程图标', () => {
    const png = readFileSync(new URL('../assets/mcp-oauth.png', import.meta.url));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(128);
    expect(png.readUInt32BE(20)).toBe(128);
    const chunks: Buffer[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    const raw = inflateSync(Buffer.concat(chunks));
    const alphas: number[] = [];
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) alphas.push(raw[y * 513 + 1 + x * 4 + 3]);
    expect(Math.min(...alphas)).toBe(0);
    expect(Math.max(...alphas)).toBe(255);
  });
});
