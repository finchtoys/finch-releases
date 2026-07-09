## MCP Client

MCP Client is [Finch](https://finchwork.app/)'s bridge for mini tools that want to expose Model Context Protocol (MCP) servers to the Agent.

For mini tool authors, the recommended pattern is:

1. Declare that your mini tool depends on the `mcp.client` capability.
2. Declare `contributes.mcpServers` as **presentation metadata only**: server name, tool titles, and ToolCallCard display hints.
3. Collect secrets in your own setup tool with a secure form.
4. Store those secrets in your mini tool's own `ctx.storage`.
5. Register the actual MCP transport at runtime with `mcp.client#registerServer()`.

This is the same pattern used by Tavily Search: the manifest describes how Tavily tools should look in Finch, while `activate()` registers the real MCP server after the API key is available.

## Best practice: metadata in manifest, transport at runtime

### 1. Declare the dependency and MCP presentation metadata

In `package.json`, declare `requires.capabilities: ["mcp.client"]` and add a metadata-only `contributes.mcpServers` entry.

Do **not** put `command`, `args`, `url`, `headers`, or secrets here when the server depends on user configuration.

```json
{
  "finch": {
    "requires": {
      "capabilities": ["mcp.client"]
    },
    "contributes": {
      "mcpServers": [
        {
          "name": "my-service",
          "description": "My Service MCP server. Call setup_my_service to configure it.",
          "toolMeta": {
            "titles": {
              "search": "My Service Search",
              "extract": "My Service Extract"
            }
          },
          "toolDisplay": {
            "tools": {
              "search": {
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

`toolMeta.titles` controls the short title shown in Finch tool cards. `toolDisplay.tools` controls the inline summary shown beside a tool call.

### 2. Register the real MCP server at runtime

In your mini tool code, use the `mcp.client` capability to register a server after configuration is available.

```ts
import type * as finch from 'finch';

const SERVER_NAME = 'my-service';
const STORAGE_KEY = 'my-service.setup';

interface StoredSetup {
  apiKey: string;
}

type McpServerConfig =
  | { name: string; command: string; args?: string[]; env?: Record<string, string>; ownerExtensionId?: string; ownerExtensionName?: string }
  | { name: string; url: string; headers?: Record<string, string>; env?: Record<string, string>; ownerExtensionId?: string; ownerExtensionName?: string };

interface McpClientCapability {
  registerServer(config: McpServerConfig): Promise<{ ok: boolean; error?: string }>;
  unregisterServer(name: string): Promise<{ ok: boolean }>;
}

async function readSetup(ctx: finch.ExtensionContext): Promise<StoredSetup | undefined> {
  return ctx.storage.get<StoredSetup>(STORAGE_KEY);
}

async function registerRuntimeServer(ctx: finch.ExtensionContext, setup: StoredSetup): Promise<void> {
  if (!ctx.capabilities.has('mcp.client')) {
    ctx.logger.warn('mcp.client capability is not available');
    return;
  }

  const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');
  const result = await mcp.registerServer({
    name: SERVER_NAME,
    url: `https://example.com/mcp?apiKey=${encodeURIComponent(setup.apiKey)}`,
    ownerExtensionId: ctx.extension.id,
    ownerExtensionName: ctx.extension.displayName,
  });

  if (!result.ok) {
    ctx.logger.warn('failed to register MCP server', result.error);
  }
}

export function activate(ctx: finch.ExtensionContext): void {
  void readSetup(ctx).then((setup) => {
    if (setup) return registerRuntimeServer(ctx, setup);
  });
}
```

Runtime registrations are in-memory and tied to the mini tool lifecycle. If the mini tool is disabled or removed, the runtime server disappears with it and does not leave stale entries in MCP Client's user config.

### 3. Add a setup tool for secrets

Use a setup tool to collect secrets via Finch's secure form, store them in your own extension storage, then call `registerServer()`.

```ts
ctx.subscriptions.push(ctx.tools.register({
  name: 'setup_my_service',
  title: 'Set up My Service',
  description: 'Collect the API key and register the My Service MCP server.',
  inputSchema: { type: 'object', properties: {} },
  risk: 'medium',
  async execute(_input, exec) {
    const form = await exec.ui.requestForm({
      title: 'Set up My Service',
      fields: [
        { key: 'apiKey', label: 'API Key', type: 'password', secret: true, required: true },
      ],
    });

    if (!form.submitted) {
      return { content: [{ type: 'text', text: 'Setup cancelled.' }] };
    }

    const apiKey = String(form.values.apiKey ?? '').trim();
    if (!apiKey) {
      return { content: [{ type: 'text', text: 'No API key was provided.' }], isError: true };
    }

    const setup = { apiKey };
    await ctx.storage.set(STORAGE_KEY, setup);
    await registerRuntimeServer(ctx, setup);

    return { content: [{ type: 'text', text: 'My Service MCP server is configured.' }] };
  },
}));
```

Secrets should never be written to `package.json`, committed to the mini tool package, or returned to the model in tool results.

## Server name matching

MCP Client merges the runtime server config with the static contribution by normalized server name. Case-only differences are tolerated, but you should still keep one stable name in both places:

```text
contributes.mcpServers[].name = "My Service"
registerServer({ name: "my-service", ... })
→ both normalize to my_service / my-service style matching internally
```

The model-facing MCP tool names are not prefixed with the mini tool id. Tools are exposed as:

```text
mcp__<server>__<tool>
```

Finch keeps an internal owner-qualified key such as `my-plugin.my-service` for UI attribution and ownership, not for the tool name shown to the model.

## What MCP Client provides

The `mcp.client` capability is intended for mini tools. Its core methods are:

```ts
interface McpClientCapability {
  listServers(): Promise<string[]>;
  getServerStatuses?(): Promise<Array<{ name: string; status: string; toolCount: number; ownerExtensionId?: string; qualifiedName?: string }>>;
  listTools(server: string): Promise<Array<{ name: string; title?: string; description?: string; inputSchema?: Record<string, unknown> }>>;
  registerServer(config: McpServerConfig): Promise<{ ok: boolean; error?: string }>;
  unregisterServer(name: string): Promise<{ ok: boolean }>;
}
```

For normal mini tools, prefer `registerServer()` over writing MCP Client config files directly.

## Manual MCP config: supported but not recommended for mini tools

MCP Client still supports a user-owned `servers.json` file for manual local configuration and troubleshooting. This is useful for advanced users, but mini tools should not write to it because uninstalling the mini tool would leave orphaned server entries.

Path:

```text
~/.finch/extension-data/mcp/servers.json
```

In dev mode, the root is `~/.finch-dev/`.

### stdio server

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  ]
}
```

### HTTP Stream server

```json
{
  "servers": [
    {
      "name": "remote-search",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      },
      "env": {
        "MCP_TOKEN": "your local token"
      }
    }
  ]
}
```

For HTTP Stream, `env` is only used to expand `${KEY}` placeholders in `headers`; it is not sent in the request body.

## Agent usage

The Agent should not call `mcp__<server>__<tool>` names before they are activated. It should first use Finch `ToolSearch` with `source: "mcp"`; MCP Client will connect matching servers, discover their tools, and inject the matched tools into the current run.

This is a runtime optimization detail for the Agent. Mini tool authors usually only need the contribution + `registerServer()` pattern above.
