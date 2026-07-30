# OAuth

Use `ctx.oauth` when a mini tool needs OAuth 2.0 user authorization. Finch supports Authorization Code + PKCE and Device Flow public clients, and owns the browser interaction, encrypted credential storage, refresh locking, and Authorization header injection.

## Which OAuth path do I need?

Finch has **two separate OAuth paths**. Pick exactly one per service — they do not stack.

| | **A · Mini tool owns the provider** | **B · OAuth-protected MCP server** |
|---|---|---|
| Use when | Calling a normal HTTPS API (Google, GitHub, …) | Connecting a remote MCP endpoint that requires OAuth |
| OAuth client | You register it with the provider ahead of time and ship the public Client ID | None to register — MCP Client performs RFC 7591 DCR at connect time |
| You declare | `permissions.oauth: ["<id>"]` + an `OAuthProviderConfig` in code | `contributes.mcpServers[].oauth` in `finch.json` |
| Brand logo | `OAuthProviderConfig.icon` — relative PNG | `mcpServers[].oauth.providerIcon` — relative PNG |
| Who holds tokens | Finch core (brokered); you never read them | MCP Client; you never read them |
| You call the API via | `ctx.oauth.request()` | the `mcp__<server>__<tool>` tools |
| Starts the flow | `ctx.oauth.connect()` | `mcp.client#connectServer()` |
| Documented in | This file | `mcp.md` §5 |

Path B needs **no** `permissions.oauth` entry — that permission belongs to MCP Client, not to your mini tool. If you find yourself declaring both `permissions.oauth` and `mcpServers[].oauth` for the same service, you have almost certainly picked the wrong path.

Both paths reuse the same Finch native consent card, browser driver, HTTPS callback relay, cancellation, and timeout. The difference is only who owns the OAuth client and who holds the tokens.

The rest of this file describes path A.

### Security model

- Declare every provider id in `permissions.oauth` (in `finch.json`).
- The mini-tool developer supplies the public Client ID, endpoints, scopes, resource origins, **and a provider brand icon** in the mini-tool package. Users only approve and complete the Finch-managed login flow; never ask users to configure OAuth plumbing.
- Use Authorization Code + PKCE public clients by default. Use Device Flow for providers such as GitHub that require a secret for Web Flow but support secretless device authorization. Do not embed a confidential client secret.
- Credentials are stored under `<finchHome>/extension-data/<extensionId>/oauth/`.
- Each mini tool has a separate credential and connection store.
- For brokered `connect()` / `request()` providers, access and refresh tokens never cross into the mini-tool host process.
- `resourceOrigins` is an HTTPS allowlist for brokered requests.
- `ctx.oauth.request()` strips caller-supplied Authorization, Cookie, Host, and Proxy-Authorization headers.

### Provider branding (strongly recommended)

Set `icon` on every standard `OAuthProviderConfig` to the provider's PNG logo packaged with the mini tool, for example `assets/google.png`. Finch converts this optional field into the `providerIcon` shown in its native authorization and Device Flow dialogs.

Use a provider-owned or licensed PNG, keep it in the mini-tool package, and include its directory in `package.json#files`. Remote URLs, SVG files, and paths outside the mini-tool directory are rejected. Omitting `icon` is supported for backward compatibility, but leaves the authorization UI without the provider brand.

For the advanced `initiateAuthorization()` API, configure its separate `providerIcon` field instead. It must be a trusted packaged PNG URL in the form `finch-ext-icon://<extensionId>/assets/provider.png`; it is not an arbitrary remote URL.

### Manifest

```json
{
  "permissions": {
    "oauth": ["google"]
  }
}
```

### Provider and usage

```ts
const GOOGLE_CLIENT_ID = 'public-client-id-owned-by-the-mini-tool-publisher';

const google: finch.OAuthProviderConfig = {
  id: 'google',
  name: 'Google',
  icon: 'assets/google.png', // Recommended: becomes Finch's native providerIcon.
  clientId: GOOGLE_CLIENT_ID,
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  resourceOrigins: ['https://gmail.googleapis.com'],
  authorizationParams: {
    access_type: 'offline',
    prompt: 'consent',
  },
};

await ctx.oauth.connect(google);
const status = await ctx.oauth.getStatus(google);
const response = await ctx.oauth.request(
  google,
  'https://gmail.googleapis.com/gmail/v1/users/me/profile',
);
await ctx.oauth.disconnect(google);
```

`OAuthResponse.body` is a string. Parse JSON only after checking the HTTP status. Never log response bodies that may contain private user data.

### Advanced protocol interaction

`ctx.oauth.initiateAuthorization()` is a low-level interaction bridge for protocol clients such as the official MCP SDK that already construct their own authorization URL and perform their own token exchange. It reuses Finch's native consent card, browser driver, HTTPS callback relay, `finch://oauth/callback` routing, state validation, cancellation, and timeout handling, then returns only the authorization code. `ctx.oauth.authorize()` is deprecated.

Do not use it for ordinary REST API integrations; use `connect()` + `request()` instead. The caller must declare `providerId` in `finch.permissions.oauth`. Finch validates that the authorization URL is HTTPS and that its `state` and `redirect_uri` exactly match the request. Never use it to pass tokens or client secrets.

```ts
const result = await ctx.oauth.initiateAuthorization({
  providerId: 'notion-mcp', // Must exactly match permissions.oauth.
  providerName: 'Notion MCP',
  providerIcon: 'finch-ext-icon://my-mini-tool/assets/notion.png',
  authorizationUrl, // HTTPS URL containing the same state and redirect_uri below.
  state,
  callbackUrl: 'https://oauth.finchwork.app/callback',
});
// Exchange result.code only inside the protocol client; never expose it to the model.
```

Package `assets/notion.png` with the mini tool. `providerIcon` accepts only the trusted `finch-ext-icon://<extensionId>/...png` form; remote URLs, SVGs, traversal paths, and another extension's id are rejected.

For an OAuth-protected **MCP** endpoint, do not call `initiateAuthorization()` yourself — MCP Client owns discovery, DCR, PKCE, and the token lifecycle. Declare `contributes.mcpServers[].oauth.providerIcon` instead and your logo still appears in the dialog. See `mcp.md`.

### Device Flow

Set `flow: 'device_code'` and provide `deviceAuthorizationEndpoint`. Finch displays and copies the user code, opens the verification page, and polls the token endpoint without exposing the device code or access token to the mini tool.

```ts
const GITHUB_CLIENT_ID = 'public-client-id-owned-by-the-mini-tool-publisher';

const github: finch.OAuthProviderConfig = {
  id: 'github',
  name: 'GitHub',
  icon: 'assets/github.png', // Recommended: becomes Finch's native providerIcon.
  clientId: GITHUB_CLIENT_ID,
  flow: 'device_code',
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  deviceAuthorizationEndpoint: 'https://github.com/login/device/code',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  scopes: ['read:user'],
  resourceOrigins: ['https://api.github.com'],
};
```

When present, `icon` is a relative path to a PNG packaged with the mini tool. Finch turns it into the native dialog's `providerIcon`. Add its directory to `package.json#files`; remote URLs, SVG files, and paths outside the mini-tool directory are rejected.

The provider application must have Device Flow enabled. Device Flow providers may not expose a secretless revocation endpoint; in that case `disconnect()` removes Finch's encrypted local credential but cannot revoke the authorization at the provider.

### Provider requirements

The mini-tool publisher must create and maintain the OAuth client with the provider, then ship its public Client ID in the mini tool. End users must not create or configure OAuth clients. For Google desktop apps, use a Desktop OAuth client, enable the required API, configure the consent screen, and add test users while the app is in Testing status. Restricted Gmail scopes can require Google verification before public distribution.
