# Finch 扩展

扩展（Extension）是 Finch 的代码级扩展点。与 Skill 不同，扩展是可执行的 JavaScript/TypeScript 程序，能给 Finch Agent 增加新工具、在 Composer 工具栏贡献按钮，以及（未来）渲染自定义 UI 面板。

## 扩展 vs. Skill

| | Skill | Extension |
|---|---|---|
| 形态 | `SKILL.md` 文本指南 | 可执行 JS/TS 程序 |
| 开发门槛 | 写 Markdown 即可 | 需要写代码 |
| 能做什么 | 告诉 AI 如何完成某类任务 | 给 AI 增加新工具、改变 UI |
| 适合场景 | 流程规范、写作模板、项目规则 | MCP 接入、API 集成、自定义按钮 |

---

## 扩展放在哪里

Finch 从三个层级扫描扩展，优先级从高到低：

| 层级 | 路径 | 适用场景 |
|---|---|---|
| **项目级** | `<cwd>/.finch/extensions/<id>/` | 当前项目专用，不跨 Space |
| **个人级** | `<finchHome>/.finch/extensions/<id>/` | 个人全局，默认 `~/finchnest/.finch/extensions/` |
| **全局级** | `~/.finch/extensions/<id>/` | 所有 Space / Session 可用 |

### 扩展运行时文件位置

扩展代码与运行时数据是分开存放的：

| 用途 | 路径 |
|---|---|
| 扩展代码（安装目录） | `~/.finch/extensions/<id>/`、`<finchHome>/.finch/extensions/<id>/`、`<cwd>/.finch/extensions/<id>/` |
| 启用 / 权限状态 | `~/.finch/extensions.json` |
| 扩展私有数据目录 | `~/.finch/extension-data/<id>/` |
| └ KV 存储（`ctx.storage`） | `~/.finch/extension-data/<id>/storage.json` |
| └ 用户设置（`ctx.settings`） | `~/.finch/extension-data/<id>/settings.json` |
| └ 密钥（`ctx.secrets`） | `~/.finch/extension-data/<id>/secrets.json` |

开发模式下根目录为 `~/.finch-dev/`。目前 Finch 不提供修改这些文件的界面；开发者可以**手动编辑**对应文件来配置扩展（例如 MCP Bridge 的 `~/.finch/extension-data/mcp/servers.json`），改动后重启 Finch 生效。

> **捆绑扩展**：Finch 内置的官方扩展（如 mcp）位于仓库 `extensions/` 目录。Finch 启动时会自动扫描 `extensions/*/package.json`，安装/更新到全局目录，并在首次安装时默认启用。用户禁用后不会被更新强制重新启用。

---

## 扩展包结构

最小发布结构：

```text
my-extension/
├── package.json   ← 必须包含 finch manifest
└── dist/
    └── index.js   ← 编译后的 ESM 入口
```

推荐的 TypeScript 项目结构：

```text
my-extension/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts
├── skills/                # 可选：扩展内置 Skills
│   └── my-skill/
│       └── SKILL.md
└── dist/
    └── index.js
```

---

## Manifest（`package.json#finch`）

扩展的 manifest 写在 `package.json` 的 `"finch"` 字段：

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "finch": {
    "manifestVersion": 1,
    "id": "my-extension",
    "name": "My Extension",
    "description": "What this extension does.",
    "systemPrompt": "When the user asks about X, prefer this extension's tools.",
    "promptGuides": [
      {
        "id": "start",
        "title": "Start with this extension",
        "prompt": "/my_extension_skill Help me complete ..."
      }
    ],
    "main": "dist/index.js",
    "activationEvents": ["onStartup"],
    "pluginType": "community",
    "categories": ["integration"],
    "privacyPolicyUrl": "https://example.com/privacy",
    "termsOfServiceUrl": "https://example.com/terms",
    "contributes": {
      "tools": true,
      "skills": true,
      "composerActions": [
        { "id": "my-btn", "icon": "Star", "tooltip": "Open example action" }
      ]
    },
    "provides": { "capabilities": ["example.client"] },
    "requires": { "capabilities": ["mcp.client"] },
    "permissions": {
      "filesystem": "none",
      "network": false,
      "shell": false,
      "secrets": ["MY_API_KEY"]
    }
  }
}
```

### manifest 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `manifestVersion` | ✅ | 固定为 `1` |
| `id` | ✅ | 全局唯一（小写字母/数字/连字符），安装后不可更改 |
| `name` | ✅ | 用户可见名称。**新扩展请写默认字符串，不要在 manifest 内联 i18n**；`displayName` 仅为兼容旧字段 |
| `description` | | 扩展说明。新扩展请写默认字符串；多语言放 `i18n/<locale>.json` |
| `systemPrompt` | | 一句话动态 system prompt；扩展启用后注入，用于说明工具何时/如何使用。新扩展请写默认字符串；多语言放 `i18n/<locale>.json` |
| `toolMeta.name` | | 模型侧工具来源显示名；默认使用扩展显示名。多语言放 `i18n/<locale>.json` |
| `promptGuides` | | 扩展详情页 README 上方展示的引导语卡片，点击可填入 HomeView Composer；manifest 中保留默认字符串，多语言放 `i18n/<locale>.json`，prompt 可包含 `/skill` |
| `main` | ✅ | 编译后入口文件，相对于包根目录 |
| `activationEvents` | | `"onStartup"` / `"onCommand"` / `"onSpace:<id>"` |
| `contributes.tools` | | `true` 表示贡献 Agent 工具 |
| `contributes.composerActions` | | Composer 工具栏按钮的静态声明（`id`/`icon`/`tooltip`） |
| `contributes.skills` | | `true` 表示扩展包内含 `skills/`，仅扩展启用时参与检索 |
| `pluginType` | | `"official"` / `"community"` / `"local"` |
| `categories` | | 扩展分类，用于工具箱/市场展示 |
| `privacyPolicyUrl` | | 隐私政策 URL |
| `termsOfServiceUrl` | | 服务条款 URL |
| `provides.capabilities` | | 本扩展提供的能力，例如 `mcp.client` |
| `requires.capabilities` | | 本扩展依赖的能力，例如社区扩展依赖官方 MCP |
| `permissions.filesystem` | | `"none"` / `"readonly"` / `"read"` / `"readwrite"` |
| `permissions.network` | | `true` / `false` |
| `permissions.shell` | | `true` / `false` |
| `permissions.secrets` | | 可访问的密钥 key 数组 |

### Manifest i18n

**现行推荐做法：manifest 只放默认字符串，不要直接内联 i18n。**

多语言文案统一放在 `i18n/<locale>.json`。运行时仍兼容旧的 `LocalizedString` 内联写法，用于历史扩展向后兼容，但**新扩展不应再使用**。

manifest 示例：

```jsonc
{
  "finch": {
    "name": "File Helper",
    "description": "Manage local files",
    "systemPrompt": "When the user needs file management, prefer the File Helper extension.",
    "toolMeta": { "name": "File Helper" },
    "promptGuides": [
      {
        "id": "scan",
        "title": "Scan folder",
        "description": "List folder contents",
        "prompt": "Scan the current folder"
      }
    ],
    "contributes": {
      "composerActions": [
        { "id": "open-file", "icon": "File", "tooltip": "Open file" }
      ]
    }
  }
}
```

外部 `i18n/<locale>.json` 覆盖：

```text
my-extension/
├── i18n/
│   ├── zh-CN.json
│   └── en-US.json
└── package.json
```

`i18n/zh-CN.json` 示例：

```json
{
  "name": "文件助手",
  "description": "管理本地文件",
  "systemPrompt": "当用户需要管理文件时，优先使用文件助手扩展。",
  "toolMeta": { "name": "文件助手" },
  "promptGuides": {
    "scan": {
      "title": "扫描目录",
      "description": "列出目录内容",
      "prompt": "帮我扫描当前目录"
    }
  },
  "composerActions": {
    "open-file": { "tooltip": "打开文件" }
  }
}
```

外部 i18n 会覆盖当前 UI locale 对应的用户可见字段。不要本地化可执行标识符：扩展 `id`、工具 `name`、composer action `id`、command id、capability name、MCP server name、storage key 等都应保持稳定。

当前支持通过 `i18n/<locale>.json` 覆盖的字段包括：`name`/`displayName`、`description`、`systemPrompt`、`toolMeta.name`、`promptGuides[].title/description/prompt`、`contributes.composerActions[].tooltip`。

---

## 扩展入口

扩展入口导出两个**命名函数**：

```ts
import type * as finch from 'finch';

export function activate(ctx: finch.ExtensionContext) {
  // 注册工具、按钮等
  ctx.subscriptions.push(
    ctx.tools.register({ ... }),
    ctx.composerActions.register('my-btn', { ... }),
  );
  ctx.logger.info('activated');
}

export function deactivate() {
  // 可选：清理连接、进程等资源
  // ctx.subscriptions 里的资源由 Finch 自动 dispose，无需手动处理
}
```

> **重要**：使用 `import type * as finch from 'finch'`（type-only import）。编译后完全擦除，无需运行时解析 `finch` 模块。所有 API 通过 `ctx` 调用，不通过 `finch.*` 全局调用。

---

## TypeScript 项目配置

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2022",
    "outDir": "dist",
    "strict": true,
    "paths": {
      "finch": ["../../packages/extension-api/finch.d.ts"]
    }
  }
}
```

> `paths` 中的路径根据扩展实际位置调整。如果扩展安装在项目外，也可以直接复制 `finch.d.ts` 到扩展目录并在 `paths` 中指向本地副本。

---

## API 速查

所有能力都挂在 `ctx`（`finch.ExtensionContext`）上：

| `ctx.*` | 说明 | 状态 |
|---|---|---|
| `ctx.subscriptions` | Disposable 数组，停用时自动清理 | ✅ |
| `ctx.extension` | 扩展元信息（id/版本/路径） | ✅ |
| `ctx.storagePath` | 私有存储目录绝对路径 | ✅ |
| `ctx.tools` | Agent 工具注册 | ✅ |
| `ctx.composerActions` | Composer 工具栏按钮注册 | ✅ |
| `ctx.storage` | 私有 KV 存储 | ✅ |
| `ctx.settings` | 用户配置的设置（只读，manifest 声明 schema） | ✅ |
| `ctx.logger` | 带前缀日志 | ✅ |
| `ctx.secrets` | 密钥读取 | ✅ |
| `ctx.session` | 当前 session 快照（只读，随活动会话更新） | ✅ |
| `ctx.workspace` | 当前 Space/Workspace 信息（只读，随活动空间更新） | ✅ |
| `ctx.commands` | 命令注册 | 🔜 Phase 2 |
| `ctx.ui` | Webview Panel / 通知 | 🔜 Phase 2 |

完整类型声明：`packages/extension-api/finch.d.ts`

---

## 注册 Agent 工具

```ts
ctx.subscriptions.push(
  ctx.tools.register({
    name: 'search_docs',           // 扩展内名（小写+下划线）
    title: 'Search Docs',          // UI 展示短名
    description: 'Search the internal documentation for a given query. '
      + 'Call when the user asks about project-specific knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
    risk: 'low',                   // 'low' | 'medium' | 'high'
    async execute({ query }, exec) {
      exec.logger.info('searching:', query);
      const results = await mySearch(query);
      return {
        content: [{ type: 'text', text: JSON.stringify(results) }],
      };
    },
  }),
);
```

模型看到的工具名为 `<extensionId>_<name>`，例如 `myextension_search_docs`。

### `execute` 中的 `exec`（`ToolExecutionContext`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `exec.toolCallId` | `string` | 本次调用 ID |
| `exec.sessionId` | `string` | 当前 session ID |
| `exec.spaceId` | `string?` | 当前 Space ID |
| `exec.cwd` | `string?` | 当前有效工作目录 |
| `exec.token` | `CancellationToken` | 中止信号 |
| `exec.logger` | `Logger` | 带扩展前缀的日志 |
| `exec.storage` | `Storage` | 私有 KV 存储 |
| `exec.secrets` | `Secrets` | 密钥读取 |
| `exec.ui` | `ToolUi` | 工具执行期 UI 交互面（表单） |

### 用 `exec.ui.requestForm` 收集用户输入（含密钥）

当工具需要让用户输入信息——尤其是 **API Key / Token 等密钥**——时，用 `exec.ui.requestForm(spec)` 在等候区弹出一个表单。它和 AskUserQuestion 卡片共用同一外框，只是内容由扩展定义。表单在所有窗口同步、可重放。

```ts
const result = await exec.ui.requestForm({
  title: '连接服务',
  description: '密钥只保存在本机，不会发送给 AI。',
  submitLabel: '保存',
  fields: [
    { key: 'name', label: '名称', type: 'text', required: true },
    { key: 'apiKey', label: 'API Key', type: 'password', secret: true },
    { key: 'mode', label: '模式', type: 'select', options: [
      { value: 'a', label: '模式 A' }, { value: 'b', label: '模式 B' },
    ] },
  ],
});

if (!result.submitted) {
  return { content: [{ type: 'text', text: '用户取消了配置。' }] };
}
// result.values.apiKey 由你写入 ctx.secrets / 本地文件，
// 切勿把 secret 字段回写进返回给模型的 ToolResult。
```

字段类型：`text` / `password` / `textarea` / `number` / `select` / `boolean`。

安全约定：
- `secret: true` 的字段在 UI 渲染为密码框；其值由用户直接输入，AI 既不提供也看不到。
- **扩展作者负责**：不要把 secret 字段的值写进返回给模型的 `ToolResult.content`。

生命周期与超时：
- 用户取消、超时、或 session 结束未提交时，`requestForm` 返回 `{ submitted: false }`，工具不会永久挂起。
- 非提交结果带 `reason`：`'cancelled'`（用户取消）/ `'timeout'`（超时）/ `'session-ended'`（session 结束）。
- 可选 `spec.timeoutMs`（毫秒）设置自动取消超时；省略则一直等待用户操作或 session 结束。
- `number` 字段提交时会被强转为真正的 `number`（非法/空值回退为字符串）。

> 官方 **MCP Bridge** 的 `MCP action=add/edit` 管理 dispatcher 就是用 `exec.ui.requestForm` 收集 server 配置和密钥、写入 `servers.json` 的范例。

---

## 注册 Composer 工具栏按钮

Composer 扩展分两步：

**Step 1 — manifest 静态声明**（写在 `package.json#finch.contributes.composerActions`）：

```json
"contributes": {
  "composerActions": [
    { "id": "git-branch", "icon": "GitBranch", "tooltip": "切换 Git 分支" }
  ]
}
```

- `id`：与 `ctx.composerActions.register(id, ...)` 对应
- `icon`：IconRef。可用 Finch 内置图标名（固定集合，如 `"GitBranch"`、`"Star"`），或通过 `contributes.iconPacks` 声明图标包并在代码里 `ctx.icons.register()` 注册 SVG 后引用 `ext:<iconId>` / `ext:<packId>/<iconId>`
- `tooltip`：悬停提示文字

**Step 2 — activate() 动态数据绑定**：

```ts
ctx.subscriptions.push(
  ctx.composerActions.register('git-branch', {
    // 返回按钮上的徽标文字（如分支名）
    // 抛出错误 → 按钮隐藏（当前 cwd 不适用）
    // 返回 undefined → 按钮可见但无徽标
    async getBadge({ cwd }) {
      if (!cwd || !hasDotGit(cwd)) throw new Error('not a git repo');
      return getCurrentBranch(cwd);
    },
    // 用户点击按钮后拉取菜单项
    async getMenu({ cwd }) {
      return listBranches(cwd).map(b => ({ id: b, label: b, current: b === currentBranch }));
    },
    // 用户选中菜单项时执行
    async execute({ cwd }, branchName) {
      await checkout(cwd, branchName);
    },
  }),
);
```

`getBadge` / `getMenu` / `execute` 中的 `ctx`（`ComposerActionContext`）：

| 字段 | 说明 |
|---|---|
| `ctx.cwd` | 当前有效工作目录 |
| `ctx.sessionId` | 当前 session ID |
| `ctx.spaceId` | 当前 Space ID |

---

## Storage（私有 KV）

```ts
// 写入
await ctx.storage.set('lastRun', Date.now());

// 读取（带泛型）
const t = await ctx.storage.get<number>('lastRun');

// 删除
await ctx.storage.delete('lastRun');

// 清空
await ctx.storage.clear();

// 列出所有 key
const keys = await ctx.storage.keys();
```

数据存储在 `~/.finch/extension-data/<id>/storage.json`。**不要在 storage 里存密钥**，请用 `ctx.secrets`。

---

## Settings（用户配置）

扩展可在 manifest 中声明 `settings.fields`，Finch 会在**扩展详情页原生渲染表单**，
用户填写后保存到 `~/.finch/extension-data/<id>/settings.json`。扩展通过 `ctx.settings`
只读访问，**保存后扩展会自动重新加载**，届时重新读取最新值。

```json
"finch": {
  "settings": {
    "fields": [
      {
        "key": "endpoint",
        "type": "string",
        "label": { "en-US": "API Endpoint", "zh-CN": "接口地址" },
        "placeholder": "https://api.example.com",
        "description": { "en-US": "Base URL", "zh-CN": "服务基础地址" }
      },
      {
        "key": "verbose",
        "type": "boolean",
        "label": { "en-US": "Verbose logging", "zh-CN": "详细日志" },
        "default": false
      }
    ]
  }
}
```

字段类型：`string`（可加 `secret: true` / `multiline: true`）、`number`、`boolean`、
`select`（带 `options`）、`list`（对象数组，行内 `itemFields` 为上述标量类型）。

```ts
const endpoint = ctx.settings.get<string>('endpoint');
const all = ctx.settings.all();
```

> 官方 **MCP 桥接扩展** 就用一个 `list` 设置项让用户配置自定义 MCP server（name/command/args/env），
> 保存后桥接重连并暴露其工具——这是「扩展自带设置页」的范例。

---

## Secrets（密钥访问）

先在 manifest 中声明：

```json
"permissions": {
  "secrets": ["MY_API_KEY"]
}
```

再在代码中读取：

```ts
const apiKey = await ctx.secrets.get('MY_API_KEY');
if (!apiKey) throw new Error('请在设置 → 扩展中填写 MY_API_KEY');
```

密钥由 Finch 使用系统 Keychain / Secret Service 存储，扩展只能读取，无法写入。

---

## Logger

```ts
ctx.logger.debug('debug info', { detail });
ctx.logger.info('extension started');
ctx.logger.warn('something may be wrong');
ctx.logger.error('failed:', err);
```

日志自动附加扩展 id 前缀，输出到扩展日志文件：

- 开发模式：`~/.finch-dev/logs/extensions/<id>.log`
- 生产模式：`~/Library/Logs/Finch/extensions/<id>.log`（macOS），`%APPDATA%\Finch\logs\extensions\<id>.log`（Windows）

---

## 扩展内置 Skills

扩展可以携带自己的 Skills，支持两种目录约定：

```text
my-extension/
├── skills/                 # 推荐
│   └── mcp-helper/
│       └── SKILL.md
└── .finch/skills/          # skill-creator 默认产物，也被识别
    └── mcp-helper/
        └── SKILL.md
```

策略：

- Finch 不会把这些 Skills 复制到全局 `~/.finch/skills/`。
- Finch 会在扫描 Skills 时动态读取**已启用扩展**的 `skills/` 与 `.finch/skills/` 目录。
- 扩展停用或卸载后，它携带的 Skills 自动从检索结果中消失。
- UI 中会标记来源为对应扩展名，并在扩展详情页「提供的技能」区列出。

---

## Capabilities（扩展间协作）

扩展可以 `provide` 一个具名能力（一组异步方法），其它扩展用 `get` 获取并调用，
无需互相 import 代码。能力调用跨进程经主进程路由，**消费侧每个方法都返回 Promise**。

manifest 门控：

```jsonc
// 提供方 package.json#finch
"provides": { "capabilities": ["mcp.client"] }

// 消费方 package.json#finch
"requires": { "capabilities": ["mcp.client"] }
```

只能 `provide` 自己在 `provides.capabilities` 声明过的名字；只能 `get` 自己在
`requires.capabilities` 声明过的名字。

```ts
// 提供方
ctx.subscriptions.push(
  ctx.capabilities.provide('mcp.client', {
    async listServers() { return [...servers.keys()]; },
    async callTool(server, name, args) { return run(server, name, args); },
  }),
);

// 消费方
if (ctx.capabilities.has('mcp.client')) {
  const mcp = ctx.capabilities.get<{ listServers(): Promise<string[]> }>('mcp.client');
  const names = await mcp.listServers();
}
```

> 提供方扩展必须处于**启用**状态能力才可用，建议用 `ctx.capabilities.has()` 守卫并优雅降级。

### ToolCallCard 展示元信息（`callDisplay`）

扩展工具现在可以声明 ToolCallCard 的显示元信息，让卡片标题不必只剩原始 JSON：

```ts
ctx.tools.register({
  name: "repo_issues",
  title: "List issues",
  description: "List issues for a repository.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      state: { type: "string" },
    },
    required: ["owner", "repo"],
  },
  callDisplay: {
    inline: {
      mode: "join",
      fields: [{ path: "owner" }, { path: "repo" }, { path: "state" }],
      template: "{owner}/{repo} state:{state}",
    },
  },
  async execute(input) {
    return { content: [{ type: "text", text: JSON.stringify(input) }] };
  },
});
```

常见用途：

- `action`
- `owner/repo`
- `query`
- `path`
- `state` / `perPage`

建议：

- 用它展示**稳定、短小、可扫读**的关键参数
- 不要展示 secret / token / 超长正文
- MCP 贡献服务的 display metadata 由**贡献扩展自己声明**，不要堆进 MCP Bridge

官方 **MCP 桥接扩展**（id `mcp`）即通过 `provides: ["mcp.client"]` 暴露此能力：
它读取 `<extensionData>/mcp/servers.json`（用户配置）与 `ctx.extensions.listContributions('mcpServers')`
中的 MCP 服务器，把每个服务器的工具注册为 Agent 工具，并提供 `mcp.client` 供其它扩展复用。

---

## 贡献 MCP 服务（注入）

除 tools、skills 外，扩展可以**声明式贡献 MCP server**。在 `contributes.mcpServers`
中声明后，MCP 桥接扩展会通过 `ctx.extensions.listContributions('mcpServers')` 读取已启用扩展的贡献，
由桥接连接并把工具暴露给 Agent——无需在 `activate()` 里写任何代码。

```jsonc
// package.json#finch
"contributes": {
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "description": "本地文件系统访问",
      "toolMeta": {
        "titles": {
          "read_file": "Read file",
          "move_file": "Move file"
        }
      },
      "toolDisplay": {
        "tools": {
          "read_file": {
            "inline": {
              "mode": "join",
              "fields": [{ "path": "path", "format": "path", "maxLength": 40 }],
              "template": "path:{path}"
            }
          },
          "move_file": {
            "inline": {
              "mode": "join",
              "fields": [
                { "path": "source", "format": "path", "maxLength": 32 },
                { "path": "destination", "format": "path", "maxLength": 32 }
              ],
              "template": "from:{source} to:{destination}"
            }
          }
        }
      }
    }
  ]
},
"requires": { "capabilities": ["mcp.client"] }
```

- 需要 MCP 桥接扩展（提供 `mcp.client`）已**安装并启用**；建议同时声明
  `requires.capabilities: ["mcp.client"]`，扩展详情页会据此检测并提示安装/启用。
- 贡献的 server 名默认作为模型工具名前缀，例如 `filesystem` → `mcp__filesystem__read_file`；冲突处理属于 MCP 桥接策略。
- 只有**扩展贡献**的 MCP 服务应在 ToolCallCard 上做名称映射 / inline 参数展示；用户直接在 MCP Bridge 中添加的服务保持原始 MCP tool name。这样 Bridge 保持通用，具体语义由贡献扩展负责。
- 如果你希望贡献的 MCP 工具使用更短的名字，请在扩展里声明 `mcpServers[].toolMeta.titles`。
- 如果你希望 ToolCallCard 标题旁显示 `path`、`owner/repo`、`action` 等关键信息，请在扩展里声明 `mcpServers[].toolDisplay`。
- 扩展启用/停用时，Host 会更新通用 contribution 快照；桥接在使用前刷新 server 集合。
- 这是声明式路径；若需在代码里主动驱动 MCP，请改用 `mcp.client` 能力。

---

## 安装与启用

### 使用 CLI 安装

```bash
# 从 npm 安装到当前项目
npx @finch.app/extensions add @scope/finch-extension-example

# 从本地目录安装
npx @finch.app/extensions add ./my-extension

# 从 zip 文件安装（本地或远程 URL）
npx @finch.app/extensions add ./my-extension.zip
npx @finch.app/extensions add https://github.com/user/repo/archive/refs/heads/main.zip

# 安装到全局 ~/.finch/extensions/
npx @finch.app/extensions add @finch/extension-mcp --global

# 更新到最新发布版本（npm 来源按 lock 记录的包名重装；zip URL 来源重新下载；本地来源从原路径重拷）
npx @finch.app/extensions update my-extension

# 列出、删除、校验
npx @finch.app/extensions list
npx @finch.app/extensions remove my-extension
npx @finch.app/extensions doctor ./my-extension
```

CLI 只负责安装。安装后扩展默认不启用，请在 Finch → Toolcase → Extensions 中审查权限并启用。启用前 Finch 会展示扩展声明的权限、secrets 和 capabilities，用户确认后才写入授权记录。

`doctor` 除校验 manifest/入口外，还会静态扫描源码并对以下情况给出告警：运行时 `import from 'finch'`（应为 `import type`）、引用已移除的 `FinchPluginAPI`、直接 `import 'electron'` 或 Finch 内部源码（`src/main|renderer|shared`）。

> **更新也可在应用内完成**：Finch → Toolcase → Extensions 选中扩展后「检查更新」，有新版本时出现「立即更新」按钮（npm 来源的扩展）。官方内置扩展随 Finch 版本一起更新，无需单独操作。

> **官方内置扩展**（如 git-branch）在应用安装后即**预授权并默认启用**，用户无需手动开启；需要配置才有意义的内置扩展（如 MCP 桥接，`autoEnable: false`）仍保持关闭，等用户在设置页配置后启用。

### 手动安装（开发中）

将扩展目录复制到全局或个人目录：

```bash
cp -r ./my-extension ~/.finch/extensions/my-extension
```

然后在 **Finch 工具箱 → 扩展 → 启用** 中开启该扩展。

> 扩展安装后默认禁用，需要手动启用。这是出于安全考虑：安装 ≠ 信任。授权状态保存在 `~/.finch/extensions.json`，兼容旧的 `enabled[]` 结构，并新增 `extensions[id].grantedPermissions/grantedAt`。

### 热重载

扩展运行在隔离的 PluginHost 子进程中。在 Finch → Toolcase → Extensions 里**停用再启用**扩展会重启其 host 进程，加载最新代码——无需重启整个 Finch。

**开发循环建议**：
1. 修改代码 → `npm run build`
2. 在扩展详情页停用再启用（重启该扩展的 host 进程）
3. 查看 Finch 开发者工具控制台确认 `[plugin-host:my-extension] activated`

---

## 错误隔离

Finch 对扩展执行有完整的错误隔离：

| 执行路径 | 出错结果 |
|---|---|
| `activate()` 抛错 | 存入 error badge，回滚所有注册，主进程不受影响 |
| `deactivate()` 抛错 | 静默忽略 |
| `getBadge()` 抛错 | 按钮静默隐藏 |
| `getMenu()` 抛错 | 返回空菜单 |
| `execute()` 抛错（ComposerAction） | 记录日志，不影响主进程 |
| `execute()` 抛错（Tool） | 以 `isError: true` 的工具结果返回给模型 |

扩展现在运行在独立 PluginHost 子进程中，主进程通过 IPC/RPC 与扩展通信。这样扩展 `activate()` / tool / composer action 的异常或子进程崩溃不会直接拖垮 Finch 主进程。

注意：当前 PluginHost 是 Node child process，已经完成进程隔离和 API broker，但还不是完整 OS 级沙箱。扩展理论上仍可能使用 Node 内置模块访问系统资源；后续会通过启用时权限确认、运行时权限 broker、危险 import 扫描进一步收紧。

---

## 完整示例

参考捆绑扩展 `extensions/mcp/` 与 `skills/finch-extension-creator/`。

### 最简 Agent 工具扩展（TypeScript）

```ts
import type * as finch from 'finch';

export function activate(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'greet',
      title: 'Greet',
      description: 'Say hello. Call when the user wants a greeting.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      async execute({ name }) {
        return { content: [{ type: 'text', text: `Hello, ${String(name)}!` }] };
      },
    }),
  );
}

export function deactivate() {}
```

### TypeScript 扩展起步

参考 `extensions/mcp/` 或 `skills/finch-extension-creator/`，然后：

1. 改 `package.json#finch.id`（全局唯一）
2. 更新 `src/index.ts` 的工具/按钮逻辑
3. 运行 `npm install && npm run build`
4. 安装到 `~/.finch/extensions/<id>/` 并在 Finch 工具箱中启用

---

## 安全提示

- 扩展运行在独立 PluginHost 子进程中，但当前仍是 Node 运行时，不是完整 OS 沙箱，安装前请确认来源可信。
- 扩展不应 import Finch 内部源码或 Electron API，只能通过 `ctx.*` 使用 Finch 提供的能力。
- 不要将 API Key 等密钥硬编码在扩展代码中，请使用 `permissions.secrets` + `ctx.secrets.get()`。
- 项目级扩展（`.finch/extensions/`）只在对应 Space/目录下激活，但仍有访问主机资源的能力，请谨慎使用来源不明的项目扩展。
