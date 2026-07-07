# Tavily Search

Tavily Search is a mini tool for [Finch](https://finchwork.app/) — a desktop AI agent you can download at [finchwork.app](https://finchwork.app/). It connects Tavily MCP through Finch's MCP Client so the Agent can use Tavily search, extract, crawl, and map tools.

## Recommended connection mode

The extension supports three modes:

| Mode | Config | Best for |
|---|---|---|
| `local` (default) | `npx -y tavily-mcp@latest` + env | Recommended. Supports `TAVILY_API_KEY` and `DEFAULT_PARAMETERS`; the key does not appear in the URL. |
| `remote` | `npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=…` | Use Tavily's remote MCP through a stdio-compatible bridge. |
| `http` | `https://mcp.tavily.com/mcp/?tavilyApiKey=…` | Let Finch MCP Client connect directly to remote Streamable HTTP. |

The default is `local` because Tavily documents this env shape:

```json
{
  "env": {
    "TAVILY_API_KEY": "your-api-key-here",
    "DEFAULT_PARAMETERS": "{\"include_images\": true, \"max_results\": 15, \"search_depth\": \"advanced\"}"
  }
}
```

## Usage

1. Enable the MCP Client extension.
2. Enable the Tavily Search extension.
3. Ask Finch: `Set up Tavily Search`.
4. The `setup_tavily_search` tool opens a secure form for `TAVILY_API_KEY` and writes local MCP Client config.
5. Use `/tavily-search` for web research.

## Tools

- `setup_tavily_search`: collect the Tavily API key, write local MCP Client config, and validate through `mcp.client` when possible.
- `tavily_search_status`: check whether Tavily MCP is configured and list visible tools.

## Permissions

- `filesystem: readwrite`: writes the local MCP Client `servers.json` config.
- `shell: true`: MCP Client starts the Tavily MCP server with `npx`.
- `network: false`: this extension does not call the network directly; MCP Client / Tavily MCP server performs network calls.

## Security

`TAVILY_API_KEY` is collected via Finch's secret form field and is not echoed back to the model. To let MCP Client launch the Tavily server, the key is saved in a local MCP config file. Do not commit that file to Git.
