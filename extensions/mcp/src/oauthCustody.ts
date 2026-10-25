import type * as finch from 'finch';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * Save a credential into Finch custody and read it back before returning.
 *
 * The caller only deletes the plaintext source after this resolves, so a
 * silently failed or lossy write can never remove the last copy of a token.
 */
async function saveCredentialVerified(
  oauth: finch.OAuth,
  ref: finch.OAuthCredentialRef,
  value: unknown,
): Promise<void> {
  await oauth.saveCredential(ref, wrap(value));
  const readBack = await oauth.getCredential(ref);
  // A valid record with an equivalent value is required: an empty object (or a
  // record without `value`) is NOT proof that the credential was written.
  if (!readBack || typeof readBack !== 'object' || Object.keys(readBack).length === 0) {
    throw new Error('MCP OAuth custody write verification failed');
  }
  if (!('value' in readBack)) throw new Error('MCP OAuth custody write verification failed');
  if (JSON.stringify(readBack.value) !== JSON.stringify(value)) {
    throw new Error('MCP OAuth custody write verification failed');
  }
}

/**
 * Move credentials written by earlier versions out of plaintext storage.
 *
 * Write-then-verify-then-delete: the plaintext copy is only removed after custody
 * has been read back, and an interruption leaves a duplicate rather than a lost
 * login. When custody already holds a credential the current target wins — the
 * legacy plaintext is dropped instead of overwriting it. PKCE verifiers are
 * dropped instead of migrated — they are single-use and any flow that could
 * still need one died with the process that started it. Returns the number of
 * migrated credentials.
 */
export async function migrateLegacyOAuthStorage(
  storage: finch.Storage,
  oauth: finch.OAuth,
  logger?: finch.Logger,
): Promise<number> {
  let migrated = 0;
  let retained = 0;
  for (const key of await storage.keys()) {
    if (!key.startsWith(LEGACY_KEY_PREFIX)) continue;
    try {
      if (key.endsWith(LEGACY_VERIFIER_SUFFIX)) {
        // Retained, not deleted: without a reliable source-version proof this
        // migration never mutates its source (see below).
        retained += 1;
        continue;
      }
      const value = await storage.get(key);
      if (value !== undefined) {
        const ref = { providerId: FINCH_MCP_OAUTH_PERMISSION_ID, account: accountFromKey(key) };
        // Current target wins: never overwrite a newer custody credential with a
        // legacy plaintext one. Only an actual import is counted — the retained
        // source is re-seen on every run.
        if (await oauth.getCredential(ref) === undefined) {
          await saveCredentialVerified(oauth, ref, value);
          migrated += 1;
        }
      }
      // The source is READ-ONLY here: `ctx.storage` has no CAS, so a value written
      // while we awaited the custody write would be destroyed by a snapshot-based
      // delete. Keeping the source is the safe choice; it is reported instead.
      retained += 1;
    } catch (error) {
      // 不记录凭据或原始异常内容；失败向上传播以阻止激活，且保留明文源。
      logger?.warn('mcp.oauth.credential-migration.failed', { source: 'current' });
      throw error;
    }
  }
  if (retained > 0) logger?.warn('mcp.oauth.credential-migration.retained', { source: 'current', retained });
  return migrated;
}

/** Migrate OAuth keys from a historical extension storage file no longer backing ctx.storage. */
export async function migrateLegacyOAuthStorageFile(
  storagePath: string,
  oauth: finch.OAuth,
  logger?: finch.Logger,
): Promise<number> {
  const file = join(storagePath, 'storage.json');
  if (!existsSync(file)) return 0;

  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid storage root');
    data = parsed as Record<string, unknown>;
  } catch (error) {
    logger?.warn('mcp.oauth.credential-migration.failed', { source: 'historical', stage: 'read' });
    throw new Error('MCP legacy OAuth storage is invalid or unreadable');
  }

  let migrated = 0;
  let retained = 0;
  for (const key of Object.keys(data)) {
    if (!key.startsWith(LEGACY_KEY_PREFIX)) continue;
    try {
      if (!key.endsWith(LEGACY_VERIFIER_SUFFIX) && data[key] !== undefined) {
        const ref = { providerId: FINCH_MCP_OAUTH_PERMISSION_ID, account: accountFromKey(key) };
        if (await oauth.getCredential(ref) === undefined) {
          await saveCredentialVerified(oauth, ref, data[key]);
          migrated += 1;
        }
      }
      // READ-ONLY source: rewriting the file from a pre-await snapshot would drop
      // any key written in the meantime. Keep it and report it.
      retained += 1;
    } catch (error) {
      logger?.warn('mcp.oauth.credential-migration.failed', { source: 'historical', stage: 'save' });
      throw error;
    }
  }
  if (retained > 0) logger?.warn('mcp.oauth.credential-migration.retained', { source: 'historical', retained });
  return migrated;
}
