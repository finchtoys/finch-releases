# MCP

This document covers how mini tools integrate with MCP servers via the MCP Client extension.

## 1. Two-layer design

MCP integration separates **presentation metadata** from **transport config**:

| Layer | Where | What it carries |
|---|---|---|
| Static contribution | `package.json → contributes.mcpServers` | `name`, `toolMeta`, `toolDisplay` — presentation only |
| Runtime registration | `activate()` → `mcp.client#registerServer()` | `command`/`url`, `args`, `env` — transport with real secrets |

The MCP bridge merges both layers: transport from the runtime call, presentation from the contribution. Tool titles and ToolCallCard inline summaries are written to `~/.finch/tools.json` when the tools connect.

**Key rule**: Never put secrets (API keys, tokens) in the static manifest. Use `ctx.storage` + `registerServer()` instead.

---

## 2. Static contribution (metadata only)

Declare the server in `package.json` to register presentation metadata. The `name` field is required; transport fields are optional and should only be included when no secrets are needed.

### Metadata-only entry (recommended for secret-dependent servers)

```json
{
  "finch": {
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
    name: 'my-server',             // matched to contributes.mcpServers[].name by normalized name; keep it stable
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

**Why poll for `mcp.client`**: Finch activates extensions alphabetically. If MCP Client activates after your extension, `ctx.capabilities.has('mcp.client')` is initially false. A short poll handles this without a hard dependency on activation order.

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

## 5. Tool naming

The bridge exposes tools as `mcp__<serverName>__<toolName>`. Keep `name` stable — it becomes part of the model-facing tool name.

---

## 6. Why not write to servers.json?

`servers.json` is the user's own MCP config file. Mini tools should not write to it:
- Uninstalling the tool would leave orphaned entries
- `registerServer()` is in-memory and bound to the extension's lifecycle — it cleans up automatically

---

## 7. Debugging

When a contributed MCP server does not connect:

1. Check that the mini tool is enabled
2. Check that MCP Client is enabled
3. Verify `name` in `contributes.mcpServers` and `registerServer()` normalize to the same value; keep the same stable name when possible
4. Check that `setup_*` was called and the API key is stored in `ctx.storage`
5. Check the extension logs for connection or handshake errors
