import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mergeMcpServerSources, migrateMcpData } from './dataMigration.js';

describe('mergeMcpServerSources', () => {
  it('merges distinct servers and removes identical duplicates', () => {
    const result = mergeMcpServerSources([
      { id: 'stable', servers: [{ name: 'filesystem', command: 'npx', enabled: true }] },
      { id: 'mcp', servers: [
        { name: 'filesystem', command: 'npx' },
        { name: 'notion', url: 'https://mcp.example.test' },
      ] },
    ]);

    expect(result.servers.map((server) => server.name)).toEqual(['filesystem', 'notion']);
    expect(result.conflicts).toEqual([]);
  });

  it('keeps the higher-priority server and imports conflicts disabled', () => {
    const result = mergeMcpServerSources([
      { id: 'stable', servers: [{ name: 'notion', url: 'https://stable.example.test', enabled: true }] },
      { id: 'finchtoys@mcp-client', servers: [{ name: 'Notion', url: 'https://legacy.example.test' }] },
    ]);

    expect(result.servers).toEqual([
      expect.objectContaining({ name: 'notion', url: 'https://stable.example.test' }),
      expect.objectContaining({ name: 'Notion-migrated-2', url: 'https://legacy.example.test', enabled: false }),
    ]);
    expect(result.conflicts).toEqual([{
      originalName: 'Notion',
      importedName: 'Notion-migrated-2',
      source: 'finchtoys@mcp-client',
      differingFields: ['url'],
    }]);
  });

  it('treats aliases that map to the same model tool namespace as conflicts', () => {
    const result = mergeMcpServerSources([
      { id: 'stable', servers: [{ name: 'tavily-search', url: 'https://stable.example.test' }] },
      { id: 'mcp', servers: [{ name: 'tavily_search', url: 'https://legacy.example.test' }] },
    ]);

    expect(result.servers).toEqual([
      expect.objectContaining({ name: 'tavily-search', url: 'https://stable.example.test' }),
      expect.objectContaining({ name: 'tavily_search-migrated-2', enabled: false }),
    ]);
    expect(result.conflicts).toHaveLength(1);
  });

  it('迁移配置和业务密钥，但不搬运历史 OAuth 凭据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-migration-'));
    const stable = join(root, 'mcp');
    const legacy = join(root, 'extension-data', 'mcp');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'servers.json'), JSON.stringify({
      servers: [{ name: 'notion', url: 'https://mcp.example.test', secretRefs: { MCP_AUTH_TOKEN: 'mcp.notion.env.token' } }],
    }));
    writeFileSync(join(legacy, 'storage.json'), JSON.stringify({
      'mcp.oauth.notion': { access_token: 'oauth-secret' },
      'mcp.oauth.notion.verifier': 'ephemeral',
    }));
    const secrets = new Map<string, string>();
    const setSecret = vi.fn(async (ref: string, value: string) => { secrets.set(ref, value); });
    const getSecret = vi.fn(async (ref: string) => secrets.get(ref));
    const saveCredential = vi.fn(async () => {});
    const getCredential = vi.fn(async () => undefined);
    const ctx = {
      storagePath: legacy,
      capabilityStoragePaths: { 'mcp.client': stable },
      capabilityMigration: {
        sources: () => [{ id: 'mcp', storagePath: legacy }],
        readSecret: async () => 'api-secret',
      },
      secrets: { set: setSecret, get: getSecret },
      oauth: { getCredential, saveCredential },
    } as any;

    try {
      await expect(migrateMcpData(ctx)).resolves.toMatchObject({ state: 'completed' });
      const saved = JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')) as { servers: Array<Record<string, any>> };
      expect(saved.servers[0].secretRefs.MCP_AUTH_TOKEN).toBe('mcp.notion.env.mcp_auth_token');
      expect(setSecret).toHaveBeenCalledWith('mcp.notion.env.mcp_auth_token', 'api-secret');
      expect(getCredential).not.toHaveBeenCalled();
      expect(saveCredential).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(join(legacy, 'storage.json'), 'utf8'))).toMatchObject({
        'mcp.oauth.notion': { access_token: 'oauth-secret' },
        'mcp.oauth.notion.verifier': 'ephemeral',
      });
      expect(JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8'))).toMatchObject({ completed: true, version: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses deterministic suffixes when migrated names already exist', () => {
    const result = mergeMcpServerSources([
      { id: 'stable', servers: [
        { name: 'notion', url: 'https://one.example.test' },
        { name: 'notion-migrated-2', url: 'https://two.example.test' },
      ] },
      { id: 'mcp', servers: [{ name: 'notion', url: 'https://three.example.test' }] },
    ]);

    expect(result.servers.at(-1)?.name).toBe('notion-migrated-3');
  });
});

describe('迁移失败保护', () => {
  it.each(['{broken', '{"servers":{}}', '{"servers":[{"command":"node"}]}'])('损坏配置不会被当成空数据：%s', async (content) => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-invalid-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    const file = join(legacy, 'servers.json');
    writeFileSync(file, content);
    const set = vi.fn();
    try {
      const result = await migrateMcpData({
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: vi.fn() },
        secrets: { set },
      } as never);
      expect(result.state).toBe('failed');
      expect(readFileSync(file, 'utf8')).toBe(content);
      expect(existsSync(join(stable, 'migration.json'))).toBe(false);
      expect(existsSync(join(stable, 'servers.json'))).toBe(false);
      expect(set).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('同名密钥引用不代表两个来源的真实密钥相同', () => {
    const config = { name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'same.ref' } };
    const result = mergeMcpServerSources([
      { id: 'one', servers: [config] }, { id: 'two', servers: [config] },
    ]);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[1]).toMatchObject({ enabled: false });
  });

  it('v1 完成标记会触发保守重合并且不复制已有服务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-v2-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    mkdirSync(stable);
    writeFileSync(join(legacy, 'servers.json'), JSON.stringify({
      servers: [{ name: 'existing', url: 'https://legacy.example.test' }, { name: 'new', command: 'node' }],
    }));
    writeFileSync(join(stable, 'servers.json'), JSON.stringify({
      servers: [{ name: 'existing', url: 'https://stable.example.test' }],
    }));
    writeFileSync(join(stable, 'migration.json'), JSON.stringify({ version: 1, completed: true }));
    try {
      const result = await migrateMcpData({
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: vi.fn() },
        secrets: { set: vi.fn() },
      } as never);
      expect(result.state).toBe('completed');
      const saved = JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers;
      expect(saved.map((server: { name: string }) => server.name)).toEqual(['existing', 'new']);
      expect(saved[0].url).toBe('https://stable.example.test');
      expect(JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8')).version).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('v1 中失败的业务密钥会在 v2 重试', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-retry-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    mkdirSync(stable);
    writeFileSync(join(legacy, 'servers.json'), JSON.stringify({
      servers: [{ name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'old.ref' } }],
    }));
    writeFileSync(join(stable, 'servers.json'), JSON.stringify({
      servers: [{ name: 'remote', url: 'https://example.test', enabled: false, credentialMigrationFailed: true, secretRefs: {} }],
    }));
    writeFileSync(join(stable, 'migration.json'), JSON.stringify({ version: 1, completed: true }));
    const secrets = new Map<string, string>();
    const set = vi.fn(async (ref: string, value: string) => { secrets.set(ref, value); });
    const get = vi.fn(async (ref: string) => secrets.get(ref));
    try {
      await migrateMcpData({
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: async () => 'secret' },
        secrets: { set, get },
      } as never);
      expect(set).toHaveBeenCalledWith('mcp.remote.env.token', 'secret');
      expect(JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers[0]).toMatchObject({
        name: 'remote', secretRefs: { TOKEN: 'mcp.remote.env.token' },
      });
      expect(JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers[0].credentialMigrationFailed).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('密钥读取失败时停用服务并移除无效的新目录引用，保留原文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-secret-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    const content = JSON.stringify({ servers: [{ name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'old.ref' } }] });
    writeFileSync(join(legacy, 'servers.json'), content);
    try {
      await migrateMcpData({
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: async () => undefined },
        secrets: { set: vi.fn() },
      } as never);
      expect(JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers[0]).toMatchObject({
        enabled: false, credentialMigrationFailed: true, secretRefs: {},
      });
      expect(readFileSync(join(legacy, 'servers.json'), 'utf8')).toBe(content);
      // 失败项不可被完成标记掩盖：下次启动必须重试。
      expect(JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8'))).toMatchObject({
        version: 2, completed: false, pendingCredentials: ['remote'],
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('密钥写入后回读不一致时不发布引用，并保持待重试', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-verify-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'servers.json'), JSON.stringify({
      servers: [{ name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'old.ref' } }],
    }));
    const set = vi.fn(async () => {});
    try {
      const result = await migrateMcpData({
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: async () => 'secret' },
        // Backend silently fails to persist: readback never matches.
        secrets: { set, get: async () => undefined },
      } as never);
      expect(result.state).toBe('partial');
      expect(JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers[0]).toMatchObject({
        enabled: false, credentialMigrationFailed: true, secretRefs: {},
      });
      expect(JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8')).completed).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('历史明文 env 被密封进 secrets，不会复制到新的稳定配置', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-env-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'servers.json'), JSON.stringify({
      servers: [{ name: 'stdio-srv', command: 'node', env: { PLAIN_TOKEN: 'plain-env-secret' } }],
    }));
    const secrets = new Map<string, string>();
    try {
      await migrateMcpData({
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: vi.fn() },
        secrets: { set: async (ref: string, value: string) => { secrets.set(ref, value); }, get: async (ref: string) => secrets.get(ref) },
      } as never);
      const raw = readFileSync(join(stable, 'servers.json'), 'utf8');
      expect(raw).not.toContain('plain-env-secret');
      const saved = JSON.parse(raw).servers[0];
      expect(saved.env).toBeUndefined();
      expect(saved.secretRefs).toEqual({ PLAIN_TOKEN: 'mcp.stdio_srv.env.plain_token' });
      expect(secrets.get('mcp.stdio_srv.env.plain_token')).toBe('plain-env-secret');
      // 历史源只读：明文保留并如实上报（普通 storage 明文清理不在本阶段范围）。
      expect(readFileSync(join(legacy, 'servers.json'), 'utf8')).toContain('plain-env-secret');
      expect(JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8')).sourcesRetainingPlaintext).toEqual(['legacy']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('不重写历史源：凭据进入 custody，源文件保持逐字节原样', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-purge-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    const original = JSON.stringify({
      version: 1,
      servers: [
        { name: 'remote', url: 'https://example.test', enabled: true, secretRefs: { TOKEN: 'old.ref' }, env: { EXTRA: 'plain-extra' } },
        { name: 'plain', command: 'node' },
      ],
    });
    writeFileSync(join(legacy, 'servers.json'), original);
    const secrets = new Map<string, string>();
    try {
      const result = await migrateMcpData({
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: async () => 'secret' },
        secrets: { set: async (ref: string, value: string) => { secrets.set(ref, value); }, get: async (ref: string) => secrets.get(ref) },
      } as never);
      expect(result.state).toBe('completed');
      // 目标侧只含密文引用。
      const saved = JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers[0];
      expect(saved.secretRefs).toEqual({ TOKEN: 'mcp.remote.env.token', EXTRA: 'mcp.remote.env.extra' });
      expect(JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers[0].env).toBeUndefined();
      // 历史源不被本阶段改写或清理。
      expect(readFileSync(join(legacy, 'servers.json'), 'utf8')).toBe(original);
      expect(JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8')).sourcesRetainingPlaintext).toEqual(['legacy']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('源在迁移期间被外部改动也不受影响：本阶段从不写入历史源', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-source-change-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    const file = join(legacy, 'servers.json');
    writeFileSync(file, JSON.stringify({
      servers: [{ name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'old.ref' } }],
    }));
    const secrets = new Map<string, string>();
    let mutated = false;
    const changed = JSON.stringify({ servers: [
      { name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'old.ref' }, note: 'edited-during-migration' },
    ] });
    try {
      await migrateMcpData({
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: {
          sources: () => [{ id: 'legacy', storagePath: legacy }],
          readSecret: async () => { if (!mutated) { mutated = true; writeFileSync(file, changed); } return 'secret'; },
        },
        secrets: { set: async (ref: string, value: string) => { secrets.set(ref, value); }, get: async (ref: string) => secrets.get(ref) },
      } as never);
      // 外部改动被逐字节保留；凭据已进入 custody。
      expect(readFileSync(file, 'utf8')).toBe(changed);
      expect(secrets.get('mcp.remote.env.token')).toBe('secret');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('部分失败时历史源两项都保留，只有成功项进入 custody', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-partial-purge-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'servers.json'), JSON.stringify({
      servers: [
        { name: 'good', url: 'https://good.test', secretRefs: { TOKEN: 'good.ref' } },
        { name: 'bad', url: 'https://bad.test', secretRefs: { TOKEN: 'bad.ref' } },
      ],
    }));
    const secrets = new Map<string, string>();
    try {
      const result = await migrateMcpData({
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: {
          sources: () => [{ id: 'legacy', storagePath: legacy }],
          readSecret: async (_cap: string, _src: string, ref: string) => (ref === 'bad.ref' ? undefined : 'secret'),
        },
        secrets: { set: async (ref: string, value: string) => { secrets.set(ref, value); }, get: async (ref: string) => secrets.get(ref) },
      } as never);
      expect(result.state).toBe('partial');
      const source = JSON.parse(readFileSync(join(legacy, 'servers.json'), 'utf8'));
      const good = source.servers.find((server: { name: string }) => server.name === 'good');
      const bad = source.servers.find((server: { name: string }) => server.name === 'bad');
      // 历史源两项都原样保留（本阶段不做明文净化）。
      expect(good.secretRefs).toEqual({ TOKEN: 'good.ref' });
      expect(bad.secretRefs).toEqual({ TOKEN: 'bad.ref' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('待重试项在下次启动成功迁移且不产生编号副本', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-resume-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'servers.json'), JSON.stringify({
      servers: [{ name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'old.ref' } }],
    }));
    const secrets = new Map<string, string>();
    const failing = {
      capabilityStoragePaths: { 'mcp.client': stable },
      capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: async () => undefined },
      secrets: { set: async () => {}, get: async () => undefined },
    } as never;
    try {
      expect((await migrateMcpData(failing)).state).toBe('partial');
      // Second start with a working backend resumes only the failed server.
      const working = {
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: async () => 'secret' },
        secrets: { set: async (ref: string, value: string) => { secrets.set(ref, value); }, get: async (ref: string) => secrets.get(ref) },
      } as never;
      expect((await migrateMcpData(working)).state).toBe('completed');
      const saved = JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers;
      expect(saved.map((server: { name: string }) => server.name)).toEqual(['remote']);
      expect(saved[0]).toMatchObject({ secretRefs: { TOKEN: 'mcp.remote.env.token' } });
      expect(JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8')).completed).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

/** 可控 secrets 后端：可指定某个 ref 的写入失败。 */
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

describe("D/H/I/J/M · 增量重试、净化持久化与墓碑", () => {
  it('D: 服务内 A 成功 B 失败后重试，A 的引用不丢失', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-slot-retry-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    const file = join(legacy, 'servers.json');
    writeFileSync(file, JSON.stringify({
      servers: [{ name: 'remote', url: 'https://example.test', env: { A: 'a-value', B: 'b-value' } }],
    }));
    const failing = new Set(['mcp.remote.env.b']);
    const backend = flakySecrets(failing);
    const ctx = () => ({
      capabilityStoragePaths: { 'mcp.client': stable },
      capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: vi.fn() },
      secrets: backend.secrets,
    } as never);
    try {
      expect((await migrateMcpData(ctx())).state).toBe('partial');
      // 历史源保持只读：A/B 两个槽位都原样保留。
      expect(JSON.parse(readFileSync(file, 'utf8')).servers[0].env).toEqual({ A: 'a-value', B: 'b-value' });

      failing.clear();
      expect((await migrateMcpData(ctx())).state).toBe('completed');
      const saved = JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers[0];
      // A 的引用绝不能因为重试而消失。
      expect(saved.secretRefs).toEqual({ A: 'mcp.remote.env.a', B: 'mcp.remote.env.b' });
      expect(backend.store.get('mcp.remote.env.a')).toBe('a-value');
      expect(backend.store.get('mcp.remote.env.b')).toBe('b-value');
      // 源始终未被改写。
      expect(JSON.parse(readFileSync(file, 'utf8')).servers[0].env).toEqual({ A: 'a-value', B: 'b-value' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('H: slot 级 pending 持久化，重启后只重试未完成槽位且源保持只读', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-purge-resume-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    const file = join(legacy, 'servers.json');
    const original = JSON.stringify({
      servers: [{ name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'old.ref' } }],
    });
    writeFileSync(file, original);
    const store = new Map<string, string>();
    const failing = new Set(['mcp.remote.env.token']);
    const backend = flakySecrets(failing);
    const ctx = () => ({
      capabilityStoragePaths: { 'mcp.client': stable },
      capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: async () => 'secret' },
      secrets: backend.secrets,
    } as never);
    try {
      expect((await migrateMcpData(ctx())).state).toBe('partial');
      const first = JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8'));
      expect(first.pendingSlots).toHaveLength(1);
      expect(first.sourcesRetainingPlaintext).toEqual(['legacy']);

      // 重启后只重试该槽位并完成；历史源始终未变。
      failing.clear();
      expect((await migrateMcpData(ctx())).state).toBe('completed');
      expect(JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers[0].secretRefs)
        .toEqual({ TOKEN: 'mcp.remote.env.token' });
      expect(store.size).toBe(0);
      expect(backend.store.get('mcp.remote.env.token')).toBe('secret');
      expect(readFileSync(file, 'utf8')).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('I: 旧 v2 completed 标记不重导配置、不复活删除服务，也不改写历史源', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-legacy-purge-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    mkdirSync(stable);
    const file = join(legacy, 'servers.json');
    writeFileSync(file, JSON.stringify({
      servers: [
        { name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'old.ref' } },
        { name: 'deleted', command: 'node' },
      ],
    }));
    writeFileSync(join(stable, 'servers.json'), JSON.stringify({
      servers: [{ name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'mcp.remote.env.token' } }],
    }));
    writeFileSync(join(stable, 'migration.json'), JSON.stringify({
      version: 2, completed: true, sources: ['legacy'], pendingSourcePurge: ['legacy'],
    }));
    try {
      const result = await migrateMcpData({
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: vi.fn() },
        secrets: { set: vi.fn(), get: vi.fn() },
      } as never);
      expect(result.state).toBe('completed');
      const saved = JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers;
      // 不重导配置、不复活已删除服务。
      expect(saved.map((server: { name: string }) => server.name)).toEqual(['remote']);
      // 旧标记仍被识别为已完成；历史源不被改写，明文如实上报为范围外。
      expect(JSON.parse(readFileSync(file, 'utf8')).servers[0].secretRefs).toEqual({ TOKEN: 'old.ref' });
      expect(JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8')).sourcesRetainingPlaintext).toEqual(['legacy']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('J: 同槽位解析到同一引用不算冲突，可以完成', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-same-slot-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'servers.json'), JSON.stringify({
      servers: [{ name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'mcp.remote.env.token' } }],
    }));
    const store = new Map<string, string>();
    try {
      const result = await migrateMcpData({
        capabilityStoragePaths: { 'mcp.client': stable },
        capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: async () => 'secret' },
        secrets: { set: async (ref: string, value: string) => { store.set(ref, value); }, get: async (ref: string) => store.get(ref) },
      } as never);
      expect(result.state).toBe('completed');
      expect(JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers[0].secretRefs)
        .toEqual({ TOKEN: 'mcp.remote.env.token' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('M: partial 中用户删除服务后重试不复活，并记录墓碑', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-tombstone-'));
    const legacy = join(root, 'legacy');
    const stable = join(root, 'stable');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'servers.json'), JSON.stringify({
      servers: [{ name: 'remote', url: 'https://example.test', secretRefs: { TOKEN: 'old.ref' } }],
    }));
    const failing = new Set(['mcp.remote.env.token']);
    const backend = flakySecrets(failing);
    const ctx = () => ({
      capabilityStoragePaths: { 'mcp.client': stable },
      capabilityMigration: { sources: () => [{ id: 'legacy', storagePath: legacy }], readSecret: async () => 'secret' },
      secrets: backend.secrets,
    } as never);
    try {
      expect((await migrateMcpData(ctx())).state).toBe('partial');
      // 用户删除了该服务。
      writeFileSync(join(stable, 'servers.json'), JSON.stringify({ servers: [] }));
      failing.clear();

      await migrateMcpData(ctx());

      expect(JSON.parse(readFileSync(join(stable, 'servers.json'), 'utf8')).servers).toEqual([]);
      const marker = JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8'));
      expect(marker.removedServers).toEqual(['remote']);
      expect(marker.pendingSlots).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
