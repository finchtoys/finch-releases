import type * as finch from 'finch';
import { FINCH_MCP_OAUTH_PERMISSION_ID, type McpOAuthConfig, type OAuthStorage } from './oauth.js';

/** Prefix of the plaintext keys this extension used before credentials moved into Finch custody. */
const LEGACY_KEY_PREFIX = 'mcp.oauth.';
const LEGACY_VERIFIER_SUFFIX = '.verifier';

/** `mcp.oauth.notion` → `notion`. The MCP SDK addresses state by key, Finch custody by account. */
function accountFromKey(key: string): string {
  const account = key.startsWith(LEGACY_KEY_PREFIX) ? key.slice(LEGACY_KEY_PREFIX.length) : key;
  if (!account) throw new Error('MCP OAuth storage key is empty');
  return account;
}

/**
 * Finch custody stores objects, while the MCP provider persists one state blob per server.
 * Wrapping keeps the record shape stable even if the SDK ever hands us a non-object value.
 */
function wrap(value: unknown): finch.OAuthCredentialValue {
  return { value: value as never };
}

/**
 * Persist MCP OAuth state in Finch's encrypted credential store.
 *
 * The MCP SDK owns the protocol — discovery, dynamic client registration and the token exchange
 * all happen inside this extension — so Finch cannot broker this connection. It can still hold the
 * result: `ctx.storage` is plaintext JSON on disk, and this state contains access and refresh
 * tokens.
 */
export function createOAuthCustody(oauth: finch.OAuth, config: McpOAuthConfig): OAuthStorage {
  const ref = (key: string): finch.OAuthCredentialRef => ({
    providerId: FINCH_MCP_OAUTH_PERMISSION_ID,
    account: accountFromKey(key),
    displayName: config.providerName ?? config.id,
  });
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const record = await oauth.getCredential(ref(key));
      return record?.value as T | undefined;
    },
    async set(key, value) {
      await oauth.saveCredential(ref(key), wrap(value));
    },
    async delete(key) {
      await oauth.deleteCredential(ref(key));
    },
  };
}

/**
 * Move credentials written by earlier versions out of plaintext storage.
 *
 * Write-then-delete, so an interruption leaves a duplicate rather than a lost login; re-running
 * simply overwrites custody with the same value. PKCE verifiers are dropped instead of migrated —
 * they are single-use and any flow that could still need one died with the process that started
 * it. Returns the number of migrated credentials.
 */
export async function migrateLegacyOAuthStorage(
  storage: finch.Storage,
  oauth: finch.OAuth,
  logger?: finch.Logger,
): Promise<number> {
  let migrated = 0;
  for (const key of await storage.keys()) {
    if (!key.startsWith(LEGACY_KEY_PREFIX)) continue;
    try {
      if (key.endsWith(LEGACY_VERIFIER_SUFFIX)) {
        await storage.delete(key);
        continue;
      }
      const value = await storage.get(key);
      if (value !== undefined) {
        await oauth.saveCredential(
          { providerId: FINCH_MCP_OAUTH_PERMISSION_ID, account: accountFromKey(key) },
          wrap(value),
        );
        migrated += 1;
      }
      await storage.delete(key);
    } catch (error) {
      // A failed migration keeps the plaintext copy and retries next activation. Never log the value.
      logger?.warn(`MCP OAuth credential migration failed for "${key}"`, error);
    }
  }
  return migrated;
}
