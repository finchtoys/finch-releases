import type * as finch from 'finch';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const credentialKey = (ref: finch.OAuthCredentialRef) => `${ref.providerId}/${ref.account ?? ''}`;
  const credentials = new Map<string, finch.OAuthCredentialValue>();
  const ctx = {
    storagePath: root,
    storage,
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
    capabilityMigration: { sources: vi.fn(() => [] as Array<{ id: string; storagePath: string }>) },
  };
  return { ctx, values, credentials, credentialKey, root };
}

describe('MCP 激活的 OAuth 迁移屏障', () => {
  it('加密迁移完成前不注册任何工具或能力，完成后才开放', async () => {
    const { ctx, values, credentials, credentialKey } = harness();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    ctx.oauth.saveCredential.mockImplementation(async (ref: finch.OAuthCredentialRef, credential: finch.OAuthCredentialValue) => {
      started();
      await pending;
      credentials.set(credentialKey(ref), credential);
    });
    const { activate } = await import('./index.js');
    const activation = activate(ctx as unknown as finch.MiniToolContext);
    await entered;
    expect(ctx.tools.register).not.toHaveBeenCalled();
    expect(ctx.tools.registerSearchProvider).not.toHaveBeenCalled();
    expect(ctx.capabilities.provide).not.toHaveBeenCalled();
    expect(values.has('mcp.oauth.notion')).toBe(true);
    release();
    await activation;
    // 源是只读的：明文键保留（本阶段不宣称普通 storage 已清理）。
    expect(values.has('mcp.oauth.notion')).toBe(true);
    expect(ctx.tools.register).toHaveBeenCalled();
    expect(ctx.capabilities.provide).toHaveBeenCalledWith('mcp.client', expect.objectContaining({
      listResources: expect.any(Function),
      readResource: expect.any(Function),
      listPrompts: expect.any(Function),
      getPrompt: expect.any(Function),
      // 工具箱管理面：宿主专用成员，普通消费方调用会被 host 侧拒绝。
      'host:getMigrationState': expect.any(Function),
      'host:getUserServerDraft': expect.any(Function),
      'host:getUserServerToken': expect.any(Function),
      'host:getUserServerEditorSecrets': expect.any(Function),
      'host:saveUserServer': expect.any(Function),
      'host:setUserServerEnabled': expect.any(Function),
      'host:retryServer': expect.any(Function),
      'host:removeUserServer': expect.any(Function),
    }), { version: expect.any(String) });
    expect(ctx.logger.info).toHaveBeenCalledWith('mcp.oauth.migration.completed', {
      migratedCount: 1, durationMs: expect.any(Number),
    });
  });

  it('当前凭据写入失败时拒绝激活、保留原值，恢复后可重试', async () => {
    const { ctx, values, credentials } = harness();
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
    // 恢复后导入成功，但源仍然保留。
    expect(credentials.get('mcp/notion')).toEqual({ value: { token: 'fixture-only' } });
    expect(values.has('mcp.oauth.notion')).toBe(true);
    expect(ctx.capabilities.provide).toHaveBeenCalledTimes(1);
  });

  it('stale 历史源与 fresh 当前源同时存在时，当前凭据优先（两源均只读保留）', async () => {
    const { ctx, values, credentials, root } = harness();
    // 当前身份（ctx.storage）持有 fresh 值；历史身份持有 stale 值。
    const staleDir = join(root, "legacy-dir");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "storage.json"), JSON.stringify({ 'mcp.oauth.notion': { token: 'stale-value' } }));
    ctx.capabilityMigration.sources.mockReturnValue([{ id: 'legacy', storagePath: staleDir }]);

    const { activate } = await import('./index.js');
    await activate(ctx as unknown as finch.MiniToolContext);

    // 空 custody 时必须是 fresh 胜出，而不是先到的 stale。
    expect(credentials.get('mcp/notion')).toEqual({ value: { token: 'fixture-only' } });
    // 两个源都保持只读：都保留明文。
    expect(values.has('mcp.oauth.notion')).toBe(true);
    expect(JSON.parse(readFileSync(join(staleDir, 'storage.json'), 'utf8'))['mcp.oauth.notion'])
      .toEqual({ token: 'stale-value' });
  });

  it('历史凭据源损坏时停止激活，且不开放工具或能力', async () => {
    const { ctx, root } = harness();
    writeFileSync(join(root, 'storage.json'), '{invalid');
    ctx.capabilityMigration.sources.mockReturnValue([{ id: 'legacy', storagePath: root }]);
    const { activate } = await import('./index.js');
    await expect(activate(ctx as unknown as finch.MiniToolContext)).rejects.toThrow('activation stopped for retry');
    // 当前身份先迁移（fresh 优先），因此它已经落盘；损坏的历史源仍然阻断激活。
    expect(ctx.oauth.saveCredential).toHaveBeenCalledTimes(1);
    expect(ctx.tools.register).not.toHaveBeenCalled();
    expect(ctx.capabilities.provide).not.toHaveBeenCalled();
  });
});
