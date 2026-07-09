# @finch.app/minitool-api

Type definitions for [Finch](https://finchwork.app) mini tool authors.

This is a **type-only** package — zero runtime dependencies, zero bundle impact. Use it as the published type package for Finch mini tools, then map the `finch` module to its declarations in `tsconfig.json`.

All runtime APIs are accessed through the `ctx` object injected at activation; the `finch` module name is only a compile-time type alias.

## Installation

```bash
npm install --save-dev @finch.app/minitool-api
```

## Quick Start

```ts
import type * as finch from 'finch';

export function activate(ctx: finch.MiniToolContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'greet',
      title: 'Greet',
      description: 'Say hello.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Name to greet' } },
        required: ['name'],
      },
      async execute({ name }) {
        return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
      },
    }),
  );
}

export function deactivate() {}
```

> **`import type`** — the import is erased at compile time. The `finch` module name is just a type alias for this package's declarations; runtime APIs still come from `ctx`.

## tsconfig Setup

Add a path alias so TypeScript resolves `'finch'` to this package's declarations:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "moduleResolution": "Bundler",
    "paths": {
      "finch": ["./node_modules/@finch.app/minitool-api/finch.d.ts"]
    }
  }
}
```

## API Overview

All APIs are accessed through `ctx` — `MiniToolContext` is the preferred public type for the single entry point. `ExtensionContext` remains available as a deprecated compatibility alias.

### Lifecycle

| Export | Description |
|---|---|
| `activate(ctx)` | Called when the extension is enabled. Register all resources here and push their `Disposable` handles into `ctx.subscriptions`. |
| `deactivate()` | Optional. Called before the extension is disabled. In-memory cleanup only — `ctx.subscriptions` are disposed automatically. |

### `ctx.tools` — Agent Tools

Register functions the AI agent can call. Each tool has a name, description, JSON Schema `inputSchema`, and an async `execute` handler.

```ts
ctx.tools.register({
  name: 'search_web',
  title: 'Search the Web',
  description: 'Search the web and return results.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  async execute({ query }, exec) {
    exec.logger.info('searching for', query);
    return { content: [{ type: 'text', text: await search(query) }] };
  },
});
```

The second argument `exec` is a `ToolExecutionContext` providing:

| Member | Type | Description |
|---|---|---|
| `exec.logger` | `Logger` | Prefixed log output |
| `exec.storage` | `Storage` | Extension-private KV store |
| `exec.secrets` | `Secrets` | Read-only access to declared secrets |
| `exec.ui.requestForm(spec)` | `Promise<ExtensionFormResult>` | Pop a user form inline during tool execution |
| `exec.signal` | `AbortSignal \| undefined` | Set to aborted when the user cancels |
| `exec.cwd` | `string \| undefined` | Active working directory |
| `exec.sessionId` | `string` | Current session id |

### `ctx.composerActions` — Composer Toolbar Buttons

Add buttons to the Composer input bar. Declare the button slot in `package.json` under `contributes.composerActions`, then register its logic at runtime:

```ts
ctx.composerActions.register('git-branch', {
  async getBadge({ cwd }) { return getCurrentBranch(cwd); },
  async getMenu({ cwd })  { return listBranches(cwd).map(b => ({ id: b, label: b })); },
  async execute({ cwd }, itemId, actions) { await checkoutBranch(cwd, itemId); },
});
```

### `ctx.ui` — UI

| Method | Description |
|---|---|
| `showToast(options)` | Non-blocking notification toast |
| `showConfirmDialog(options)` | Confirm / cancel modal |
| `showModalDialog(options)` | Custom-button modal |
| `showMessage(message, type?)` | Inline status message |
| `createCanvasWindow(options)` | Floating transparent window for desktop pets, overlays, etc. |

### `ctx.app` — Finch App Info

Read basic host app information such as version, build number, locale, platform, and User-Agent.

```ts
const app = await ctx.app.getInfo();
ctx.logger.info(`Running on Finch ${app.versionDisplay}`);
```

### `ctx.storage` — Private KV Store

Simple async key–value store scoped to this extension. Data is removed automatically when the extension is uninstalled.

```ts
await ctx.storage.set('config', { apiKey: 'sk-…' });
const config = await ctx.storage.get<{ apiKey: string }>('config');
await ctx.storage.delete('config');
```

### `ctx.secrets` — Secrets

Read-only access to secrets declared in `package.json → permissions.secrets`. Values are entered by the user in Finch Settings, never in code.

```ts
const apiKey = await ctx.secrets.get('MY_API_KEY');
```

### `ctx.settings` — User Settings

Read declared settings (defined by `package.json → settings` JSON Schema, rendered natively by Finch). Read-only; extension reloads after the user saves.

```ts
const theme = ctx.settings.get<string>('theme'); // returns T | undefined
```

### `ctx.capabilities` — Cross-Extension Communication

Extensions can provide and consume named capability APIs without importing each other directly. Calls are routed across the extension host boundary, so every method returns a `Promise`.

```ts
// Consumer
interface McpClient {
  listTools(server: string): Promise<{ name: string }[]>;
}
const mcp = ctx.capabilities.get<McpClient>('mcp.client');
const tools = await mcp.listTools('filesystem');
```

### `ctx.i18n` — Internationalization

Reads `i18n/<locale>.json` files from your extension directory. Automatically follows the Finch app language.

```ts
ctx.i18n.t('toast.saved', { name: 'config' });
ctx.i18n.onDidChangeLocale(locale => console.log('language changed to', locale));
```

### `ctx.logger` — Logging

```ts
ctx.logger.info('extension activated');
ctx.logger.error('something went wrong', err);
```

### `ctx.icons` — Runtime Icon Packs

Register SVG icons at runtime (declared in `package.json → contributes.iconPacks`):

```ts
ctx.icons.register('my-icons', {
  rocket: { svg: '<svg viewBox="0 0 24 24">…</svg>' },
});
```

### `ctx.session` / `ctx.workspace` — Read-only Context

```ts
ctx.session.id        // current session id
ctx.session.cwd       // active working directory
ctx.workspace.spaceId // active Space id (undefined in default session)
```

## Manifest (`package.json`)

All mini tool metadata lives under the `finch` key in `package.json`. Use `MiniToolManifest` for type hints:

```jsonc
{
  "name": "my-finch-extension",
  "version": "0.1.0",
  "main": "dist/index.js",
  "finch": {
    "manifestVersion": 1,
    "id": "my-extension",
    "name": "My Mini Tool",
    "description": "Does something useful.",
    "miniToolType": "community",
    "activationEvents": ["onStartup"],
    "contributes": {
      "tools": true,
      "composerActions": [
        { "id": "my-btn", "icon": "Star", "tooltip": "My Button" }
      ]
    },
    "permissions": {
      "filesystem": "read",
      "network": true,
      "shell": false,
      "secrets": ["MY_API_KEY"]
    }
  }
}
```

### Localization

Put locale overrides in `i18n/zh-CN.json` (or `i18n/en-US.json`). The `name`, `description`, `systemPrompt`, and `promptGuides` fields are looked up automatically.

```jsonc
// i18n/zh-CN.json
{
  "name": "我的扩展",
  "description": "做些有用的事。",
  "toast.saved": "已保存 {name}"
}
```

### MCP Server Contributions

Declare an MCP stdio server that Finch's MCP Bridge will start when your extension is enabled:

```jsonc
"contributes": {
  "mcpServers": [
    {
      "name": "my-server",
      "command": "npx",
      "args": ["-y", "my-mcp-server@latest"],
      "env": { "API_KEY": "" },
      "description": "My MCP server. Run setup_my_extension before use."
    }
  ]
}
```

## Links

- [Finch Extension Developer Guide](https://finchwork.app/docs/extensions)
- [Finch Desktop App](https://finchwork.app)

## License

MIT
