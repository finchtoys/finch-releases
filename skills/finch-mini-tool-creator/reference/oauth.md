# OAuth

Use `ctx.oauth` when a mini tool needs OAuth 2.0 user authorization. Finch supports Authorization Code + PKCE and Device Flow public clients, and owns the browser interaction, encrypted credential storage, refresh locking, and Authorization header injection.

### Security model

- Declare every provider id in `finch.permissions.oauth`.
- The mini-tool developer supplies the public Client ID, endpoints, scopes, and resource origins in the mini-tool package. Users only approve and complete the Finch-managed login flow; never ask users to configure OAuth plumbing.
- Use Authorization Code + PKCE public clients by default. Use Device Flow for providers such as GitHub that require a secret for Web Flow but support secretless device authorization. Do not embed a confidential client secret.
- Credentials are stored under `<finchHome>/extension-data/<extensionId>/oauth/`.
- Each mini tool has a separate credential and connection store.
- For brokered `connect()` / `request()` providers, access and refresh tokens never cross into the mini-tool host process.
- `resourceOrigins` is an HTTPS allowlist for brokered requests.
- `ctx.oauth.request()` strips caller-supplied Authorization, Cookie, Host, and Proxy-Authorization headers.

### Manifest

```json
{
  "finch": {
    "permissions": {
      "oauth": ["google"]
    }
  }
}
```

### Provider and usage

```ts
const GOOGLE_CLIENT_ID = 'public-client-id-owned-by-the-mini-tool-publisher';

const google: finch.OAuthProviderConfig = {
  id: 'google',
  name: 'Google',
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

`ctx.oauth.authorize()` is a low-level interaction bridge for protocol clients such as the official MCP SDK that already construct their own authorization URL and perform their own token exchange. It reuses Finch's native consent card, browser driver, HTTPS callback relay, `finch://oauth/callback` routing, state validation, cancellation, and timeout handling, then returns only the authorization code.

Do not use it for ordinary REST API integrations; use `connect()` + `request()` instead. The caller must declare `providerId` in `finch.permissions.oauth`. Finch validates that the authorization URL is HTTPS and that its `state` and `redirect_uri` exactly match the request. Never use it to pass tokens or client secrets.

### Device Flow

Set `flow: 'device_code'` and provide `deviceAuthorizationEndpoint`. Finch displays and copies the user code, opens the verification page, and polls the token endpoint without exposing the device code or access token to the mini tool.

```ts
const GITHUB_CLIENT_ID = 'public-client-id-owned-by-the-mini-tool-publisher';

const github: finch.OAuthProviderConfig = {
  id: 'github',
  name: 'GitHub',
  icon: 'assets/github.png',
  clientId: GITHUB_CLIENT_ID,
  flow: 'device_code',
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  deviceAuthorizationEndpoint: 'https://github.com/login/device/code',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  scopes: ['read:user'],
  resourceOrigins: ['https://api.github.com'],
};
```

`icon` is an optional relative path to a PNG packaged with the mini tool. Add its directory to `package.json#files`; remote URLs, SVG files, and paths outside the mini-tool directory are rejected.

The provider application must have Device Flow enabled. Device Flow providers may not expose a secretless revocation endpoint; in that case `disconnect()` removes Finch's encrypted local credential but cannot revoke the authorization at the provider.

### Provider requirements

The mini-tool publisher must create and maintain the OAuth client with the provider, then ship its public Client ID in the mini tool. End users must not create or configure OAuth clients. For Google desktop apps, use a Desktop OAuth client, enable the required API, configure the consent screen, and add test users while the app is in Testing status. Restricted Gmail scopes can require Google verification before public distribution.
