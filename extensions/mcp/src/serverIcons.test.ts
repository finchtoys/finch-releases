import { describe, expect, it, vi } from 'vitest';
import { McpServerIconResolver, normalizeMcpServerIcons } from './serverIcons.js';

describe('normalizeMcpServerIcons', () => {
  it('保留 MCP 2025-11-25 的安全 HTTPS 与栅格 Data URL 图标', () => {
    expect(normalizeMcpServerIcons([
      { src: 'https://cdn.example/icon.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'light' },
      { src: 'data:image/png;base64,iVBORw0KGgo=' },
    ])).toEqual([
      { src: 'https://cdn.example/icon.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'light' },
      { src: 'data:image/png;base64,iVBORw0KGgo=' },
    ]);
  });

  it('过滤非 HTTPS、带凭据、脚本和超长图标来源', () => {
    expect(normalizeMcpServerIcons([
      { src: 'http://cdn.example/icon.png' },
      { src: 'https://user:secret@cdn.example/icon.png' },
      { src: 'javascript:alert(1)' },
      { src: 'data:image/svg+xml;base64,PHN2Zz4=' },
    ])).toEqual([]);
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const publicResolver = async () => ['203.0.113.10'];

describe('McpServerIconResolver', () => {
  it('在 MCP 小程序内下载图标并缓存安全 Data URL', async () => {
    const fetch = vi.fn(async () => new Response(PNG, { status: 200 }));
    const resolver = new McpServerIconResolver({ fetch, resolveAddresses: publicResolver });
    const icons = [{ src: 'https://cdn.example/mcp.png' }];

    const first = await resolver.resolve(icons);
    const second = await resolver.resolve(icons);

    expect(first).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('拦截私网目标和跨域重定向', async () => {
    const privateFetch = vi.fn();
    const privateResolver = new McpServerIconResolver({
      fetch: privateFetch,
      resolveAddresses: async () => ['127.0.0.1'],
    });
    await expect(privateResolver.resolve([{ src: 'https://internal.example/icon.png' }])).resolves.toBeUndefined();
    expect(privateFetch).not.toHaveBeenCalled();

    const redirectFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://tracker.example/icon.png' },
    }));
    const redirectResolver = new McpServerIconResolver({ fetch: redirectFetch, resolveAddresses: publicResolver });
    await expect(redirectResolver.resolve([{ src: 'https://cdn.example/icon.png' }])).resolves.toBeUndefined();
    expect(redirectFetch).toHaveBeenCalledOnce();
  });
});
