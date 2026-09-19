import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authorize, createProvider, connect } = vi.hoisted(() => ({
  authorize: vi.fn(async () => undefined),
  createProvider: vi.fn(async () => ({})),
  connect: vi.fn(async () => undefined),
}));
vi.mock('./oauth.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./oauth.js')>(),
  authorizeMcpOAuth: authorize,
  createMcpOAuthProvider: createProvider,
}));
vi.mock('./client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./client.js')>(),
  createMcpClient: () => ({
    connect, close() {}, capabilities: {}, serverInfo: undefined,
    async listTools() { return []; }, onNotification() {},
  }),
}));

const { activate, deactivate } = await import('./index.js');
type Capability = Record<string, (...args: unknown[]) => Promise<unknown>>;
type Execute = (input: unknown, exec: unknown) => Promise<unknown>;
const directories: string[] = [];
const cleanups: Array<() => void> = [];
const endpoint = 'https://example.com/mcp';

beforeEach(() => {
  authorize.mockClear();
  createProvider.mockClear();
  connect.mockClear();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  deactivate();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(enabled = true, oauthOverrides: Record<string, unknown> = {}) {
  const storagePath = mkdtempSync(join(tmpdir(), 'finch-mcp-oauth-management-'));
  directories.push(storagePath);
  const file = join(storagePath, 'servers.json');
  const oauth = {
    id: 'account', providerName: 'service', clientName: 'Finch',
    scopes: ['read', 'write'], providerIcon: 'finch-ext-icon://notion/icon.png',
    ...oauthOverrides,
  };
  writeFileSync(file, JSON.stringify({ servers: [{ name: 'service', url: endpoint, oauth, enabled }] }));
  let capability: Capability = {};
  let execute: Execute | undefined;
  const subscriptions: Array<{ dispose(): void }> = [];
  const disposable = () => ({ dispose() {} });
  const ctx = {
    storagePath, subscriptions, minitool: { id: 'mcp' },
    capabilityStoragePaths: { 'mcp.client': storagePath },
    capabilityMigration: { sources: () => [], readSecret: async () => undefined },
    storage: { keys: async () => [] },
    oauth: {},
    secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    i18n: { t: (key: string) => key },
    minitools: { listContributions: () => [] },
    tools: {
      register: (definition: { name: string; execute: Execute }) => {
        if (definition.name === 'MCP') execute = definition.execute;
        return disposable();
      },
      registerSearchProvider: disposable,
    },
    capabilities: {
      provide: (_name: string, implementation: Capability) => { capability = implementation; return disposable(); },
    },
  };
  cleanups.push(() => subscriptions.forEach((entry) => entry.dispose()));
  await activate(ctx as never);
  return { file, oauth, capability, execute: (...args: Parameters<Execute>) => execute!(...args) };
}

describe('MCP 管理入口的 OAuth 行为', () => {
  it('激活 provider 不主动启动 OAuth 或建立 OAuth 连接', async () => {
    await fixture();
    expect(authorize).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('工具箱编辑保留 scopes 与贡献方自声明的授权图标，且不强制重新授权', async () => {
    const { file, oauth, capability } = await fixture();
    await capability['host:saveUserServer']({
      originalName: 'service', name: 'renamed', transport: 'httpStream', url: endpoint, authMethod: 'oauth',
    });
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(stored.servers[0].oauth).toEqual({ ...oauth, providerName: 'renamed' });
    expect(authorize).toHaveBeenCalledWith(endpoint, expect.objectContaining({ scopes: ['read', 'write'], providerIcon: 'finch-ext-icon://notion/icon.png' }), expect.anything(), expect.anything(), false);
    expect(createProvider).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('服务没有自声明图标时退回 MCP 小程序包内固定图标', async () => {
    const { capability } = await fixture(true, { providerIcon: undefined });
    await capability['host:retryServer']('service');
    expect(authorize).toHaveBeenCalledWith(endpoint, expect.objectContaining({ providerIcon: 'finch-ext-icon://mcp/assets/mcp-oauth.png' }), expect.anything(), expect.anything(), false);
  });

  it('忽略非扩展归属的图标声明，退回包内固定图标', async () => {
    const { capability } = await fixture(true, { providerIcon: 'https://example.com/logo.png' });
    await capability['host:retryServer']('service');
    expect(authorize).toHaveBeenCalledWith(endpoint, expect.objectContaining({ providerIcon: 'finch-ext-icon://mcp/assets/mcp-oauth.png' }), expect.anything(), expect.anything(), false);
  });

  it('工具箱保存没有改动的 OAuth 配置时，不清除 scopes 也不调用授权', async () => {
    const { file, capability } = await fixture();
    const original = readFileSync(file, 'utf8');
    await capability['host:saveUserServer']({
      originalName: 'service', name: 'service', transport: 'httpStream', url: endpoint, authMethod: 'oauth',
    });
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(authorize).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('聊天工具普通编辑保留已有 scopes，不强制重新授权', async () => {
    const { file, execute } = await fixture();
    await execute({ action: 'edit', name: 'service' }, {
      ui: { requestForm: async () => ({ submitted: true, values: { name: 'renamed', url: endpoint } }) },
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).servers[0].oauth.scopes).toEqual(['read', 'write']);
    expect(authorize).toHaveBeenCalledWith(endpoint, expect.anything(), expect.anything(), expect.anything(), false);
  });

  it('地址改变时请求重新授权，而不是沿用旧连接', async () => {
    const { capability } = await fixture();
    const nextUrl = 'https://other.example.com/mcp';
    await capability['host:saveUserServer']({
      originalName: 'service', name: 'service', transport: 'httpStream', url: nextUrl, authMethod: 'oauth',
    });
    expect(authorize).toHaveBeenCalledWith(nextUrl, expect.anything(), expect.anything(), expect.anything(), true);
  });

  it('普通重连先尝试复用凭据，不把重连视为强制授权', async () => {
    const { capability } = await fixture();
    await capability['host:retryServer']('service');
    expect(authorize).toHaveBeenCalledWith(endpoint, expect.anything(), expect.anything(), expect.anything(), false);
    expect(connect).toHaveBeenCalledOnce();
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]);
  });

  it('用户明确执行 OAuth connect 时保留强制重新授权语义', async () => {
    const { execute } = await fixture();
    await execute({ action: 'connect', name: 'service' }, {});
    expect(authorize).toHaveBeenCalledWith(endpoint, expect.anything(), expect.anything(), expect.anything(), true);
    expect(connect).toHaveBeenCalledOnce();
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]);
  });
});

describe('停用的 OAuth 服务', () => {
  it('工具箱保存停用服务不会发起授权或连接', async () => {
    const { file, capability } = await fixture(false);
    await capability['host:saveUserServer']({
      originalName: 'service', name: 'renamed', transport: 'httpStream', url: endpoint, authMethod: 'oauth',
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).servers[0]).toMatchObject({ name: 'renamed', enabled: false, oauth: { scopes: ['read', 'write'] } });
    expect(authorize).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('聊天编辑停用服务保留停用状态，不报告已重新连接', async () => {
    const { file, execute } = await fixture(false);
    const result = await execute({ action: 'edit', name: 'service' }, {
      ui: { requestForm: async () => ({ submitted: true, values: { name: 'renamed', url: endpoint } }) },
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).servers[0].enabled).toBe(false);
    expect(JSON.stringify(result)).toContain('remains disabled');
    expect(authorize).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
