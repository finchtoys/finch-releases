# MCP

This document covers how mini tools integrate with MCP servers via the MCP Client extension.

## 1. Two-layer design

MCP integration combines **static declarations** with optional **runtime registration**:

| Layer | Where | What it carries |
|---|---|---|
| Static contribution | `finch.json → contributes.mcpServers` | `name`, `toolMeta`, `toolDisplay`, optional secret-free transport — metadata and declarative config |
| Runtime registration | `activate()` → `mcp.client#registerServer()` | `command`/`url`, `args`, `env`, `oauth` — resolved transport and authentication |

The MCP bridge merges both layers. Runtime registration supplies dynamic transport and overrides the matching static entry; static declarations supply presentation metadata and can also supply a secret-free transport. Tool titles and ToolCallCard inline summaries are written to `~/.finch/tools.json` when the tools connect.

**Key rule**: Never put API keys or tokens in the static manifest. For API-key servers, collect the value in a secure form and register the transport at runtime. For OAuth-enabled remote MCP servers, declare `oauth` and let MCP Client perform discovery, DCR, PKCE, refresh, and authenticated transport; never collect an OAuth token yourself.

---

## 2. Static contribution (metadata only)

Declare the server in `finch.json` to register presentation metadata. The `name` field is required; transport fields are optional and should only be included when no secrets are needed.

### Metadata-only entry (recommended for secret-dependent servers)

```json
{
  "requires": {
    "capabilities": ["mcp.client"]
  },
  "contributes": {
    "mcpServers": [
      {
        "name": "my-server",
        "description": "My MCP server. Call setup_my_server to configure.",
        "toolMeta": {
          "titles": {
            "my_tool": "My Tool"
          }
        },
        "toolDisplay": {
          "tools": {
            "my_tool": {
              "inline": {
                "mode": "join",
                "fields": [{ "path": "query", "maxLength": 80 }],
                "template": "{query}"
              }
            }
          }
        }
      }
    ]
  }
}
```

No `command`, `args`, or `env` here — the extension provides the transport at runtime after collecting any required secrets.

### Full static entry (no secrets needed)

For servers that need no user-supplied credentials, you can include transport directly:

```json
{
  "name": "filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
  "description": "Local filesystem access"
}
```

---

## 3. Runtime registration

Call `mcp.client#registerServer()` in `activate()` to provide the transport. The bridge picks up `toolMeta`/`toolDisplay` from the matching static contribution automatically.

```ts
export function activate(ctx: finch.ExtensionContext): void {
  // Re-register on every activation — runtime servers are in-memory only.
  void readSetup(ctx).then((setup) => {
    if (!setup) return; // not configured yet
    return registerWhenReady(ctx, setup);
  });
}

async function registerWhenReady(ctx: finch.ExtensionContext, setup: StoredSetup): Promise<void> {
  // mcp.client may activate after this extension — poll briefly.
  for (let i = 0; i < 20; i++) {
    if (ctx.capabilities.has('mcp.client')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ctx.capabilities.has('mcp.client')) {
    ctx.logger.warn('mcp.client capability not available');
    return;
  }
  const mcp = ctx.capabilities.get('mcp.client');
  await mcp.registerServer({
    name: 'my-server',             // should match contributes.mcpServers[].name
    command: 'npx',
    args: ['-y', 'my-mcp-server'],
    env: { API_KEY: setup.apiKey },
    ownerExtensionId: ctx.extension.id,
    ownerExtensionName: ctx.extension.displayName,
  });
}

export function deactivate(): void {
  // Best-effort cleanup — runtime server disappears with the extension anyway.
  if (activeCtx?.capabilities.has('mcp.client')) {
    void activeCtx.capabilities.get('mcp.client').unregisterServer('my-server');
  }
}
```

**Why poll for `mcp.client`**: Extension activation timing is not a dependency contract. If MCP Client activates after your extension, `ctx.capabilities.has('mcp.client')` is initially false. A short poll handles this without relying on activation order.

---

## 4. Setup tool pattern

For secret-dependent servers, provide a `setup_*` tool that collects credentials via a secure form, stores them with `ctx.storage`, then calls `registerServer()`:

```ts
ctx.subscriptions.push(ctx.tools.register({
  name: 'setup_my_server',
  title: 'Set Up My Server',
  description: 'Collect the API key and configure the MCP server.',
  inputSchema: { type: 'object', properties: {} },
  risk: 'medium',
  async execute(_input, exec) {
    const result = await exec.ui.requestForm({
      title: 'My Server Setup',
      fields: [
        { key: 'apiKey', label: 'API Key', type: 'password', secret: true, required: true },
      ],
    });
    if (!result.submitted) return { content: [{ type: 'text', text: 'Cancelled.' }] };

    const apiKey = String(result.values.apiKey ?? '').trim();
    await ctx.storage.set('setup', { apiKey });

    const mcp = ctx.capabilities.get('mcp.client');
    await mcp.registerServer({
      name: 'my-server',
      command: 'npx',
      args: ['-y', 'my-mcp-server'],
      env: { API_KEY: apiKey },
      ownerExtensionId: ctx.extension.id,
      ownerExtensionName: ctx.extension.displayName,
    });

    return { content: [{ type: 'text', text: 'Configured. MCP tools will appear shortly.' }] };
  },
}));
```

---

## 5. Remote MCP OAuth (discovery + DCR + PKCE)

Use MCP OAuth for a remote Streamable HTTP server that advertises OAuth metadata, such as `https://mcp.notion.com/mcp`. This is different from a mini tool calling a normal REST API through `ctx.oauth`:

| Need | API |
|---|---|
| Authorize a normal REST API with a publisher-supplied Client ID | `ctx.oauth` |
| Connect an OAuth-protected MCP endpoint using protected-resource discovery and Dynamic Client Registration | `mcp.client` with `oauth` |

Register the OAuth-enabled server at runtime:

```ts
interface McpClientCapability {
  registerServer(config: unknown): Promise<{ ok: boolean; error?: string }>;
  connectServer(name: string): Promise<{ ok: boolean }>;
  disconnectServerOAuth(name: string): Promise<{ ok: boolean }>;
  listTools(name: string): Promise<Array<{ name: string; description?: string }>>;
  callTool(name: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  unregisterServer(name: string): Promise<{ ok: boolean }>;
}

const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');

await mcp.registerServer({
  name: 'notion',
  url: 'https://mcp.notion.com/mcp',
  oauth: {
    id: 'notion-mcp',       // stable local credential/storage id
    providerName: 'Notion MCP',
    clientName: 'My Tool',
    clientUri: 'https://example.com',
    // scopes: ['...'],      // optional; discovery metadata is used when omitted
  },
  ownerExtensionId: ctx.extension.id,
  ownerExtensionName: ctx.extension.displayName,
});
```

Do **not** open the browser during `activate()`. Registering the server is passive; begin authorization only from an explicit user action:

```ts
await mcp.connectServer('notion');
const tools = await mcp.listTools('notion');
```

`connectServer()` performs:

1. RFC 9728 protected-resource metadata discovery
2. RFC 8414 authorization-server metadata discovery
3. RFC 7591 Dynamic Client Registration when required
4. Authorization Code + PKCE (`S256` when advertised)
5. Finch native OAuth confirmation UI, browser opening, HTTPS callback relay, state validation, cancellation, and timeout
6. Token exchange and refresh through the official MCP SDK
7. Authenticated Streamable HTTP connection

To sign out locally:

```ts
await mcp.disconnectServerOAuth('notion');
```

Then call `unregisterServer()` during deactivation as usual. Never place `access_token`, `refresh_token`, `client_secret`, or an `Authorization` header in `registerServer()` when `oauth` is enabled.

#### Provider logo in the consent dialog

MCP Client runs the DCR flow on your behalf, so by default the dialog shows no brand logo. Declare the PNG in **your own** manifest and MCP Client passes it through:

```json
{
  "contributes": {
    "mcpServers": [
      {
        "name": "Notion",
        "oauth": {
          "id": "notion-mcp",
          "providerName": "Notion MCP",
          "providerIcon": "icon.png"
        }
      }
    ]
  }
}
```

`providerIcon` is a relative PNG path inside your extension, and it must be listed in `files` so it ships with the package. The manifest declaration is the only trusted source: Finch resolves it to `finch-ext-icon://<your-extension-id>/<path>` and rejects any logo the owning extension did not declare, so the bridge cannot borrow another extension's brand.

For a runtime-registered server, the runtime `oauth.id` and `oauth.providerName` remain the connection configuration; the manifest supplies only the trusted logo. Keep the `name` (and normally `id` / `providerName`) aligned between both places. A fully static server uses the manifest's entire `oauth` object.

No extra `permissions.oauth` entry is needed — the OAuth permission stays with MCP Client. This is **path B** in `oauth.md`; if your mini tool instead calls a normal HTTPS API with its own OAuth client, use path A (`permissions.oauth` + `ctx.oauth.*`) and ignore this section.

Do not call `shell.openExternal`, start a loopback callback server, or render a callback page in the mini tool. MCP Client delegates those interaction concerns to Finch OAuth core through `ctx.oauth.authorize()`, so MCP and normal OAuth share the same native confirmation card, `BrowserOAuthFlowDriver`, HTTPS relay page, `finch://oauth/callback` routing, cancellation, and timeout behavior.

Finch follows the authorization server's RFC 7591 Dynamic Client Registration flow and registers `client_name: Finch`, `client_uri: https://finchwork.app`, the Finch logo, and the HTTPS callback. Do not use `finch://` directly as a production redirect URI—keep the externally verifiable HTTPS callback and let it hand off locally to the custom protocol. A published Client ID Metadata Document may still be used for servers that explicitly require URL-based clients, but Finch does not prefer it over the server's documented DCR flow.

For a user-managed MCP server added through Finch's MCP management tool, the equivalent setup is `action=add` with `name`, `url`, and `oauth=true`, followed by `action=connect` with the exact server name.

---

## 6. Tool naming

The bridge exposes tools as `mcp__<serverName>__<toolName>`. Keep `name` stable — it becomes part of the model-facing tool name. Name matching between static declarations and runtime registration is normalized, but use the same spelling for clarity.

---

## 7. Why not write to servers.json?

`servers.json` is the user's own MCP config file. Mini tools should not write to it:
- Uninstalling the tool would leave orphaned entries
- `registerServer()` is in-memory and bound to the extension's lifecycle — it cleans up automatically

---

## 8. Debugging

When a contributed MCP server does not connect:

1. Check that the mini tool is enabled
2. Check that MCP Client is enabled
3. Verify `name` in `contributes.mcpServers` matches the `name` passed to `registerServer()`
4. Check that `setup_*` was called and the API key is stored in `ctx.storage`
5. For OAuth MCP, confirm the endpoint exposes RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata
6. Confirm the authorization server exposes a `registration_endpoint` unless a static/URL-based client id is used
7. Check the extension logs for discovery, registration, callback, token, or MCP handshake errors
