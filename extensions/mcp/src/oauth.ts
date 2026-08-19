import { createHash, randomBytes } from 'node:crypto';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export const FINCH_MCP_OAUTH_CALLBACK_URL = 'https://oauth.finchwork.app/callback';
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
  authorize(input: {
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

  constructor(
    private readonly redirect: string,
    private readonly metadata: OAuthClientMetadata,
    private readonly storage: OAuthStorage,
    private readonly key: string,
    private readonly authorizationRedirect?: (url: URL) => Promise<void>,
  ) {}

  async load(): Promise<void> {
    this.stored = await this.storage.get<StoredOAuthState>(this.key) ?? {};
  }

  get redirectUrl(): string { return this.redirect; }
  get clientMetadata(): OAuthClientMetadata { return this.metadata; }
  stateValue = createHash('sha256').update(randomBytes(48)).digest('base64url');
  state(): string { return this.stateValue; }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // Force one fresh RFC 7591 registration when Finch's declared client identity changes.
    return this.stored.clientRegistrationVersion === DCR_REGISTRATION_VERSION
      ? this.stored.clientInformation
      : undefined;
  }
  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.stored.clientInformation = value;
    this.stored.clientRegistrationVersion = DCR_REGISTRATION_VERSION;
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
    if (scope === 'all' || scope === 'client') {
      this.stored.clientInformation = undefined;
      this.stored.clientRegistrationVersion = undefined;
    }
    if (scope === 'all' || scope === 'tokens') this.stored.tokens = undefined;
    if (scope === 'all' || scope === 'discovery') this.stored.discovery = undefined;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    await this.persist();
  }
  private persist(): Promise<void> { return this.storage.set(this.key, this.stored); }
}

function clientMetadata(config: McpOAuthConfig): OAuthClientMetadata {
  return {
    redirect_uris: [FINCH_MCP_OAUTH_CALLBACK_URL],
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
): Promise<void> {
  const key = storageKey(config);
  let authorizationCode: string | undefined;
  const provider = new PersistentOAuthProvider(
    FINCH_MCP_OAUTH_CALLBACK_URL,
    clientMetadata(config),
    storage,
    key,
    async (authorizationUrl) => {
      const result = await interaction.authorize({
        providerId: FINCH_MCP_OAUTH_PERMISSION_ID,
        providerName: config.providerName ?? config.id,
        ...(config.providerIcon ? { providerIcon: config.providerIcon } : {}),
        authorizationUrl: authorizationUrl.toString(),
        state: provider.stateValue,
        callbackUrl: FINCH_MCP_OAUTH_CALLBACK_URL,
      });
      authorizationCode = result.code;
    },
  );
  await provider.load();
  const first = await auth(provider, {
    serverUrl,
    scope: config.scopes?.join(' '),
  });
  if (first === 'AUTHORIZED') return;
  if (!authorizationCode) throw new Error('MCP OAuth callback did not return an authorization code');
  await auth(provider, {
    serverUrl,
    authorizationCode,
    scope: config.scopes?.join(' '),
  });
}

export async function createMcpOAuthProvider(
  config: McpOAuthConfig,
  storage: OAuthStorage,
): Promise<OAuthClientProvider> {
  const key = storageKey(config);
  const provider = new PersistentOAuthProvider(
    FINCH_MCP_OAUTH_CALLBACK_URL,
    clientMetadata(config),
    storage,
    key,
  );
  await provider.load();
  return provider;
}

export async function clearMcpOAuth(config: McpOAuthConfig, storage: OAuthStorage): Promise<void> {
  await storage.delete(storageKey(config));
}
