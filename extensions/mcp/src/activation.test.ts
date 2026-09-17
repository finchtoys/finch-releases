import type * as finch from 'finch';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 不连接真实 MCP 服务；保留真实 activate 与 OAuth 凭据迁移实现。
vi.mock('./client.js', () => ({ createMcpClient: vi.fn(), isHttpConfig: vi.fn(() => false) }));
vi.mock('./dataMigration.js', () => ({ migrateMcpData: vi.fn(async () => ({ state: 'completed' })) }));

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
  const root = mkdtempSync(join(tmpdir(), 'finch-mcp-activation-'));
  roots.push(root);
  const values = new Map<string, unknown>([['mcp.oauth.notion', { token: 'fixture-only' }]]);
  const storage: finch.Storage = {
    async keys() { return [...values.keys()]; },
    async get(key) { return values.get(key) as never; },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async clear() { values.clear(); },
  };
  const list: finch.Disposable[] = [];
  subscriptions.push(list);
  const disposable = () => ({ dispose: vi.fn() });
  const ctx = {
    storagePath: root,
    storage,
    oauth: { saveCredential: vi.fn(async () => {}) },
    i18n: { t: (key: string) => key },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    subscriptions: list,
    minitools: { listContributions: vi.fn(() => []) },
    tools: { register: vi.fn(disposable), registerSearchProvider: vi.fn(disposable) },
    capabilities: { provide: vi.fn(disposable) },
    capabilityMigration: { sources: vi.fn(() => [] as Array<{ id: string; storagePath: string }>) },
  };
  return { ctx, values, root };
}

describe('MCP 激活的 OAuth 迁移屏障', () => {
  it('加密迁移完成前不注册任何工具或能力，完成后才开放', async () => {
    const { ctx, values } = harness();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    ctx.oauth.saveCredential.mockImplementation(async () => { started(); await pending; });
    const { activate } = await import('./index.js');
    const activation = activate(ctx as unknown as finch.MiniToolContext);
    await entered;
    expect(ctx.tools.register).not.toHaveBeenCalled();
    expect(ctx.tools.registerSearchProvider).not.toHaveBeenCalled();
    expect(ctx.capabilities.provide).not.toHaveBeenCalled();
    expect(values.has('mcp.oauth.notion')).toBe(true);
    release();
    await activation;
    expect(values.has('mcp.oauth.notion')).toBe(false);
    expect(ctx.tools.register).toHaveBeenCalled();
    expect(ctx.capabilities.provide).toHaveBeenCalledWith('mcp.client', expect.objectContaining({
      listResources: expect.any(Function),
      readResource: expect.any(Function),
      listPrompts: expect.any(Function),
      getPrompt: expect.any(Function),
    }));
    expect(ctx.logger.info).toHaveBeenCalledWith('mcp.oauth.migration.completed', {
      migratedCount: 1, durationMs: expect.any(Number),
    });
  });

  it('当前凭据写入失败时拒绝激活、保留原值，恢复后可重试', async () => {
    const { ctx, values } = harness();
    ctx.oauth.saveCredential.mockRejectedValueOnce(new Error('sensitive-fixture-error'));
    const { activate } = await import('./index.js');
    await expect(activate(ctx as unknown as finch.MiniToolContext)).rejects.toThrow('activation stopped for retry');
    expect(values.has('mcp.oauth.notion')).toBe(true);
    expect(ctx.tools.register).not.toHaveBeenCalled();
    expect(ctx.capabilities.provide).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalledWith('mcp.oauth.migration.failed', {
      migratedCount: 0, durationMs: expect.any(Number),
    });
    expect(JSON.stringify([ctx.logger.warn.mock.calls, ctx.logger.error.mock.calls])).not.toContain('sensitive-fixture-error');
    await activate(ctx as unknown as finch.MiniToolContext);
    expect(values.has('mcp.oauth.notion')).toBe(false);
    expect(ctx.capabilities.provide).toHaveBeenCalledTimes(1);
  });

  it('历史凭据源损坏时停止激活，不继续迁移当前凭据', async () => {
    const { ctx, root } = harness();
    writeFileSync(join(root, 'storage.json'), '{invalid');
    ctx.capabilityMigration.sources.mockReturnValue([{ id: 'legacy', storagePath: root }]);
    const { activate } = await import('./index.js');
    await expect(activate(ctx as unknown as finch.MiniToolContext)).rejects.toThrow('activation stopped for retry');
    expect(ctx.oauth.saveCredential).not.toHaveBeenCalled();
    expect(ctx.tools.register).not.toHaveBeenCalled();
    expect(ctx.capabilities.provide).not.toHaveBeenCalled();
  });
});
