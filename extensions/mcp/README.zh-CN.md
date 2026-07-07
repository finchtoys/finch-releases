# MCP Client

MCP Client 是 Finch 为小工具提供的 MCP 桥接扩展，用来把 Model Context Protocol（MCP）server 暴露给 Agent 使用。

对小工具作者来说，推荐做法是：

1. 在 manifest 中声明依赖 `mcp.client` capability。
2. 在 `contributes.mcpServers` 中只声明**展示元数据**：server name、工具标题、ToolCallCard 展示规则。
3. 用自己的 setup 工具通过安全表单收集密钥。
4. 把密钥保存在小工具自己的 `ctx.storage` 中。
5. 在运行时通过 `mcp.client#registerServer()` 注册真实 MCP transport。

Tavily Search 采用的就是这条路径：manifest 只描述 Tavily 工具在 Finch 里如何展示；真正的 MCP server 则在 API Key 可用后，由 `activate()` 动态注册。

## 最佳实践：manifest 放 metadata，运行时注册 transport

### 1. 声明依赖和 MCP 展示元数据

在 `package.json` 里声明 `requires.capabilities: ["mcp.client"]`，并添加一个 metadata-only 的 `contributes.mcpServers` 条目。

当 server 依赖用户配置时，不要在这里写 `command`、`args`、`url`、`headers` 或任何密钥。

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

`toolMeta.titles` 控制 Finch 工具卡片上的短标题；`toolDisplay.tools` 控制工具调用旁边的 inline 摘要。

### 2. 运行时注册真实 MCP server

在小工具代码中，等配置可用后通过 `mcp.client` capability 注册 server。

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

runtime 注册是内存态，并绑定到小工具生命周期。小工具禁用或卸载后，这个 runtime server 会一起消失，不会在 MCP Client 的用户配置里留下孤儿条目。

### 3. 用 setup 工具收集密钥

用 setup 工具通过 Finch 安全表单收集密钥，写入自己扩展的 storage，然后调用 `registerServer()`。

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

密钥不要写进 `package.json`，不要提交进小工具包，也不要在工具结果里回传给模型。

## Server name 匹配规则

MCP Client 会用归一化后的 server name，把 runtime server config 和静态 contribution 合并起来。仅大小写不同可以兼容，但仍建议两边使用同一个稳定名称：

```text
contributes.mcpServers[].name = "My Service"
registerServer({ name: "my-service", ... })
→ 内部会按归一化后的名称匹配
```

模型可见的 MCP 工具名不会加小工具 id 前缀，格式是：

```text
mcp__<server>__<tool>
```

Finch 只在内部保留类似 `my-plugin.my-service` 的 owner-qualified key，用于 UI 归属和所有权展示，不作为模型看到的工具名。

## MCP Client 提供什么

`mcp.client` capability 主要给小工具使用，核心方法是：

```ts
interface McpClientCapability {
  listServers(): Promise<string[]>;
  getServerStatuses?(): Promise<Array<{ name: string; status: string; toolCount: number; ownerExtensionId?: string; qualifiedName?: string }>>;
  listTools(server: string): Promise<Array<{ name: string; title?: string; description?: string; inputSchema?: Record<string, unknown> }>>;
  registerServer(config: McpServerConfig): Promise<{ ok: boolean; error?: string }>;
  unregisterServer(name: string): Promise<{ ok: boolean }>;
}
```

普通小工具应优先使用 `registerServer()`，不要直接写 MCP Client 的配置文件。

## 手动 MCP 配置：支持，但不推荐给小工具使用

MCP Client 仍然支持用户手写 `servers.json`，用于本地高级配置和排障。这适合高级用户手动配置，但小工具不应该写这个文件：否则卸载小工具后会留下孤儿 server 配置。

路径：

```text
~/.finch/extension-data/mcp/servers.json
```

开发模式下根目录为 `~/.finch-dev/`。

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
        "MCP_TOKEN": "你的本地 token"
      }
    }
  ]
}
```

HTTP Stream 中的 `env` 只用于替换 `headers` 里的 `${KEY}` 占位，不会作为请求 body 发送。

## Agent 使用方式

Agent 不应该在工具尚未激活前直接调用 `mcp__<server>__<tool>`。它应先调用 Finch 的 `ToolSearch`，并设置 `source: "mcp"`；MCP Client 会连接匹配的 server、发现工具，并把命中的 MCP 工具注入当前 run。

这是 Agent 运行时优化细节。小工具作者通常只需要关注上面的 contribution + `registerServer()` 模式。
