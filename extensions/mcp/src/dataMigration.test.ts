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
    const setSecret = vi.fn(async () => {});
    const saveCredential = vi.fn(async () => {});
    const getCredential = vi.fn(async () => undefined);
    const ctx = {
      storagePath: legacy,
      capabilityStoragePaths: { 'mcp.client': stable },
      capabilityMigration: {
        sources: () => [{ id: 'mcp', storagePath: legacy }],
        readSecret: async () => 'api-secret',
      },
      secrets: { set: setSecret },
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
      expect(JSON.parse(readFileSync(join(stable, 'migration.json'), 'utf8'))).toMatchObject({ completed: true, version: 1 });
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
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
