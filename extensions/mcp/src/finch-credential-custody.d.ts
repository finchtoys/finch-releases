/**
 * Credential custody, as seen by this extension.
 *
 * Deliberately not part of the published `finch.d.ts`: the public mini-tool API is a frozen
 * contract, and handing an arbitrary extension a write channel into Finch's encrypted credential
 * store is not something we want to advertise before the security model for third parties is
 * settled. MCP is bundled and first-party, so it declares the shape locally instead.
 *
 * Keep this in sync with `OAuth` in `src/shared/extension-api.ts`, which is the real contract the
 * extension host implements.
 */
declare module 'finch' {
  /** A credential the mini tool obtained itself and hands to Finch for encrypted storage. */
  export type OAuthCredentialValue = Record<string, unknown>;

  export interface OAuthCredentialRef {
    /** Provider id declared in manifest permissions.oauth. */
    providerId: string;
    /** Account inside that provider, e.g. one MCP server. Lowercase `a-z0-9._-`. */
    account?: string;
    /** Name shown in Finch's connected-accounts list. */
    displayName?: string;
  }

  export interface OAuth {
    saveCredential(ref: OAuthCredentialRef, credential: OAuthCredentialValue): Promise<void>;
    getCredential(ref: OAuthCredentialRef): Promise<OAuthCredentialValue | undefined>;
    deleteCredential(ref: OAuthCredentialRef): Promise<void>;
  }
}
