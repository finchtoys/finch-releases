import type * as finch from 'finch';
import { describe, expect, it } from 'vitest';
import { createOAuthCustody, migrateLegacyOAuthStorage } from './oauthCustody.js';

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

  it('is idempotent and leaves the plaintext copy when custody write fails', async () => {
    const storage = fakeStorage({ 'mcp.oauth.notion': { tokens: { access_token: 'secret' } } });
    const failing = {
      async saveCredential() { throw new Error('secure storage unavailable'); },
    } as unknown as finch.OAuth;

    expect(await migrateLegacyOAuthStorage(storage, failing)).toBe(0);
    expect(await storage.keys()).toEqual(['mcp.oauth.notion']);

    const { oauth, values } = fakeCustody();
    expect(await migrateLegacyOAuthStorage(storage, oauth)).toBe(1);
    expect(await migrateLegacyOAuthStorage(storage, oauth)).toBe(0);
    expect(values.size).toBe(1);
  });
});
