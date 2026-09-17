import type * as finch from 'finch';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOAuthCustody, migrateLegacyOAuthStorage, migrateLegacyOAuthStorageFile } from './oauthCustody.js';

/** Plaintext extension storage, i.e. what MCP credentials used to live in. */
function fakeStorage(initial: Record<string, unknown> = {}): finch.Storage {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) { return values.get(key) as never; },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async clear() { values.clear(); },
    async keys() { return [...values.keys()]; },
  };
}

function fakeCustody() {
  const values = new Map<string, finch.OAuthCredentialValue>();
  const refs: finch.OAuthCredentialRef[] = [];
  const oauth = {
    async saveCredential(ref: finch.OAuthCredentialRef, credential: finch.OAuthCredentialValue) {
      refs.push(ref);
      values.set(`${ref.providerId}/${ref.account ?? ''}`, credential);
    },
    async getCredential(ref: finch.OAuthCredentialRef) {
      return values.get(`${ref.providerId}/${ref.account ?? ''}`);
    },
    async deleteCredential(ref: finch.OAuthCredentialRef) {
      values.delete(`${ref.providerId}/${ref.account ?? ''}`);
    },
  } as unknown as finch.OAuth;
  return { oauth, values, refs };
}

describe('MCP OAuth credential custody', () => {
  it('round-trips provider state through Finch custody instead of extension storage', async () => {
    const { oauth, refs } = fakeCustody();
    const storage = createOAuthCustody(oauth, { id: 'notion', providerName: 'Notion MCP' });

    await storage.set('mcp.oauth.notion', { tokens: { access_token: 'secret' } });

    expect(await storage.get('mcp.oauth.notion')).toEqual({ tokens: { access_token: 'secret' } });
    expect(refs[0]).toEqual({ providerId: 'mcp', account: 'notion', displayName: 'Notion MCP' });

    await storage.delete('mcp.oauth.notion');
    expect(await storage.get('mcp.oauth.notion')).toBeUndefined();
  });

  it('moves legacy plaintext credentials into custody and drops stale PKCE verifiers', async () => {
    const storage = fakeStorage({
      'mcp.oauth.notion': { tokens: { access_token: 'secret' } },
      'mcp.oauth.notion.verifier': 'pkce-verifier',
      'servers': [{ name: 'unrelated' }],
    });
    const { oauth, values } = fakeCustody();

    expect(await migrateLegacyOAuthStorage(storage, oauth)).toBe(1);

    expect(await storage.keys()).toEqual(['servers']);
    expect(values.get('mcp/notion')).toEqual({ value: { tokens: { access_token: 'secret' } } });
  });

  it('moves credentials from a historical storage.json without touching unrelated keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-oauth-file-'));
    const legacy = join(root, 'extension-data', 'mcp');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'storage.json'), JSON.stringify({
      'mcp.oauth.notion': { tokens: { access_token: 'secret' } },
      'mcp.oauth.notion.verifier': 'stale',
      unrelated: { keep: true },
    }));
    const { oauth, values } = fakeCustody();
    try {
      expect(await migrateLegacyOAuthStorageFile(legacy, oauth)).toBe(1);
      expect(values.get('mcp/notion')).toEqual({ value: { tokens: { access_token: 'secret' } } });
      expect(JSON.parse(readFileSync(join(legacy, 'storage.json'), 'utf8'))).toEqual({ unrelated: { keep: true } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('托管写入失败时阻止激活并保留原数据，重试成功后清理且保持幂等', async () => {
    const storage = fakeStorage({ 'mcp.oauth.notion': { tokens: { access_token: 'secret' } } });
    const failing = {
      async saveCredential() { throw new Error('secure storage unavailable'); },
    } as unknown as finch.OAuth;

    await expect(migrateLegacyOAuthStorage(storage, failing)).rejects.toThrow('secure storage unavailable');
    expect(await storage.keys()).toEqual(['mcp.oauth.notion']);

    const { oauth, values } = fakeCustody();
    expect(await migrateLegacyOAuthStorage(storage, oauth)).toBe(1);
    expect(await migrateLegacyOAuthStorage(storage, oauth)).toBe(0);
    expect(values.size).toBe(1);
  });
});

describe('MCP OAuth 迁移失败边界', () => {
  it.each(['{invalid', '[]', 'null'])('损坏的历史源阻止迁移且原样保留：%s', async (source) => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-oauth-invalid-'));
    const file = join(root, 'storage.json');
    writeFileSync(file, source);
    const { oauth, refs } = fakeCustody();
    const logger = { warn: vi.fn() } as unknown as finch.Logger;
    try {
      await expect(migrateLegacyOAuthStorageFile(root, oauth, logger)).rejects.toThrow('invalid or unreadable');
      expect(readFileSync(file, 'utf8')).toBe(source);
      expect(refs).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith('mcp.oauth.credential-migration.failed', {
        source: 'historical', stage: 'read',
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('历史源部分写入失败时不改原文件，恢复后可重试且不会复活已退出的登录', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-oauth-retry-'));
    const file = join(root, 'storage.json');
    const source = JSON.stringify({
      'mcp.oauth.first': { token: 'first-fixture' },
      'mcp.oauth.second': { token: 'second-fixture' },
      unrelated: true,
    });
    writeFileSync(file, source);
    const { oauth, values } = fakeCustody();
    const save = oauth.saveCredential.bind(oauth);
    let fail = true;
    oauth.saveCredential = async (ref, credential) => {
      if (fail && ref.account === 'second') throw new Error('fixture-sensitive-error');
      await save(ref, credential);
    };
    const logger = { warn: vi.fn() } as unknown as finch.Logger;
    try {
      await expect(migrateLegacyOAuthStorageFile(root, oauth, logger)).rejects.toThrow('fixture-sensitive-error');
      expect(readFileSync(file, 'utf8')).toBe(source);
      expect(logger.warn).toHaveBeenCalledWith('mcp.oauth.credential-migration.failed', {
        source: 'historical', stage: 'save',
      });
      fail = false;
      expect(await migrateLegacyOAuthStorageFile(root, oauth)).toBe(2);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ unrelated: true });
      values.clear();
      expect(await migrateLegacyOAuthStorageFile(root, oauth)).toBe(0);
      expect(values.size).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('当前源清理失败同样抛错，恢复后能重试完成清理', async () => {
    const storage = fakeStorage({ 'mcp.oauth.notion': { token: 'fixture' } });
    const originalDelete = storage.delete.bind(storage);
    storage.delete = vi.fn().mockRejectedValueOnce(new Error('cleanup failed'))
      .mockImplementation(originalDelete);
    const { oauth, values } = fakeCustody();
    await expect(migrateLegacyOAuthStorage(storage, oauth)).rejects.toThrow('cleanup failed');
    expect(await storage.keys()).toEqual(['mcp.oauth.notion']);
    expect(values.size).toBe(1);
    expect(await migrateLegacyOAuthStorage(storage, oauth)).toBe(1);
    expect(await storage.keys()).toEqual([]);
  });
});
