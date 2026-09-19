import { createHash, randomBytes } from 'node:crypto';
import { auth } from '@modelcontextprotocol/client';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from '@modelcontextprotocol/client';

/**
 * HTTPS relay callback for the running Finch build.
 *
 * Projected by the host (`FINCH_OAUTH_RELAY_CALLBACK`) because the relay uses its
 * `env` marker to decide which deep-link scheme returns the authorization code:
 * Dev registers `?env=dev` and comes back through `finch-dev://`, Prod keeps
 * `finch://`. Older hosts do not project the value, so the production callback
 * stays the fallback.
 */
export const FINCH_MCP_OAUTH_CALLBACK_URL =
  process.env.FINCH_OAUTH_RELAY_CALLBACK?.trim() || 'https://oauth.finchwork.app/callback';
export const FINCH_MCP_OAUTH_PERMISSION_ID = 'mcp';
const DCR_REGISTRATION_VERSION = 5;

export interface McpOAuthConfig {
  /** Stable storage id for this MCP OAuth connection. */
  id: string;
  /** User-facing OAuth provider name, e.g. "Notion MCP". */
  providerName?: string;
  /** Provider logo owned by the contributing extension, as `finch-ext-icon://<scope>/<package>/<file>.png`.
   *  Finch only accepts an icon that the owning extension declared in `contributes.mcpServers[].oauth.providerIcon`. */
  providerIcon?: string;
  /** Optional scopes. Discovery metadata is used when omitted. */
  scopes?: string[];
  clientName?: string;
  clientUri?: string;
}

/**
 * Where the persistent half of an MCP OAuth connection lives.
 *
 * Backed by Finch's encrypted credential custody rather than the extension's own storage: these
 * records hold access and refresh tokens, and an extension's `ctx.storage` is plaintext JSON.
 */
export interface OAuthStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OAuthInteraction {
  initiateAuthorization(input: {
    providerId: string;
    providerName: string;
    providerIcon?: string;
    authorizationUrl: string;
    state: string;
    callbackUrl: string;
  }): Promise<{ code: string }>;
}

interface StoredOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  clientRegistrationVersion?: number;
  /** Redirect URI the stored client was registered with; a different one needs a new registration. */
  clientRegistrationRedirect?: string;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
}

function storageKey(config: McpOAuthConfig): string {
  const id = config.id.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  if (!id) throw new Error('MCP OAuth id is required');
  return `mcp.oauth.${id}`;
}

class PersistentOAuthProvider implements OAuthClientProvider {
  private stored: StoredOAuthState = {};
  /**
   * PKCE verifier, in memory only.
   *
   * It is single-use and lives exactly as long as one authorization: both `auth()` calls run
   * inside `authorizeMcpOAuth`. Persisting it would put the one secret that protects the code
   * exchange on disk in exchange for surviving a restart the flow cannot survive anyway.
   */
  private verifier?: string;
  private credentialsInvalidated = false;

  constructor(
    private readonly redirect: string,
    private readonly metadata: OAuthClientMetadata,
    private readonly storage: OAuthStorage,
    private readonly key: string,
    private readonly authorizationRedirect?: (url: URL) => Promise<void>,
  ) {}

  async load(): Promise<void> {
    this.stored = structuredClone(await this.storage.get<StoredOAuthState>(this.key) ?? {});
  }

  get redirectUrl(): string { return this.redirect; }
  get clientMetadata(): OAuthClientMetadata { return this.metadata; }
  stateValue = createHash('sha256').update(randomBytes(48)).digest('base64url');
  state(): string { return this.stateValue; }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // Force one fresh RFC 7591 registration when Finch's declared client identity
    // changes — including the redirect URI, which varies by build flavor now that
    // Dev registers the relay URL carrying `?env=dev`.
    const registered = this.stored.clientRegistrationVersion === DCR_REGISTRATION_VERSION
      && this.stored.clientRegistrationRedirect === this.redirect;
    return registered ? this.stored.clientInformation : undefined;
  }
  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.stored.clientInformation = value;
    this.stored.clientRegistrationVersion = DCR_REGISTRATION_VERSION;
    this.stored.clientRegistrationRedirect = this.redirect;
    await this.persist();
  }
  tokens(): OAuthTokens | undefined { return this.stored.tokens; }
  async saveTokens(value: OAuthTokens): Promise<void> {
    this.stored.tokens = value;
    await this.persist();
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.authorizationRedirect) throw new Error('MCP OAuth authorization is required; connect the server again');
    await this.authorizationRedirect(url);
  }
  async saveCodeVerifier(value: string): Promise<void> {
    this.verifier = value;
  }
  async codeVerifier(): Promise<string> {
    if (!this.verifier) throw new Error('MCP OAuth PKCE verifier is missing');
    return this.verifier;
  }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    this.stored.discovery = value;
    await this.persist();
  }
  discoveryState(): OAuthDiscoveryState | undefined { return this.stored.discovery; }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    // SDK 已判定失效的 client/token，不能因为随后取消交互而恢复。
    if (scope === 'all' || scope === 'client' || scope === 'tokens') this.credentialsInvalidated = true;
    if (scope === 'all' || scope === 'client') {
      this.stored.clientInformation = undefined;
      this.stored.clientRegistrationVersion = undefined;
      this.stored.clientRegistrationRedirect = undefined;
    }
    if (scope === 'all' || scope === 'tokens') this.stored.tokens = undefined;
    if (scope === 'all' || scope === 'discovery') this.stored.discovery = undefined;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    await this.persist();
  }
  hasInvalidatedCredentials(): boolean { return this.credentialsInvalidated; }
  clearCodeVerifier(): void { this.verifier = undefined; }
  private persist(): Promise<void> { return this.storage.set(this.key, this.stored); }
}

function isAuthorizationCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // 只识别现有宿主交互和 OAuth 用户拒绝信号，不把网络错误或超时当作取消。
  return message === 'OAuth login cancelled' || message === '登录已取消' || message === 'access_denied';
}

export function requiresMcpOAuthAuthorization(
  previous: { url: string; oauth?: McpOAuthConfig } | undefined,
  next: { url: string; oauth?: McpOAuthConfig },
): boolean {
  if (!next.oauth) return false;
  if (!previous?.oauth) return true;
  const scopes = (value: string[] | undefined) => [...new Set(value ?? [])].sort().join(' ');
  return previous.url !== next.url || previous.oauth.id !== next.oauth.id
    || scopes(previous.oauth.scopes) !== scopes(next.oauth.scopes);
}

function clientMetadata(config: McpOAuthConfig, callbackUrl: string): OAuthClientMetadata {
  return {
    redirect_uris: [callbackUrl],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: config.clientName ?? 'Finch',
    client_uri: config.clientUri ?? 'https://finchwork.app',
    logo_uri: 'https://finchwork.app/assets/icon.svg',
    scope: config.scopes?.join(' '),
  };
}

export async function authorizeMcpOAuth(
  serverUrl: string,
  config: McpOAuthConfig,
  storage: OAuthStorage,
  interaction: OAuthInteraction,
  forceAuthorization = false,
): Promise<void> {
  const key = storageKey(config);
  const previousState = await storage.get<StoredOAuthState>(key);
  const rollbackState = previousState === undefined ? undefined : structuredClone(previousState);
  const callbackUrl = FINCH_MCP_OAUTH_CALLBACK_URL;
  let authorizationCode: string | undefined;
  let cancelled = false;
  let exchangingCode = false;
  const provider = new PersistentOAuthProvider(
    callbackUrl,
    clientMetadata(config, callbackUrl),
    storage,
    key,
    async (authorizationUrl) => {
      try {
        const result = await interaction.initiateAuthorization({
          providerId: FINCH_MCP_OAUTH_PERMISSION_ID,
          providerName: config.providerName ?? config.id,
          ...(config.providerIcon ? { providerIcon: config.providerIcon } : {}),
          authorizationUrl: authorizationUrl.toString(),
          state: provider.stateValue,
          callbackUrl,
        });
        authorizationCode = result.code;
      } catch (error) {
        cancelled = isAuthorizationCancelled(error);
        throw error;
      }
    },
  );
  try {
    await provider.load();
    // 普通连接先使用已有凭据；过期和鉴权挑战仍由 SDK transport 处理。
    if (!forceAuthorization && provider.tokens()?.access_token && provider.clientInformation()) return;
    const first = await auth(provider, {
      serverUrl,
      scope: config.scopes?.join(' '),
      forceReauthorization: forceAuthorization,
    });
    if (first === 'AUTHORIZED') return;
    if (!authorizationCode) throw new Error('MCP OAuth callback did not return an authorization code');
    exchangingCode = true;
    const exchanged = await auth(provider, {
      serverUrl,
      authorizationCode,
      scope: config.scopes?.join(' '),
    });
    if (exchanged !== 'AUTHORIZED') throw new Error('MCP OAuth authorization code exchange did not complete');
  } catch (error) {
    if (cancelled && !exchangingCode && !provider.hasInvalidatedCredentials()) {
      try {
        if (rollbackState === undefined) await storage.delete(key);
        else await storage.set(key, rollbackState);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'MCP OAuth cancellation could not restore the previous credential state');
      }
    }
    throw error;
  } finally {
    provider.clearCodeVerifier();
  }
}

export async function createMcpOAuthProvider(
  config: McpOAuthConfig,
  storage: OAuthStorage,
): Promise<OAuthClientProvider> {
  const key = storageKey(config);
  const callbackUrl = FINCH_MCP_OAUTH_CALLBACK_URL;
  const provider = new PersistentOAuthProvider(
    callbackUrl,
    clientMetadata(config, callbackUrl),
    storage,
    key,
  );
  await provider.load();
  return provider;
}

export async function clearMcpOAuth(config: McpOAuthConfig, storage: OAuthStorage): Promise<void> {
  await storage.delete(storageKey(config));
}
