import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  http: [] as Array<{ url: URL; options: { authProvider?: unknown; requestInit?: { headers?: Record<string, string> } } }>,
  stdio: [] as Array<{ command: string; args?: string[]; env?: Record<string, string> }>,
}));

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    async connect() {}
    async close() {}
    getServerCapabilities() { return {}; }
    getServerVersion() { return { name: 'test', version: '1' }; }
  },
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: typeof captured.http[number]['options']) {
      captured.http.push({ url, options });
    }
  },
}));
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: class {
    constructor(options: typeof captured.stdio[number]) { captured.stdio.push(options); }
  },
}));

import { createMcpClient } from './client.js';

beforeEach(() => {
  captured.http.length = 0;
  captured.stdio.length = 0;
});

describe('MCP HTTP 查询参数模板', () => {
  it('连接时编码查询参数，并保留基础 URL 和原配置不变', async () => {
    const config = {
      name: 'query-service',
      url: 'https://example.com/mcp?tenant=one',
      queryParams: { apiKey: '${KEY}' },
      env: { KEY: 'a+b & c/中文' },
    };
    const before = structuredClone(config);
    const client = createMcpClient(config);
    await client.connect();
    expect(captured.http[0].url.searchParams.get('tenant')).toBe('one');
    expect(captured.http[0].url.searchParams.get('apiKey')).toBe('a+b & c/中文');
    expect(config).toEqual(before);
    expect(config.url).not.toContain('apiKey');
    client.close();
  });

  it('查询参数和请求头使用同一套环境变量展开规则', async () => {
    const client = createMcpClient({
      name: 'query-service',
      url: 'https://example.com/mcp?apiKey=old',
      queryParams: { apiKey: '${KEY}', optional: '${FINCH_TEST_MISSING_QUERY_VALUE}' },
      headers: { 'X-Tenant': '${TENANT}' },
      env: { KEY: 'new', TENANT: 'one', FINCH_TEST_MISSING_QUERY_VALUE: '' },
    });
    await client.connect();
    expect(captured.http[0].url.searchParams.getAll('apiKey')).toEqual(['new']);
    expect(captured.http[0].url.searchParams.get('optional')).toBe('');
    expect(captured.http[0].options.requestInit?.headers).toEqual({ 'X-Tenant': 'one' });
    client.close();
  });

  it('不配置查询参数时保持已有 transport 与授权 provider 传递', async () => {
    const provider = { marker: true };
    const client = createMcpClient({ name: 'legacy', url: 'https://example.com/mcp?tenant=one' }, provider as never);
    await client.connect();
    expect(captured.http[0].url.toString()).toBe('https://example.com/mcp?tenant=one');
    expect(captured.http[0].options.authProvider).toBe(provider);
    client.close();
  });

  it('不改变 stdio 启动参数', async () => {
    const client = createMcpClient({ name: 'local', command: 'node', args: ['server.js'], env: { LOCAL: 'value' } });
    await client.connect();
    expect(captured.http).toEqual([]);
    expect(captured.stdio[0]).toMatchObject({ command: 'node', args: ['server.js'], env: { LOCAL: 'value' } });
    client.close();
  });
});
