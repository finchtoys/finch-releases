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

  it('imports legacy plaintext into custody and RETAINS every source key', async () => {
    const initial = {
      'mcp.oauth.notion': { tokens: { access_token: 'secret' } },
      'mcp.oauth.notion.verifier': 'pkce-verifier',
      'servers': [{ name: 'unrelated' }],
    };
    const storage = fakeStorage(initial);
    const { oauth, values } = fakeCustody();

    expect(await migrateLegacyOAuthStorage(storage, oauth)).toBe(1);

    // 源是只读的：没有任何清理，明文键仍然存在。
    expect(await storage.keys()).toEqual(Object.keys(initial));
    expect(values.get('mcp/notion')).toEqual({ value: { tokens: { access_token: 'secret' } } });
  });

  it('当前源在保存/回读期间被更新时，新的明文值与无关新字段都原样保留', async () => {
    const storage = fakeStorage({ 'mcp.oauth.notion': { token: 'old-plaintext' } });
    const { oauth } = fakeCustody();
    const save = oauth.saveCredential.bind(oauth);
    let updated = false;
    oauth.saveCredential = async (ref, credential) => {
      await save(ref, credential);
      if (!updated) {
        // 在 await 期间用户重新登录：源被写成 new，并加了无关字段。
        updated = true;
        await storage.set('mcp.oauth.notion', { token: 'new-plaintext' });
        await storage.set('mcp.oauth.other', { challenge: 'x' });
      }
    };

    await migrateLegacyOAuthStorage(storage, oauth);

    // 旧快照绝不能删掉/覆盖 await 期间写入的新值和无关新字段。
    expect(await storage.get('mcp.oauth.notion')).toEqual({ token: 'new-plaintext' });
    expect(await storage.get('mcp.oauth.other')).toEqual({ challenge: 'x' });
  });

  it('imports from a historical storage.json and leaves the file byte-identical', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-oauth-file-'));
    const legacy = join(root, 'extension-data', 'mcp');
    mkdirSync(legacy, { recursive: true });
    const source = JSON.stringify({
      'mcp.oauth.notion': { tokens: { access_token: 'secret' } },
      'mcp.oauth.notion.verifier': 'stale',
      unrelated: { keep: true },
    });
    writeFileSync(join(legacy, 'storage.json'), source);
    const { oauth, values } = fakeCustody();
    try {
      expect(await migrateLegacyOAuthStorageFile(legacy, oauth)).toBe(1);
      expect(values.get('mcp/notion')).toEqual({ value: { tokens: { access_token: 'secret' } } });
      expect(readFileSync(join(legacy, 'storage.json'), 'utf8')).toBe(source);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('托管写入失败时阻止激活并保留原数据，恢复后可重试且幂等（不做源清理）', async () => {
    const storage = fakeStorage({ 'mcp.oauth.notion': { tokens: { access_token: 'secret' } } });
    const failing = {
      async getCredential() { return undefined; },
      async saveCredential() { throw new Error('secure storage unavailable'); },
    } as unknown as finch.OAuth;

    await expect(migrateLegacyOAuthStorage(storage, failing)).rejects.toThrow('secure storage unavailable');
    expect(await storage.keys()).toEqual(['mcp.oauth.notion']);

    const { oauth, values } = fakeCustody();
    expect(await migrateLegacyOAuthStorage(storage, oauth)).toBe(1);
    // 第二次运行：custody 已有该账户，因此不再导入；源仍然保留。
    expect(await migrateLegacyOAuthStorage(storage, oauth)).toBe(0);
    expect(await storage.keys()).toEqual(['mcp.oauth.notion']);
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

  it('历史源部分写入失败时不改原文件，恢复后可重试（源全程只读）', async () => {
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
      // 只有未完成的那一条真正导入（first 在首次运行已进 custody）。
      expect(await migrateLegacyOAuthStorageFile(root, oauth)).toBe(1);
      // 任何阶段都不重写历史文件。
      expect(readFileSync(file, 'utf8')).toBe(source);
      // custody 已完整：再次运行不再导入。
      expect(await migrateLegacyOAuthStorageFile(root, oauth)).toBe(0);
      expect(values.size).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('当前源从不被删除：清理阶段不存在，源保持原样', async () => {
    const storage = fakeStorage({ 'mcp.oauth.notion': { token: 'fixture' } });
    const remove = vi.fn();
    storage.delete = remove;
    const { oauth, values } = fakeCustody();

    expect(await migrateLegacyOAuthStorage(storage, oauth)).toBe(1);

    expect(remove).not.toHaveBeenCalled();
    expect(await storage.keys()).toEqual(['mcp.oauth.notion']);
    expect(values.size).toBe(1);
  });

  it('当前目标优先：已有的托管凭据不被旧明文覆盖', async () => {
    const storage = fakeStorage({ 'mcp.oauth.notion': { tokens: { access_token: 'stale-plaintext' } } });
    const { oauth, values } = fakeCustody();
    values.set('mcp/notion', { value: { tokens: { access_token: 'current-custody' } } });

    // 目标已有凭据：不导入、不覆盖；明文源保留（不清理）。
    expect(await migrateLegacyOAuthStorage(storage, oauth)).toBe(0);
    expect(await storage.keys()).toEqual(['mcp.oauth.notion']);
    expect(values.get('mcp/notion')).toEqual({ value: { tokens: { access_token: 'current-custody' } } });
  });

  it('保存后回读为空视为失败，不删除明文源', async () => {
    const storage = fakeStorage({ 'mcp.oauth.notion': { tokens: { access_token: 'secret' } } });
    const oauth = {
      async getCredential() { return undefined; },
      async saveCredential() { /* silently persists nothing */ },
    } as unknown as finch.OAuth;

    await expect(migrateLegacyOAuthStorage(storage, oauth)).rejects.toThrow('verification failed');
    expect(await storage.keys()).toEqual(['mcp.oauth.notion']);
  });

  it('历史文件迁移同样不覆盖已有托管凭据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finch-mcp-oauth-target-'));
    const file = join(root, 'storage.json');
    writeFileSync(file, JSON.stringify({ 'mcp.oauth.notion': { tokens: { access_token: 'stale' } } }));
    const { oauth, values } = fakeCustody();
    values.set('mcp/notion', { value: { tokens: { access_token: 'current' } } });
    try {
      expect(await migrateLegacyOAuthStorageFile(root, oauth)).toBe(0);
      // 历史文件不被改写。
      expect(JSON.parse(readFileSync(file, 'utf8'))['mcp.oauth.notion']).toEqual({ tokens: { access_token: 'stale' } });
      expect(values.get('mcp/notion')).toEqual({ value: { tokens: { access_token: 'current' } } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
