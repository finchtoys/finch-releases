import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activate, deactivate } from './index.js';

const directories: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  deactivate();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function createFixture() {
  const storagePath = mkdtempSync(join(tmpdir(), 'finch-mcp-management-'));
  directories.push(storagePath);
  const file = join(storagePath, 'servers.json');
  const server = {
    name: 'local-test', command: 'node', args: ['server.js'], enabled: false,
    secretRefs: { TOKEN: 'test.token' },
  };
  writeFileSync(file, JSON.stringify({ servers: [server] }, null, 2));
  let capability: Record<string, (...args: any[]) => Promise<any>> = {};
  const subscriptions: Array<{ dispose(): void }> = [];
  const disposable = () => ({ dispose() {} });
  const secrets = {
    get: vi.fn(async () => 'test-value'),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    storagePath, subscriptions, secrets, logger,
    // 同时兼容后续独立审查的目录迁移，不读取真实运行数据。
    capabilityStoragePaths: { 'mcp.client': storagePath },
    capabilityMigration: { sources: () => [], readSecret: async () => undefined },
    storage: { keys: async () => [] },
    oauth: {},
    i18n: { t: (key: string) => key },
    minitools: { listContributions: () => [] },
    tools: { register: disposable, registerSearchProvider: disposable },
    capabilities: {
      provide: (_name: string, implementation: typeof capability) => {
        capability = implementation;
        return disposable();
      },
    },
  };
  cleanups.push(() => subscriptions.forEach((entry) => entry.dispose()));
  await activate(ctx as never);
  return { file, capability, secrets, logger };
}

describe('MCP 配置保存', () => {
  it('无变化时不重写配置、密钥或重新连接', async () => {
    const { file, capability, secrets, logger } = await createFixture();
    const original = readFileSync(file, 'utf8');
    secrets.set.mockClear();
    await expect(capability['host:saveUserServer']({
      originalName: 'local-test', name: 'local-test', transport: 'stdio',
      command: 'node', args: 'server.js',
    })).resolves.toEqual({ ok: true });
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(secrets.set).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('keeping the current connection'));
  });

  it('实际配置变化时仍保存新值', async () => {
    const { file, capability } = await createFixture();
    await capability['host:saveUserServer']({
      originalName: 'local-test', name: 'local-test', transport: 'stdio',
      command: 'bun', args: 'server.js',
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).servers[0].command).toBe('bun');
  });
});

describe('MCP 按需读取编辑草稿', () => {
  it('返回非敏感配置，不读取或返回密钥值', async () => {
    const { capability, secrets } = await createFixture();
    secrets.get.mockClear();
    const draft = await capability['host:getUserServerDraft']('local-test');
    expect(draft).toMatchObject({
      name: 'local-test', transport: 'stdio', command: 'node', args: 'server.js', envKeys: ['TOKEN'],
    });
    expect(JSON.stringify(draft)).not.toContain('test-value');
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it('不存在的服务返回 null，不借用其他服务的配置', async () => {
    const { capability } = await createFixture();
    await expect(capability['host:getUserServerDraft']('missing')).resolves.toBeNull();
  });
});
