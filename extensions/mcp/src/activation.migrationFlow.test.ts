import type * as finch from 'finch';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 只替身外部依赖（MCP 连接），保留真实的 activate + dataMigration 全流程。
vi.mock('./client.js', () => ({ createMcpClient: vi.fn(), isHttpConfig: vi.fn(() => false) }));

const roots: string[] = [];
const subscriptions: finch.Disposable[][] = [];
beforeEach(() => vi.resetModules());
afterEach(async () => {
  for (const list of subscriptions.splice(0)) {
    for (const item of list) await item.dispose();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function flakySecrets(failRefs: Set<string>) {
  const store = new Map<string, string>();
  return {
    store,
    secrets: {
      set: async (ref: string, value: string) => {
        if (failRefs.has(ref)) throw new Error('write failed');
        store.set(ref, value);
      },
      get: async (ref: string) => store.get(ref),
    },
  };
}

function harness(failRefs: Set<string>, serverName = 'remote') {
  const root = mkdtempSync(join(tmpdir(), 'finch-mcp-activation-migration-'));
  roots.push(root);
  const stable = join(root, 'mcp');
  const legacy = join(root, 'extension-data', 'mcp');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'servers.json'), JSON.stringify({
    servers: [{ name: serverName, url: 'https://example.test', secretRefs: { TOKEN: 'old.ref' } }],
  }));
  const list: finch.Disposable[] = [];
  subscriptions.push(list);
  const disposable = () => ({ dispose: vi.fn() });
  // ctx.storage：本测试不带 OAuth 明文键，只要求入口可用。
  const values = new Map<string, unknown>();
  const storage: finch.Storage = {
    async keys() { return [...values.keys()]; },
    async get(key) { return values.get(key) as never; },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async clear() { values.clear(); },
  };
  const credentialKey = (ref: finch.OAuthCredentialRef) => `${ref.providerId}/${ref.account ?? ''}`;
  const credentials = new Map<string, finch.OAuthCredentialValue>();
  const backend = flakySecrets(failRefs);
  const ctx = {
    storagePath: legacy,
    storage,
    capabilityStoragePaths: { 'mcp.client': stable },
    capabilityMigration: {
      sources: () => [{ id: 'legacy', storagePath: legacy }],
      readSecret: async () => 'secret',
    },
    secrets: backend.secrets,
    oauth: {
      saveCredential: vi.fn(async (ref: finch.OAuthCredentialRef, credential: finch.OAuthCredentialValue) => {
        credentials.set(credentialKey(ref), credential);
      }),
      getCredential: vi.fn(async (ref: finch.OAuthCredentialRef) => credentials.get(credentialKey(ref))),
      deleteCredential: vi.fn(async (ref: finch.OAuthCredentialRef) => { credentials.delete(credentialKey(ref)); }),
    },
    i18n: { t: (key: string) => key },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    subscriptions: list,
    minitools: { listContributions: vi.fn(() => []) },
    tools: { register: vi.fn(disposable), registerSearchProvider: vi.fn(disposable) },
    capabilities: { provide: vi.fn(disposable) },
  };
  return { ctx, stable, legacy, backend };
}

function stableServers(stable: string) {
  return JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers as Array<Record<string, unknown>>;
}
function marker(stable: string) {
  return JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8'));
}

describe("MCP 迁移真实全流程（activate + dataMigration，不 mock）", () => {
  it("第一次部分失败 → 落盘 marker → 重启后增量重试完成，状态与禁用一致", async () => {
    const failing = new Set(['mcp.remote.env.token']);
    const { ctx, stable } = harness(failing);

    const first = await import('./index.js');
    await first.activate(ctx as unknown as finch.MiniToolContext);

    // 第一次：服务被迁移禁用，marker 记录槽位 pending，历史源保留。
    expect(stableServers(stable)[0]).toMatchObject({ name: 'remote', enabled: false, credentialMigrationFailed: true });
    const firstMarker = marker(stable);
    expect(firstMarker.completed).toBe(false);
    expect(firstMarker.pendingSlots).toHaveLength(1);
    expect(firstMarker.sourcesRetainingPlaintext).toEqual(['legacy']);

    // 重启：不 mock dataMigration，走真实增量重试。
    vi.resetModules();
    failing.clear();
    const second = await import('./index.js');
    await second.activate(ctx as unknown as finch.MiniToolContext);

    const server = stableServers(stable)[0];
    expect(server.secretRefs).toEqual({ TOKEN: 'mcp.remote.env.token' });
    expect(server.credentialMigrationFailed).toBeUndefined();
    expect(server.enabled).toBe(true);
    expect(marker(stable).completed).toBe(true);
    expect(marker(stable).pendingSlots).toEqual([]);
    // 历史源始终未被改写。
    expect(JSON.parse(readFileSync(join(ctx.storagePath, 'servers.json'), 'utf8')).servers[0].secretRefs)
      .toEqual({ TOKEN: 'old.ref' });
  });

  it("重试前用户已在目标填入有效凭据：不覆盖，直接完成", async () => {
    const failing = new Set(['mcp.remote.env.token']);
    const { ctx, stable, backend } = harness(failing);

    const first = await import('./index.js');
    await first.activate(ctx as unknown as finch.MiniToolContext);
    expect(marker(stable).completed).toBe(false);

    // 用户手动把该服务改成使用另一个已存在的托管 ref（模拟手工修复/重新登录）。
    const servers = stableServers(stable);
    servers[0].secretRefs = { TOKEN: 'mcp.remote.env.user_fill' };
    writeFileSync(join(stable, 'servers.json'), JSON.stringify({ servers }));
    backend.store.set('mcp.remote.env.user_fill', 'user-value');

    vi.resetModules();
    const second = await import('./index.js');
    await second.activate(ctx as unknown as finch.MiniToolContext);

    // 用户当前引用与值都不被覆盖。
    expect(stableServers(stable)[0].secretRefs).toEqual({ TOKEN: 'mcp.remote.env.user_fill' });
    expect(backend.store.get('mcp.remote.env.user_fill')).toBe('user-value');
    expect(marker(stable).completed).toBe(true);
  });

  it("partial 中用户删除该服务后重启：不复活，enabled/标记一致", async () => {
    const failing = new Set(['mcp.remote.env.token']);
    const { ctx, stable } = harness(failing);

    const first = await import('./index.js');
    await first.activate(ctx as unknown as finch.MiniToolContext);
    expect(stableServers(stable)).toHaveLength(1);

    // 用户删除该服务。
    writeFileSync(join(stable, 'servers.json'), JSON.stringify({ servers: [] }));

    vi.resetModules();
    failing.clear();
    const second = await import('./index.js');
    await second.activate(ctx as unknown as finch.MiniToolContext);

    expect(stableServers(stable)).toEqual([]);
    const state = marker(stable);
    expect(state.removedServers).toEqual(['remote']);
    expect(state.pendingSlots).toEqual([]);
  });
});
