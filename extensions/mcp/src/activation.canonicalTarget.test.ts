import type * as finch from 'finch';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 只替身外部依赖（MCP 连接 / 真实进程），保留 activate + dataMigration 全流程。
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

interface HarnessOptions {
  legacyServers: Array<Record<string, unknown>>;
  /** 第二个历史来源（用于制造同名冲突副本）。 */
  secondSource?: { id: string; servers: Array<Record<string, unknown>> };
  failRefs?: Set<string>;
  /** 在托管写入期间运行，模拟用户此刻改了落盘文件。 */
  onSecretWrite?: (stable: string) => void | Promise<void>;
}

function harness(options: HarnessOptions) {
  const root = mkdtempSync(join(tmpdir(), 'finch-mcp-canonical-'));
  roots.push(root);
  const stable = join(root, 'mcp');
  const legacy = join(root, 'extension-data', 'mcp');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'servers.json'), JSON.stringify({ servers: options.legacyServers }));
  const second = options.secondSource
    ? join(root, 'extension-data', options.secondSource.id)
    : undefined;
  if (second && options.secondSource) {
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, 'servers.json'), JSON.stringify({ servers: options.secondSource.servers }));
  }

  const list: finch.Disposable[] = [];
  subscriptions.push(list);
  const disposable = () => ({ dispose: vi.fn() });
  const store = new Map<string, string>();
  const failRefs = options.failRefs ?? new Set<string>();
  const secrets = {
    set: async (ref: string, value: string) => {
      if (failRefs.has(ref)) throw new Error('write failed');
      store.set(ref, value);
      await options.onSecretWrite?.(stable);
    },
    get: async (ref: string) => store.get(ref),
  };
  const values = new Map<string, unknown>();
  const storage: finch.Storage = {
    async keys() { return [...values.keys()]; },
    async get(key) { return values.get(key) as never; },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async clear() { values.clear(); },
  };
  const provided = new Map<string, Record<string, unknown>>();
  const ctx = {
    storagePath: legacy,
    storage,
    secrets,
    capabilityStoragePaths: { 'mcp.client': stable },
    capabilityMigration: {
      sources: () => [
        { id: 'legacy', storagePath: legacy },
        ...(second ? [{ id: options.secondSource!.id, storagePath: second }] : []),
      ],
      readSecret: async () => 'secret',
    },
    oauth: {
      saveCredential: vi.fn(async () => undefined),
      getCredential: vi.fn(async () => undefined),
      deleteCredential: vi.fn(async () => undefined),
    },
    i18n: { t: (key: string) => key },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    subscriptions: list,
    minitools: { listContributions: vi.fn(() => []) },
    tools: { register: vi.fn(disposable), registerSearchProvider: vi.fn(disposable) },
    capabilities: {
      provide: vi.fn((name: string, impl: Record<string, unknown>) => {
        provided.set(name, impl);
        return disposable();
      }),
    },
  };
  return { ctx, stable, legacy, store, provided, disable: async (name: string) => {
    const host = provided.get('mcp.client');
    const toggle = host?.['host:setUserServerEnabled'] as ((name: string, enabled: boolean) => Promise<{ ok: boolean }>) | undefined;
    if (!toggle) throw new Error('host:setUserServerEnabled 不可用');
    return toggle(name, false);
  } };
}

const serversOn = (path: string) => JSON.parse(readFileSync(join(path, 'servers.json'), 'utf8')).servers as Array<Record<string, unknown>>;
const markerOn = (path: string) => JSON.parse(readFileSync(join(path, 'migration.json'), 'utf8'));
const normalized = (name: unknown) => String(name).trim().toLowerCase();
const entry = (path: string, name: string) => serversOn(path).find((server) => server.name === name);

async function activateTwice(ctx: unknown, prepare?: () => void | Promise<void>) {
  const first = await import('./index.js');
  await first.activate(ctx as unknown as finch.MiniToolContext);
  prepare && await prepare();
  vi.resetModules();
  const second = await import('./index.js');
  await second.activate(ctx as unknown as finch.MiniToolContext);
}

describe('MCP canonical target 与用户意图（真实 activate 链）', () => {
  it('首次写失败后 canonical 已被外部修好：重试绑定它，不覆盖成 stale 源值', async () => {
    const failRefs = new Set(['mcp.remote.env.a']);
    const { ctx, stable, store } = harness({
      legacyServers: [{ name: 'remote', url: 'https://example.test', secretRefs: { A: 'old.ref' } }],
      failRefs,
    });

    const first = await import('./index.js');
    await first.activate(ctx as unknown as finch.MiniToolContext);
    // 首次失败：pending 且目标没有可用的 published 值。
    expect(markerOn(stable).completed).toBe(false);
    expect(markerOn(stable).pendingSlots).toHaveLength(1);

    // 外部（用户或另一个进程）把 canonical 值正常修好。
    failRefs.clear();
    store.set('mcp.remote.env.a', 'fresh-external');

    vi.resetModules();
    const second = await import('./index.js');
    await second.activate(ctx as unknown as finch.MiniToolContext);

    // 必须以 canonical fresh 收口，而不是把 stale 源值写进去。
    expect(entry(stable, 'remote')?.secretRefs).toEqual({ A: 'mcp.remote.env.a' });
    expect(store.get('mcp.remote.env.a')).toBe('fresh-external');
    expect(markerOn(stable).completed).toBe(true);
    // 历史源只读保留。
    expect(entry(ctx.storagePath, 'remote')?.secretRefs).toEqual({ A: 'old.ref' });
  });

  it('canonical 读取失败时不得当作缺失，也就不得自动覆盖', async () => {
    const failRefs = new Set(['mcp.remote.env.a']);
    const { ctx, stable, store } = harness({
      legacyServers: [{ name: 'remote', url: 'https://example.test', secretRefs: { A: 'old.ref' } }],
      failRefs,
    });
    const first = await import('./index.js');
    await first.activate(ctx as unknown as finch.MiniToolContext);

    // 第二次：canonical 读取抛错（不可读 ≠ 缺失）。托管写入仍然失败。
    const originalGet = ctx.secrets.get;
    ctx.secrets.get = async (ref: string) => {
      if (ref === 'mcp.remote.env.a') throw new Error('unreadable');
      return originalGet(ref);
    };
    vi.resetModules();
    const second = await import('./index.js');
    await second.activate(ctx as unknown as finch.MiniToolContext);

    // 槽位仍未完成，且没有把源值写进 canonical。
    expect(markerOn(stable).completed).toBe(false);
    expect(store.has('mcp.remote.env.a')).toBe(false);
    expect(entry(stable, 'remote')?.enabled).toBe(false);
  });

  it('原本已禁用的服务迁移失败后恢复：不被 migration 自动启用', async () => {
    const failRefs = new Set(['mcp.remote.env.a']);
    const { ctx, stable } = harness({
      legacyServers: [{
        name: 'remote',
        url: 'https://example.test',
        enabled: false,
        secretRefs: { A: 'old.ref' },
      }],
      failRefs,
    });

    await activateTwice(ctx, () => failRefs.clear());

    // 用户本来就禁用：恢复后仍必须禁用。
    expect(entry(stable, 'remote')?.enabled).toBe(false);
    expect(markerOn(stable).disabledByMigration ?? []).toEqual([]);
    expect(markerOn(stable).completed).toBe(true);
  });

  it('冲突副本被禁用：迁移失败再恢复也不得自动启用', async () => {
    // 两个历史来源同名 → 第二个成为冲突副本，导入时即为 disabled。
    const failRefs = new Set(['mcp.remote_copy.env.a']);
    const { ctx, stable } = harness({
      legacyServers: [{ name: 'remote', url: 'https://legacy.test', secretRefs: { A: 'old.ref' } }],
      secondSource: {
        id: 'legacy2',
        servers: [{ name: 'remote', url: 'https://legacy2.test', secretRefs: { A: 'old2.ref' } }],
      },
      failRefs,
    });

    await activateTwice(ctx, () => failRefs.clear());

    const copy = serversOn(stable).find((server) => normalized(server.name) !== 'remote');
    expect(copy, `conflict copy missing: ${JSON.stringify(serversOn(stable))}`).toBeDefined();
    expect(copy?.enabled).toBe(false);
    expect(markerOn(stable).disabledByMigration ?? []).toEqual([]);
    expect(markerOn(stable).completed).toBe(true);
  });

  it('partial 期间用户经真实入口禁用：撤销恢复资格，恢复后保持禁用', async () => {
    const failRefs = new Set(['mcp.remote.env.a']);
    const { ctx, stable, store, disable } = harness({
      legacyServers: [{ name: 'remote', url: 'https://example.test', secretRefs: { A: 'old.ref' } }],
      failRefs,
    });

    const first = await import('./index.js');
    await first.activate(ctx as unknown as finch.MiniToolContext);
    expect(markerOn(stable).disabledByMigration).toEqual(['remote']);

    // 用户在 partial 期间通过真实 UI 入口禁用该服务。
    await disable('remote');
    expect(markerOn(stable).disabledByMigration).toEqual([]);

    // 之后凭据恢复成功：服务仍必须保持禁用。
    failRefs.clear();
    store.set('mcp.remote.env.a', 'secret');
    vi.resetModules();
    const second = await import('./index.js');
    await second.activate(ctx as unknown as finch.MiniToolContext);

    expect(markerOn(stable).completed).toBe(true);
    expect(entry(stable, 'remote')?.enabled).toBe(false);
  });

  it('await 期间用户改了落盘目标（ref + note）并经真实入口禁用：逐字段保留', async () => {
    const failRefs = new Set(['mcp.remote.env.a']);
    let edited = false;
    // 延迟到 harness 建好后再填充 hook 主体（hook 在 activate 期间才触发）。
    const hook: { run?: () => Promise<void> } = {};
    const { ctx, stable, store, disable } = harness({
      legacyServers: [{ name: 'remote', url: 'https://example.test', secretRefs: { A: 'old.ref' } }],
      failRefs,
      onSecretWrite: async () => {
        if (hook.run) await hook.run();
      },
    });
    hook.run = async () => {
      if (edited) return;
      edited = true;
      // 用户在当前 await 期间：换成自己填好的 ref、加 note，并通过真实入口禁用。
      const live = serversOn(stable);
      live[0] = { ...live[0], note: 'user note', secretRefs: { A: 'mcp.remote.env.user_fill' } };
      writeFileSync(join(stable, 'servers.json'), JSON.stringify({ servers: live }));
      store.set('mcp.remote.env.user_fill', 'user-value');
      await disable('remote');
    };
    const first = await import('./index.js');
    await first.activate(ctx as unknown as finch.MiniToolContext);
    expect(markerOn(stable).completed).toBe(false);
    failRefs.clear();

    vi.resetModules();
    const second = await import('./index.js');
    await second.activate(ctx as unknown as finch.MiniToolContext);

    const finalEntry = entry(stable, 'remote');
    // 用户配置逐字段保留，绝不被旧快照覆盖。
    expect(finalEntry?.secretRefs).toEqual({ A: 'mcp.remote.env.user_fill' });
    expect(finalEntry?.note).toBe('user note');
    expect(finalEntry?.enabled).toBe(false);
    expect(markerOn(stable).completed).toBe(true);
    expect(store.get('mcp.remote.env.user_fill')).toBe('user-value');
  });
});
