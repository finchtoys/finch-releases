# Tavily 搜索

Tavily 搜索小工具是 [Finch](https://finchwork.app/) 的扩展。Finch 是一款桌面 AI Agent，可在 [finchwork.app](https://finchwork.app/) 下载。本扩展通过 Finch 的 MCP Client 连接 Tavily MCP，让 Agent 可以使用 Tavily 的搜索、网页提取、站点抓取和站点地图能力。

## 推荐接入方式

扩展支持三种连接模式：

| 模式 | 配置 | 适合场景 |
|---|---|---|
| `local`（默认） | `npx -y tavily-mcp@latest` + env | 推荐。支持 `TAVILY_API_KEY` 和 `DEFAULT_PARAMETERS`，密钥不出现在 URL 中。 |
| `remote` | `npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=…` | 当你想走 Tavily 远程 MCP，又需要兼容 stdio MCP client 时使用。 |
| `http` | `https://mcp.tavily.com/mcp/?tavilyApiKey=…` | Finch MCP Client 直接连接远程 Streamable HTTP。 |

默认选择 `local`，因为 Tavily 官方文档明确支持：

```json
{
  "env": {
    "TAVILY_API_KEY": "your-api-key-here",
    "DEFAULT_PARAMETERS": "{\"include_images\": true, \"max_results\": 15, \"search_depth\": \"advanced\"}"
  }
}
```

## 使用方式

1. 启用 MCP Client 扩展。
2. 启用 Tavily Search 扩展。
3. 对 Finch 说：`帮我设置 Tavily Search`。
4. 扩展会调用 `setup_tavily_search`，弹出安全表单收集 `TAVILY_API_KEY`，并写入本机 MCP Client 配置。
5. 配置完成后，用 `/tavily-search` 进行网页研究。

## 工具

- `setup_tavily_search`：收集 Tavily API Key，写入本机 MCP Client 配置，并尝试通过 `mcp.client` 验证连接。
- `tavily_search_status`：检查 Tavily MCP server 是否已配置，并列出当前可见工具。

## 权限

- `filesystem: readwrite`：写入 MCP Client 的本机 `servers.json` 配置。
- `shell: true`：MCP Client 使用 `npx` 启动 Tavily MCP server。
- `network: false`：本扩展不直接联网；实际网络请求由 MCP Client / Tavily MCP server 执行。

## 安全说明

`TAVILY_API_KEY` 通过 Finch 表单的 secret 字段收集，不会回显给模型。为了让 MCP Client 启动 Tavily server，密钥会保存到本机 MCP 配置文件中。不要把配置文件提交到 Git。
