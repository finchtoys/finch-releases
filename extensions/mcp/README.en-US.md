# MCP Client

MCP Client is Finch's official built-in plugin for connecting Model Context Protocol (MCP) servers to Finch.

It does three things:

1. Connects MCP servers, caches each service's tool list, and activates MCP tools on demand through Finch's standard `ToolSearch`.
2. Provides the `mcp.client` capability so other Finch plugins can call MCP servers without implementing their own MCP client.
3. Reads MCP servers contributed by other extensions through `ctx.extensions.listContributions('mcpServers')` and connects them through Client-owned policy.

## Dynamic tool loading

To avoid flattening every MCP tool into the model context at once (which gets expensive with many servers/tools), MCP Client integrates with Finch's standard `ToolSearch`. The initial context only carries `ToolSearch` plus a few management tools; when the model needs MCP capabilities, it calls `ToolSearch({ source: "mcp", query })` to discover and activate matching tools on demand.

| Entry | Purpose |
|---|---|
| `ToolSearch` | Finch's standard dynamic-tool search; with `source: "mcp"`, MCP Client connects servers, discovers tools, and injects matches into the current run |
| `MCP action=list` | List configured MCP services and their connection/tool-count status |
| `mcp__<server>__<tool>` | Real MCP tools injected after ToolSearch matches them; callable directly |

The typical model flow is: optionally call `MCP({ action: "list" })` to inspect services → call `ToolSearch({ source: "mcp", query: "..." })` → directly call the injected `mcp__<server>__<tool>`.

## Managing MCP servers

MCP Client also exposes one dispatcher management tool to the AI, so the user can add, edit, or remove MCP servers through natural language:

| Tool | Purpose |
|---|---|
| `MCP action=add` | Add a new MCP server; the user fills command/URL and secrets in a secure form |
| `MCP action=edit` | Edit an existing server's command, arguments, URL, or environment variables |
| `MCP action=remove` | Remove a server so it no longer connects |

These tools only manage servers in the local `servers.json`; MCP servers injected by other plugins via their manifest cannot be edited or removed here. Secret values are always entered by the user in the form and never returned to the model.

## Supported transports

MCP Client supports two transport types.

### 1. stdio / stdout subprocess

Use this for local command-line MCP servers, such as filesystem, git, or database servers.

```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  ]
}
```

For backward compatibility, configs without `transport` but with `command` are treated as `stdio`.

### 2. HTTP Stream

Use this for remote MCP services or MCP endpoints exposed through a gateway. Finch sends JSON-RPC POST requests to `url` and accepts either `application/json` or `text/event-stream` responses.

```json
{
  "servers": [
    {
      "name": "remote-search",
      "transport": "httpStream",
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

`env` is not sent in the HTTP body. It is only used to expand `${KEY}` placeholders in `headers`.

## Config files

This version intentionally does not expose a MCP configuration UI yet. MCP Client reads these configuration sources:

| Source | Purpose |
|---|---|
| `servers.json` | User-written / local MCP server config |
| `ctx.extensions.listContributions('mcpServers')` | MCP servers contributed by enabled extension manifests |

When local config and plugin contributions define the same server name, `servers.json` wins and can override contributed config.

The absolute paths are:

```
~/.finch/extension-data/mcp/servers.json
```

In dev mode the root is `~/.finch-dev/`. Developers can hand-write `servers.json` (format shown above); restart Finch to apply changes. Plugin-contributed MCP servers come from the enabled-plugin manifest contribution snapshot.

## For plugin authors

MCP Client provides the `mcp.client` capability. Other plugins can declare the dependency in their manifest:

```json
{
  "finch": {
    "requires": {
      "capabilities": ["mcp.client"]
    }
  }
}
```

Then call MCP from plugin code:

```ts
const mcp = await ctx.capabilities.get('mcp.client');
const servers = await mcp.listServers();
const tools = await mcp.listTools('filesystem');
const result = await mcp.callTool('filesystem', 'read_file', { path: '/tmp/a.txt' });
```

## Contributing MCP servers

A plugin can contribute MCP servers through `contributes.mcpServers`:

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
          "transport": "stdio",
          "command": "node",
          "args": ["dist/server.js"]
        }
      ]
    }
  }
}
```

Finch automatically prefixes contributed server names with the plugin id, for example `my-plugin.my-server`, to avoid collisions.

## Environment variables and secrets

- `stdio`: `env` is merged into the MCP server subprocess environment.
- `httpStream`: `env` expands `${KEY}` placeholders in request headers.
- Do not commit real secrets in plugin manifests. Prefer local `servers.json` or Finch's future secret configuration UI for sensitive values.

## Localized README files

Plugin README files can be localized with these filenames:

- `README.zh-CN.md`
- `README.en-US.md`
- `README.md` as the default fallback

Finch chooses the best README for the current UI language.