import type * as finch from 'finch';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'finch-mcp-partial-marker-'));
  roots.push(root);
  const stable = join(root, 'mcp');
  const legacy = join(root, 'extension-data', 'mcp');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'servers.json'), JSON.stringify({
    servers: [{ name: 'remote', url: 'https://example.test', secretRefs: { A: 'old.ref' } }],
  }));

  const list: finch.Disposable[] = [];
  subscriptions.push(list);
  const disposable = () => ({ dispose: vi.fn() });
  const store = new Map<string, string>();
  const failRefs = new Set<string>();
  const writes: { armed: boolean } = { armed: false };
  const secrets = {
    set: async (ref: string, value: string) => {
      const armed = writes.armed;
      if (armed) await onWrite?.();
      if (failRefs.has(ref)) throw new Error('write failed');
      store.set(ref, value);
    },
    get: async (ref: string) => store.get(ref),
  };

  let onWrite: (() => Promise<void>) | undefined;
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
      sources: () => [{ id: 'legacy', storagePath: legacy }],
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
  return {
    ctx,
    stable,
    store,
    failRefs,
    writes,
    setOnWrite: (fn: (() => Promise<void>) | undefined) => {
      onWrite = fn;
    },
    disable: async (name: string) => {
      const host = provided.get('mcp.client');
      const toggle = host?.['host:setUserServerEnabled'] as
        | ((name: string, enabled: boolean) => Promise<{ ok: boolean }>)
        | undefined;
      if (!toggle) throw new Error('host:setUserServerEnabled 不可用');
      return toggle(name, false);
    },
  };
}

const serversOn = (path: string) => JSON.parse(readFileSync(join(path, 'servers.json'), 'utf8')).servers as Array<Record<string, unknown>>;
const markerOn = (path: string) => JSON.parse(readFileSync(join(path, 'migration.json'), 'utf8'));
const entry = (path: string, name: string) => serversOn(path).find((server) => server.name === name);
const writeServers = (path: string, servers: Array<Record<string, unknown>>) => {
  writeFileSync(join(path, 'servers.json'), JSON.stringify({ servers }));
};

async function activate(ctx: unknown) {
  vi.resetModules();
  const module = await import('./index.js');
  await module.activate(ctx as unknown as finch.MiniToolContext);
}

describe('partial 重启的 completed 标记一致性（真实 activate 链）', () => {
  it('导入阶段合并旧 pending 后：completed 必须由完整队列派生（不能 completed:true + pendingSlots>0）', async () => {
    const h = harness();
    const { ctx, stable, failRefs, writes } = h;
    // canonical 始终写不进去 → 槽位保持 pending，两趟都冲突。
    failRefs.add('mcp.remote.env.a');

    await activate(ctx);
    expect(markerOn(stable).completed).toBe(false);

    let edits = 0;
    writes.armed = true;
    h.setOnWrite(async () => {
      edits += 1;
      const live = serversOn(stable);
      live[0] = { ...live[0], note: `user note ${edits}` };
      writeServers(stable, live);
    });

    await activate(ctx);
    writes.armed = false;
    h.setOnWrite(undefined);

    const state = markerOn(stable);
    // 本轮的 partial 必须落成一个自洽的 marker：还有 pending 就不能是 completed。
    expect(state.pendingSlots).toHaveLength(1);
    expect(state.completed).toBe(false);
    expect(entry(stable, 'remote')?.note).toBe('user note 2');
  }, 30_000);

  it('两趟目标冲突后：partial、磁盘 completed=false 且 pending 保留、用户配置与禁用资格都不被覆盖', async () => {
    const h = harness();
    const { ctx, stable, store, failRefs, writes } = h;
    // canonical 写入始终失败 → 两趟都会真正尝试写入并各自遇到用户改动。
    failRefs.add('mcp.remote.env.a');

    await activate(ctx);
    expect(markerOn(stable).completed).toBe(false);
    expect(markerOn(stable).pendingSlots).toHaveLength(1);

    // 用户在该次重试的 await 期间改动落盘目标，并在第一趟经真实入口禁用。
    let edits = 0;
    writes.armed = true;
    h.setOnWrite(async () => {
      edits += 1;
      const live = serversOn(stable);
      live[0] = {
        ...live[0],
        note: `user note ${edits}`,
        secretRefs: { A: 'mcp.remote.env.user_ref' },
      };
      writeServers(stable, live);
      if (edits === 1) await h.disable('remote');
      // 同一次 await 中历史源也不再含明文 → 会让 reportRetainedSources 走写入分支，
      // 从而暴露「双冲突出口盲写旧 marker」的问题。
      writeServers(ctx.storagePath, [{ name: 'remote', url: 'https://example.test' }]);
    });

    await activate(ctx);
    writes.armed = false;
    h.setOnWrite(undefined);

    // 两趟都冲突 → 明确 partial，且标记自洽（不能再出现 completed:true + pendingSlots>0）。
    const afterConflicts = markerOn(stable);
    expect(afterConflicts.completed).toBe(false);
    expect(afterConflicts.pendingSlots).toHaveLength(1);
    // 用户禁用撤销的恢复资格不能被旧 marker 盲写回去。
    expect(afterConflicts.disabledByMigration ?? []).toEqual([]);

    // 用户 ref / note / enabled 逐字段保留。
    const preserved = entry(stable, 'remote');
    expect(preserved?.secretRefs).toEqual({ A: 'mcp.remote.env.user_ref' });
    expect(preserved?.note).toBe('user note 2');
    expect(preserved?.enabled).toBe(false);

    // 下一次（用户已填好托管值）可以收敛，且用户配置继续保留。
    store.set('mcp.remote.env.user_ref', 'user-value');
    failRefs.clear();
    await activate(ctx);

    const converged = markerOn(stable);
    expect(converged.completed).toBe(true);
    expect(converged.pendingSlots).toEqual([]);
    expect(entry(stable, 'remote')?.secretRefs).toEqual({ A: 'mcp.remote.env.user_ref' });
    expect(entry(stable, 'remote')?.note).toBe('user note 2');
    expect(entry(stable, 'remote')?.enabled).toBe(false);
  }, 30_000);

  it('partial 期间用户删除该服务：重启不复活且队列收敛', async () => {
    const h = harness();
    const { ctx, stable, failRefs } = h;
    failRefs.add('mcp.remote.env.a');

    await activate(ctx);
    expect(stable ? markerOn(stable).completed : true).toBe(false);

    // 用户删除该服务（真实落盘）。
    writeServers(stable, []);
    failRefs.clear();
    await activate(ctx);

    expect(serversOn(stable)).toEqual([]);
    const state = markerOn(stable);
    expect(state.removedServers).toEqual(['remote']);
    expect(state.pendingSlots).toEqual([]);
    expect(state.completed).toBe(true);
  }, 30_000);
});
