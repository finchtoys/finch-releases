# Notion

Connect Notion to Finch — search pages, read databases, and manage your workspace through the official Notion MCP server.

## How it works

This extension connects Finch to the official Notion MCP endpoint (`https://mcp.notion.com/mcp`) using standards-based OAuth:

1. **RFC 9728** protected-resource discovery
2. **RFC 8414** authorization-server discovery
3. **RFC 7591** Dynamic Client Registration
4. **Authorization Code + PKCE**
5. Token refresh through the official MCP SDK
6. Authenticated Streamable HTTP MCP connection

No API keys or tokens to manage — everything goes through Notion's official OAuth flow.

## Getting started

### Connect

Click the **Notion** button in the Composer toolbar, then select **Connect Notion**. Finch immediately opens its native OAuth dialog, from which you can continue to Notion in your browser. After authorizing, Finch gains access to your Notion workspace.

You can also ask the agent: *"Connect Notion"* — it will call the `notion_login` tool.

### Using Notion tools

Once connected, the agent can discover and call Notion MCP tools directly via ToolSearch. Available tools include:

- **Search** — Search across all pages and databases
- **Fetch page** — Retrieve page content and properties
- **Create pages** — Create new pages with content
- **Update page** — Edit existing page content
- **Fetch database** — Query database entries
- **Get users / teams** — List workspace members and teams

### Disconnect

Click the **Notion** toolbar button → **Disconnect**. This removes locally stored OAuth credentials. You'll need to reauthorize to use Notion again.

## Toolbar menu

| State | Menu items |
|---|---|
| Not connected | Connect Notion |
| Connected | Search pages · Browse databases · Disconnect |

## Agent tool

| Tool | Description |
|---|---|
| `notion_login` | OAuth connect / reauthorize. Starts Finch's native OAuth flow immediately. The agent calls this when the user asks to connect, or when Notion MCP tools return authentication errors. |

## Requirements

- Finch with MCP Client extension enabled
- A Notion account

## Privacy

OAuth credentials are stored locally and never shared. Notion content is treated as untrusted external input.
