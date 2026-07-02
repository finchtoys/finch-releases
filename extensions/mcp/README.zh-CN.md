# MCP Bridge

MCP Bridge 是 Finch 官方内置插件，用来把 Model Context Protocol（MCP）服务连接到 Finch。

它负责三件事：

1. 连接 MCP server，缓存每个服务的工具列表，并通过 Finch 标准 `ToolSearch` 按需激活 MCP 工具。
2. 提供 `mcp.client` capability，其他 Finch 插件可以通过它调用 MCP 服务，而不需要自己实现 MCP client。
3. 通过 `ctx.extensions.listContributions('mcpServers')` 读取其他扩展声明的 MCP 服务，并按桥接扩展策略自动连接。

## 动态工具加载

为了避免把所有 MCP 工具一次性平铺进模型上下文（MCP server 多、工具多时会很占空间），MCP Bridge 接入 Finch 标准 `ToolSearch`：初始上下文只包含 `ToolSearch` 与少量管理工具；模型需要 MCP 能力时，通过 `ToolSearch({ source: "mcp", query })` 按需发现工具。

| 入口 | 作用 |
|---|---|
| `ToolSearch` | Finch 标准动态工具搜索；`source: "mcp"` 时由 MCP Bridge 连接服务、发现工具并注入当前 run |
| `MCP action=list` | 列出已配置的 MCP 服务及各自连接状态/工具数量 |
| `mcp__<server>__<tool>` | ToolSearch 命中后注入的真实 MCP 工具，可直接调用 |

模型的典型流程是：先 `MCP({ action: "list" })` 了解有哪些服务（可选）→ 调用 `ToolSearch({ source: "mcp", query: "..." })` → 再直接调用被注入的 `mcp__<server>__<tool>`。

## 管理 MCP 服务

MCP Bridge 还向 AI 提供一个 dispatcher 管理工具，用户可以直接用自然语言让 AI 增改删 MCP 服务：

| 工具 | 作用 |
|---|---|
| `MCP action=add` | 新增一个 MCP 服务，用户在安全表单里填写命令/URL 与密钥 |
| `MCP action=edit` | 修改已有 MCP 服务的命令、参数、URL 或环境变量 |
| `MCP action=remove` | 删除一个 MCP 服务，使其不再连接 |

这些工具只能管理本地 `servers.json` 中的服务；其他插件通过 manifest 注入的 MCP 服务不能在这里被修改或删除。密钥值始终由用户在表单中填写，不会回传给模型。

## 支持的连接方式

MCP Bridge 支持两类 transport。

### 1. stdio / stdout 子进程

适合本地命令行 MCP server，例如 filesystem、git、database 等服务。

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

为了兼容旧配置，省略 `transport` 且包含 `command` 时，也会按 `stdio` 处理。

### 2. HTTP Stream

适合远程 MCP 服务或由网关暴露的 MCP endpoint。Finch 会向 `url` 发送 JSON-RPC POST 请求，并支持 `application/json` 或 `text/event-stream` 响应。

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
        "MCP_TOKEN": "你的本地 token"
      }
    }
  ]
}
```

`env` 不会作为 HTTP body 发送；它只用于替换 `headers` 里的 `${KEY}` 占位。

## 配置文件

当前版本暂时不提供 MCP 配置 UI。MCP Bridge 会读取这些配置来源：

| 来源 | 用途 |
|---|---|
| `servers.json` | 用户手写 / 本地配置的 MCP server |
| `ctx.extensions.listContributions('mcpServers')` | 其他已启用扩展通过 manifest 贡献的 MCP server |

如果本地配置和插件贡献里有同名 server，`servers.json` 优先级更高，可覆盖插件贡献配置。

这两个文件的绝对路径是：

```
~/.finch/extension-data/mcp/servers.json
```

开发模式下根目录为 `~/.finch-dev/`。开发者可直接手写 `servers.json`（格式见上文），改动后重启 Finch 生效。插件贡献的 MCP server 来自 enabled plugin 的 manifest contribution 快照。

## 给其他插件使用

MCP Bridge 提供 `mcp.client` capability。其他插件可以在 manifest 中声明依赖：

```json
{
  "finch": {
    "requires": {
      "capabilities": ["mcp.client"]
    }
  }
}
```

然后在插件中调用：

```ts
const mcp = await ctx.capabilities.get('mcp.client');
const servers = await mcp.listServers();
const tools = await mcp.listTools('filesystem');
const result = await mcp.callTool('filesystem', 'read_file', { path: '/tmp/a.txt' });
```

## 贡献 MCP 服务

其他插件可以通过 `contributes.mcpServers` 声明自己要注入的 MCP server：

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

Finch 会把名字自动加上插件 id 前缀，例如 `my-plugin.my-server`，避免不同插件冲突。

## 环境变量与密钥

- `stdio`：`env` 会合并到 MCP server 子进程环境变量中。
- `httpStream`：`env` 用于替换请求 header 中的 `${KEY}` 占位。
- 不要把真实密钥写进插件 manifest。需要密钥时，优先通过本地 `servers.json` 或 Finch 后续恢复的密钥配置 UI 注入。

## 多语言 README

插件 README 支持多语言文件名：

- `README.zh-CN.md`
- `README.en-US.md`
- `README.md`（默认回退）

Finch 会按当前界面语言选择最合适的 README。