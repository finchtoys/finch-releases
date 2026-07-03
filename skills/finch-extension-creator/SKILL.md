---
name: finch-extension-creator
description: >
  Guide for developing, debugging, installing, and publishing Finch extensions.
  Invoke this skill whenever the user wants to create a new Finch extension,
  extend Finch with custom Agent tools or Composer toolbar buttons, understand
  the finch.d.ts API, debug an existing extension, install/deploy/update/remove
  an extension with the official `npx @finch.app/extensions` CLI, or publish an
  extension to npm/the community catalog. Trigger on phrases like "write a finch
  extension", "create a finch extension", "add a tool to finch", "debug my
  extension", "extension not loading", "how do I make a composer button",
  "install this finch extension", "deploy/publish a finch extension", etc.
---

# Finch Extension Developer Guide

Finch extensions are npm-style TypeScript packages discovered from the file
system. They contribute Agent tools (callable by the model), Composer toolbar
buttons, and bundled Skills. All extension capabilities are accessed through a
single `ExtensionContext` (`ctx`) object passed to the `activate()` function.

---

## 0  Where Extensions Live (read first)

Decide the install location **before** scaffolding. Finch discovers extensions
from two supported tiers, checked in this precedence order (personal overrides
global on id collision):

| Tier | Path | Use when |
|---|---|---|
| Personal | `<finchHome>/.finch/extensions/<id>/` (default `~/finchnest/.finch/extensions/`) | **Default choice.** A personal extension you use across projects/sessions. |
| Global | `~/.finch/extensions/<id>/` (dev: `~/.finch-dev/extensions/`) | Official/bundled extensions, or something you want in every Finch install on the machine. |

Default to **personal** unless the user asks otherwise. Confirm the target
path with the user if it is ambiguous.

> **Project-level `<cwd>/.finch/extensions/<id>/` is not a supported install
> target for new extensions.** Do not scaffold or install extensions there.
> Older Finch builds treated it as a lowest-precedence dev-only fallback
> (never overriding an already-installed same-id extension), but the current
> recommended workflow is personal or global only — always install through
> the CLI (§0.1) so extensions show up consistently across every Space.

> The extension **id** (`finch.id` in package.json) and the **directory name**
> should match to avoid confusion. The id is what appears in `~/.finch/extensions.json`.

---

## 0.1  Install and Manage Extensions with the Official CLI

**Always prefer `npx @finch.app/extensions` over manually `cp`-ing directories
around.** It resolves the correct install path (reading
`~/.finch/workspace.json#finchHomeDir` for the personal tier), copies the
extension, and records an install-source lock file so `update` can pull fresh
copies later. This is the same tool end users are told to use, so testing with
it also exercises the real install path.

```bash
# Install to the personal tier (default — <finchHome>/.finch/extensions/<id>/)
npx @finch.app/extensions add ./my-extension

# Install globally (~/.finch/extensions/<id>/ — available in every session)
npx @finch.app/extensions add ./my-extension --global

# Install from npm or a zip (local path or URL) — same flags apply
npx @finch.app/extensions add @scope/finch-extension-example
npx @finch.app/extensions add https://github.com/user/repo/archive/refs/heads/main.zip

# Validate a manifest + lint the source before installing (no side effects)
npx @finch.app/extensions doctor ./my-extension

# List / update / remove / enable / disable
npx @finch.app/extensions list [--global]
npx @finch.app/extensions update <id> [--global]
npx @finch.app/extensions remove <id> [--global]
npx @finch.app/extensions enable <id>
npx @finch.app/extensions disable <id>

# Print resolved install paths for this machine
npx @finch.app/extensions where
```

Key behaviors to know:

- `add` only installs the files — it never grants permissions or enables the
  extension. The user still reviews and enables it in Finch → Toolcase →
  Extensions.
- `doctor` runs a static lint over the extension's source (flags runtime
  `import ... from 'finch'` instead of `import type`, references to the
  removed `FinchPluginAPI`, direct `electron` imports, and imports reaching
  into Finch's own `src/main|renderer|shared`). Run it before every install
  during development — it catches the most common mistakes instantly.
- `update <id>` re-pulls from the recorded install source (local path, npm
  package, or zip URL) — use it instead of re-running `add` when iterating on
  a local extension you already installed.
- There is **no `--cwd` / project-scope flag documented here** — project-tier
  install is legacy and not the recommended path (see §0).

---

## API reference is bundled with this skill

Read the API types from this skill's own copy — do **not** read Finch source:

```
<this-skill>/reference/finch.d.ts
```

Point the extension's `tsconfig.json` `paths.finch` at the installed
`@finch/extension-api` package (preferred) or a local copy of `finch.d.ts`. Never
hard-code a path into the Finch repository source tree.

---

## 1  Minimum Viable Extension

A extension is a directory that contains at least:

```
my-extension/
├── package.json      ← must include a "finch" manifest block
├── tsconfig.json
└── src/
    └── index.ts      ← export function activate(ctx)
```

### `package.json`

```json
{
  "name": "my-extension",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch"
  },
  "finch": {
    "manifestVersion": 1,
    "id": "my-extension",
    "name": "My Extension",
    "description": "One-line description shown in the Toolbox UI.",
    "systemPrompt": "When the user asks to greet someone, prefer this extension's hello tool.",
    "promptGuides": [
      {
        "id": "hello",
        "title": "Try the hello tool",
        "prompt": "Use the hello extension to greet Ada."
      }
    ],
    "main": "dist/index.js",
    "activationEvents": ["onStartup"],
    "contributes": {
      "tools": true
    },
    "permissions": {
      "filesystem": "none",
      "network": false,
      "shell": false
    }
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

**Key manifest fields:**

| Field | Notes |
|---|---|
| `finch.id` | Globally unique, lowercase, hyphens only. Cannot change after install. |
| `finch.main` | Relative path to compiled entry (e.g. `dist/index.js`). |
| `finch.systemPrompt` | Optional one-sentence guidance injected when the extension is enabled. Use it to tell the model when/how to use this extension's tools. |
| `finch.promptGuides` | Optional prompt guide cards shown above README in the extension detail page. Clicking one fills HomeView Composer; prompts may include `/skill` tokens. |
| `finch.toolMeta.name` | Optional model-facing extension source label. Put the default string in manifest; localized copies go in `i18n/<locale>.json`. Defaults to the display name. |
| `activationEvents` | `["onStartup"]` is the only supported value for now. |
| `contributes.tools` | `true` = extension may register Agent tools. |
| `contributes.composerActions` | Array of button slot declarations (see § 4). |
| `permissions.filesystem` | `"none"` / `"readonly"` / `"readwrite"`. Start with `"none"`. |

---

## 1.1  Manifest i18n

**Recommended now: keep only default strings in `package.json#finch`, and put translations in `i18n/<locale>.json`.**

The runtime still accepts inline `LocalizedString` for backward compatibility, but new extensions should not add inline manifest i18n anymore.

### Recommended manifest shape

```json
{
  "finch": {
    "name": "File Helper",
    "description": "Manage local files",
    "systemPrompt": "When the user needs file management, prefer the File Helper extension.",
    "toolMeta": {
      "name": "File Helper"
    },
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

### External `i18n/<locale>.json` overrides

Keep translations in:

```text
my-extension/
├── i18n/
│   ├── zh-CN.json
│   └── en-US.json
└── package.json
```

Example `i18n/zh-CN.json`:

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

External i18n overrides the corresponding user-visible manifest fields for the active UI locale. It currently supports:

- `name` / `displayName`
- `description`
- `systemPrompt`
- `toolMeta.name`
- `promptGuides.<id>.title/description/prompt`
- `composerActions.<actionId>.tooltip`

Do **not** localize executable identifiers such as extension `id`, tool `name`, composer action `id`, command ids, capability names, MCP server names, or storage keys. Only localize user/model-facing text.

Inline `LocalizedString` is still accepted by the runtime for older extensions, but treat it as legacy compatibility rather than the preferred authoring style.

---

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "skipLibCheck": true,
    "types": [],
    "baseUrl": ".",
    "paths": {
      "finch": ["./node_modules/@finch/extension-api/finch.d.ts"]
    }
  },
  "include": ["src"]
}
```

The `paths` entry maps the `finch` type module to the `@finch/extension-api`
package's `finch.d.ts`. Install it as a dev dependency
(`"@finch/extension-api": "..."`),, or copy `reference/finch.d.ts` from this skill
into the extension and point `paths.finch` at the local copy. At runtime the
import is **type-only** (compiled away), so no Node module resolution is needed.
Never point `paths.finch` into the Finch desktop source tree.

### `src/index.ts`

```ts
import type * as finch from 'finch';   // types only — erased at compile time

export function activate(ctx: finch.ExtensionContext): void {
  ctx.logger.info('extension activated');

  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'hello',
      title: 'Hello',
      description: 'Say hello. Call when the user asks to greet someone.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Person to greet.' } },
        required: ['name'],
      },
      risk: 'low',
      async execute({ name }, exec) {
        exec.logger.info('greeting', name);
        return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
      },
    }),
  );
}

export function deactivate(): void {
  // optional cleanup
}
```

> **Pattern**: Push every `Disposable` returned by `ctx.tools.register()` /
> `ctx.composerActions.register()` into `ctx.subscriptions`. Finch calls
> `dispose()` on each entry when the extension is disabled or Finch shuts down.

---

## 2  The `finch.d.ts` API

The API reference is bundled with this skill at:

```
<this-skill>/reference/finch.d.ts
```

Read that file when implementing specific capabilities. It is self-documented
with JSDoc and examples. Key sections:

| Section | What it covers |
|---|---|
| `§ 0` Primitives | `Disposable`, `Event<T>`, `Uri`, `MarkdownString` |
| `§ 1` Lifecycle | `ExtensionContext` — the single entry point for all APIs |
| `§ 2` Session & Workspace | Read-only `SessionInfo`, `WorkspaceInfo` |
| `§ 3` `ctx.tools` | `ToolDefinition`, `ToolExecutionContext`, `ToolResult` |
| `§ 4` `ctx.composerActions` | `ComposerActionProvider`, `ComposerActionMenuItem` |
| `§ 5` `ctx.commands` | _(Phase 2, reserved)_ |
| `§ 6` `ctx.ui` | _(Phase 2, reserved)_ |
| `§ 6.5` `ctx.capabilities` | Extension-to-extension provide/get (§5.5 below) |
| `§ 6.5` `ctx.extensions` | Read other enabled extensions' manifest contribution snapshots (`listContributions`) |
| `§ 7` `ctx.storage` | Persistent KV store |
| `§ 7b` `ctx.settings` | Read-only user settings (manifest `settings` schema) |
| `§ 8` `ctx.secrets` | Read-only secrets declared in manifest |
| `§ 9` `ctx.logger` | Prefixed log output |
| `§ 10` `ExtensionManifest` | Full `package.json#finch` type |

**Quick reference — `ExtensionContext` shape:**

```ts
ctx.subscriptions     // Disposable[] — auto-cleaned on deactivate
ctx.extension         // { id, displayName, version, extensionPath, scope }
ctx.storagePath       // ~/.finch/extension-data/<id>/  (for raw file writes)

// Registration APIs
ctx.tools.register(def)                         // → Disposable
ctx.tools.registerSearchProvider(provider)      // → Disposable — dynamic tool discovery
ctx.composerActions.register(id, provider)      // → Disposable
ctx.commands.register(id, handler)              // → Disposable (Phase 2, reserved)

// Services
ctx.storage           // { get, set, delete, clear, keys }  — KV store
ctx.settings          // { get, all }          — user settings (manifest `settings` schema; reload on save)
ctx.secrets           // { get }               — read-only secrets
ctx.logger            // { debug, info, warn, error }
ctx.capabilities      // { provide, get, has, getVersion } — cross-extension collaboration (§5.5)
ctx.extensions        // { listContributions(point) } — read other extensions' manifest contributions (§5.6)
ctx.session           // { id, title, spaceId, cwd, model } — read-only snapshot of the active session
ctx.workspace         // { spaceId, spaceName, directoryPath, projectPath } — read-only snapshot of the active Space/workspace
```

> `ctx.session` / `ctx.workspace` are **snapshots**, not live-updating event
> emitters — there is no `onDidChangeSession`/`onDidChangeCwd` API. If your
> `getBadge`/`getMenu`/`execute` need the *current* cwd, read it from the
> `ComposerActionContext` argument passed to each call, not from a cached `ctx.session`.

---

## 3  Registering Agent Tools

Tools are called by the LLM during a conversation. The model sees the tool by
its plain `name` (e.g. `search_docs`) — the extension id is **not** prefixed onto
the model-facing name. Provenance (which extension owns the tool) is tracked
separately and shown in the UI as `ExtensionName·toolName`. So pick a `name` that
is clear on its own and unlikely to collide with other tools.

```ts
ctx.subscriptions.push(
  ctx.tools.register({
    name: 'search_docs',          // snake_case, unique within the extension
    title: 'Search Docs',         // shown in the permission card
    description:
      'Search the project documentation. Call when the user asks a question ' +
      'about the project docs or wants to find a specific section.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'number', description: 'Max results. Default 5.' },
      },
      required: ['query'],
    },
    risk: 'low',                  // 'low' | 'medium' | 'high'
    async execute(input, exec) {
      const { query, limit = 5 } = input as { query: string; limit?: number };
      const results = await searchDocs(query, limit, exec.cwd);
      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        isError: false,
      };
    },
  }),
);
```

**`ToolExecutionContext` (`exec`) properties:**

```ts
exec.toolCallId    // unique per call
exec.sessionId
exec.cwd           // effective working directory
exec.signal        // AbortSignal — check exec.signal?.aborted for cancellation
exec.logger        // ctx.logger shortcut, available inside execute()
exec.storage       // ctx.storage shortcut
exec.secrets       // ctx.secrets shortcut
exec.ui            // ToolUi — interactive forms during execution
```

**Collecting user input / secrets with `exec.ui.requestForm`:**
When a tool needs the user to enter values — especially API keys / tokens —
call `exec.ui.requestForm(spec)`. It pops a form in the waiting area (same outer
frame as AskUserQuestion cards) and resolves once the user submits/cancels.

```ts
const r = await exec.ui.requestForm({
  title: 'Connect service',
  description: 'Secrets stay on this machine and are never sent to the model.',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'apiKey', label: 'API Key', type: 'password', secret: true },
  ],
  timeoutMs: 120_000, // optional auto-cancel; omit to wait indefinitely
});
if (!r.submitted) return { content: [{ type: 'text', text: `Cancelled (${r.reason}).` }] };
// Persist r.values.apiKey via ctx.secrets / a local file.
// NEVER echo a `secret` field's value back into the returned ToolResult.
```

- Field types: `text` / `password` / `textarea` / `number` / `select` / `boolean`.
- `secret: true` → password input; the value is user-entered, the model never sees it.
- Non-submit results carry `reason`: `'cancelled' | 'timeout' | 'session-ended'`.
- The official **MCP Bridge** `MCP action=add/edit` dispatcher is a working reference.

**Writing good descriptions:**
The description is the sole signal the model uses to decide when to call the
tool. Be explicit about the trigger conditions, inputs, and what the model can
expect in the output.

---

## 4  Registering Composer Toolbar Buttons (ComposerActions)

Composer actions add buttons to the left side of the Composer input bar. Each
button can show a dynamic badge and a dropdown menu.

### Step 1 — Declare the slot in `package.json`

```json
"contributes": {
  "composerActions": [
    { "id": "my-btn", "icon": "Star", "tooltip": "My Button" }
  ]
}
```

`icon` is a [Lucide](https://lucide.dev/icons/) icon name (PascalCase).

### Step 2 — Bind a provider in `activate()`

```ts
ctx.subscriptions.push(
  ctx.composerActions.register('my-btn', {   // id must match manifest
    // Badge text on the button. Return undefined = icon only.
    // Throwing = button hidden (e.g. feature not applicable here).
    async getBadge({ cwd }) {
      return cwd ? 'active' : undefined;
    },

    // Dropdown menu items shown when the user clicks the button.
    async getMenu({ cwd }) {
      return [
        { id: 'action-a', label: 'Do A', iconName: 'Zap' },
        { id: 'action-b', label: 'Do B', separator: true },
        { id: 'action-c', label: 'Disabled', disabled: true },
      ];
    },

    // Called when the user selects a menu item.
    async execute({ cwd }, itemId) {
      if (itemId === 'action-a') await doA(cwd);
    },
  }),
);
```

**`ComposerActionMenuItem` fields:**

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Passed back to `execute()` |
| `label` | `string` | Displayed text |
| `description` | `string?` | Secondary text on the right |
| `iconName` | `string?` | Lucide icon name |
| `current` | `boolean?` | Shows a checkmark |
| `disabled` | `boolean?` | Greys out the item |
| `separator` | `boolean?` | Inserts a divider before this item |

**Visibility:** The button is queried with the effective `cwd`, which may be an
empty string in plain chat or a Space channel without a bound directory. If your
button does not need a working directory, return a badge (or `undefined`) so it
stays visible everywhere. Only **throw** from `getBadge` when the button is truly
not applicable (e.g. git-branch throwing when `cwd` is not a git repo).

---

## 4.5  Bundling Skills inside an Extension

An extension can ship Skills. Finch only surfaces them while the extension is enabled,
and removes them when it is disabled or uninstalled. Put each skill in its own
folder containing a `SKILL.md`, under either layout:

```
my-extension/
├── skills/                 # preferred
│   └── my-skill/
│       └── SKILL.md
└── .finch/skills/          # also supported (skill-creator's default)
    └── my-skill/
        └── SKILL.md
```

Declare `contributes.skills: true` in the manifest. Bundled skills are shown in
the extension detail panel and are searchable in the Composer skill picker for
every session — they are NOT copied into the global `~/.finch/skills/`.

---

## 5  Storage and Secrets

### KV Storage

```ts
await ctx.storage.set('lastRun', Date.now());
const t = await ctx.storage.get<number>('lastRun');
await ctx.storage.delete('lastRun');
```

Data persists in `~/.finch/extension-data/<id>/storage.json`.

### Secrets

Declare secret keys in the manifest, then read them at runtime:

```json
"permissions": { "secrets": ["MY_API_KEY"] }
```

```ts
const apiKey = await ctx.secrets.get('MY_API_KEY');
if (!apiKey) throw new Error('MY_API_KEY not configured');
```

Users set secret values in Finch Settings → Extensions → (your extension) → Secrets.

---

## 5.5  Capabilities — Extension-to-Extension Collaboration

An extension can **provide** a named capability (a set of async methods) that other
extensions **get** and call — without importing each other's code. This is how
official extensions expose shared services (e.g. the MCP bridge exposes
`mcp.client`).

Calls are routed across process boundaries through the main process, so **every
member is async** on the consumer side (returns a Promise).

**Gating (manifest):**

```json
// provider package.json#finch
"provides": { "capabilities": ["mcp.client"] }

// consumer package.json#finch
"requires": { "capabilities": ["mcp.client"] }
```

A extension can only `provide` names it declared in `provides.capabilities`, and
only `get` names it declared in `requires.capabilities`.

**Provider:**

```ts
ctx.subscriptions.push(
  ctx.capabilities.provide('mcp.client', {
    async listServers() { return [...servers.keys()]; },
    async callTool(server, name, args) { return run(server, name, args); },
  }),
);
```

**Consumer:**

```ts
interface McpClient {
  listServers(): Promise<string[]>;
  callTool(server: string, name: string, args: unknown): Promise<unknown>;
}

export async function activate(ctx: finch.ExtensionContext) {
  if (!ctx.capabilities.has('mcp.client')) return;          // provider not enabled
  const mcp = ctx.capabilities.get<McpClient>('mcp.client');
  ctx.tools.register({
    name: 'run_mcp',
    title: 'Run MCP tool',
    description: 'Call an MCP tool. Use when the user references an MCP server.',
    inputSchema: { type: 'object', properties: { server: { type: 'string' }, name: { type: 'string' } }, required: ['server', 'name'] },
    async execute({ server, name }) {
      const out = await mcp.callTool(server as string, name as string, {});
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  });
}
```

> The provider must be **enabled** for the capability to be available. Guard with
> `ctx.capabilities.has(name)` and degrade gracefully when it is missing.

---

## 5.6  Contributing MCP Servers

Besides tools and skills, an extension can contribute **MCP servers** declaratively.
Declare them in `contributes.mcpServers`; the MCP bridge extension reads enabled
extension contributions through `ctx.extensions.listContributions('mcpServers')`, then
connects each server and exposes its tools to the agent. No code needed in your
`activate()`.

```json
// package.json#finch
"contributes": {
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "description": "Local filesystem access",
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

- The MCP bridge extension (provides `mcp.client`) must be **installed and enabled**.
  Declare `requires.capabilities: ["mcp.client"]` so the extension detail view can
  prompt the user to install/enable it.
- Each contributed server keeps its declared runtime name, so tools are exposed
  as `mcp__<serverName>__<toolName>` (for example `mcp__filesystem__read_file`).
  Finch keeps an internal `<extensionId>.<serverName>` qualified key only for UI
  attribution and ownership; do not include the extension id in model-facing tool names.
- If the contributed MCP tools need shorter names, declare them in
  `mcpServers[].toolMeta.titles` inside the contributing extension.
- If they need inline input summaries, declare them in `mcpServers[].toolDisplay`.
  The MCP bridge should stay generic: it reads, connects, registers, and
  forwards metadata, but should not accumulate server-specific UI rules.
- Prefer short, stable inline fields such as `action`, `owner/repo`, `path`,
  `query`, `state`, or `perPage`. Do not surface secrets, tokens, or long freeform text.
- Extension enable/disable updates the host's generic contribution snapshot; the
  bridge refreshes its server set before list/search/status/tool calls.
- This is the declarative path. If you need to *drive* MCP servers from code,
  use the `mcp.client` capability (§5.5) instead.

---

## 6  Installing and Reloading During Development

### First install

1. `npm run build` in your extension directory (produces `dist/index.js`).
2. `npx @finch.app/extensions doctor .` — catch manifest/lint issues before installing.
3. `npx @finch.app/extensions add .` (personal tier) or `add . --global` — installs
   the built extension to the correct Finch-discoverable path. Prefer this over
   Finch's GUI "Install Extension" file picker: it is scriptable, it is the same
   path real users take, and `doctor`/`update` only work on CLI-tracked installs.
4. Finch → Toolcase → Extensions → find it in the list (still **disabled**) →
   review the requested permissions → **enable**.
5. Finch starts a dedicated ExtensionHost child process and calls your extension's `activate(ctx)` there.

### After code changes

Finch runs extensions in a dedicated ExtensionHost child process. Disabling an extension stops its host process; enabling it again starts a fresh host process and imports the latest compiled `dist/index.js`.

Faster dev loop:

```bash
# Terminal 1 — keep TypeScript watching
npm run dev          # tsc --watch

# Terminal 2 — after making code changes:
# 1. Save the file (tsc rebuilds dist/index.js automatically)
# 2a. If you only changed src/ logic: disable and re-enable the extension in
#     Finch Toolcase — it reimports the freshly rebuilt dist/index.js.
# 2b. If you also want the CLI-tracked install dir refreshed with the latest
#     dist/ (e.g. before testing an actual reinstall flow), re-run:
npx @finch.app/extensions update <id>
```

If you changed manifest fields (`package.json#finch`), install paths, or
bundled extension files copied by Finch at startup, restart Finch — manifest
changes are read once at scan time, not hot-reloaded.

### Checking activation errors

If the extension fails to activate, the Toolcase Extension list shows a red error
badge. Hover to read the error message. Common causes:

- **Syntax / runtime error in activate()** — fix the code and restart Finch.
- **`activate` not a named export** — must be `export function activate(ctx)`,
  not `export default`.
- **Missing dist/index.js** — run `npm run build` first. `doctor` also catches
  this (`entry file does not exist`).
- **Manifest `id` already taken** — pick a different `finch.id` in `package.json`.
- **Unsupported `manifestVersion`** — Finch rejects manifests declaring a
  `manifestVersion` newer than it supports instead of half-loading them; check
  the error text for the currently supported version and adjust the manifest.

---

## 6.5  Publishing an Extension

To make an extension installable by anyone via
`npx @finch.app/extensions add <name>`, publish it as a normal npm package:

1. Make sure `package.json#finch` is complete: `id`, `main`, `description`,
   `contributes`, `permissions`. Run `npx @finch.app/extensions doctor .` one
   more time — it is the same validation a user's install will implicitly rely on.
2. Set `private` to `false` (or omit it) and pick a public, scoped package name
   (e.g. `@you/finch-extension-foo`) so it doesn't collide with someone else's
   `finch.id`.
3. `npm publish` as you would any npm package. Do **not** publish `node_modules/`
   or `src/` if you can avoid it — only `dist/`, `package.json`, `i18n/`, and
   `skills/` are actually needed at runtime; use `"files"` in `package.json` to
   control what gets packed.
4. Tell users to install with `npx @finch.app/extensions add <your-package-name>`.
   They still have to review permissions and enable it manually in Finch — no
   install flow auto-enables a freshly-added extension.
5. For **official/community** extensions distributed through the Finch
   community catalog, coordinate with the `finch-releases` repo — the catalog
   is a separate index (`community/extensions.json`) that references your npm
   package by name; publishing to npm alone does not add you to the catalog.

---

## 7  Reading Logs

Extension logs are sent from the ExtensionHost child process back to the Electron **main process** console, prefixed with `[extension:<id>]` and `[extension-host:<id>]`.

| Environment | Where to see logs |
|---|---|
| **Dev mode** (`npm run dev` / Electron in terminal) | Terminal output where Finch was launched |
| **Production app** | Finch menu → **Help → Toggle Developer Tools** → Console tab (filter by `[extension:`) |

Inside your extension:

```ts
ctx.logger.debug('verbose data:', payload);  // not shown in production by default
ctx.logger.info('tool executed', toolName);
ctx.logger.warn('rate limit approaching');
ctx.logger.error('failed to connect', err);
```

Inside `execute()` you also have `exec.logger` (same underlying logger):

```ts
async execute(input, exec) {
  exec.logger.info('input received', input);
  // ...
}
```

---

## 8  Security and Runtime Isolation

Finch extensions run in a dedicated ExtensionHost child process, not directly inside the Electron main process.

Rules for extension authors:

- Do not import Finch internal source files, main-process services, renderer code, or Electron APIs.
- Use only `import type * as finch from 'finch'`; this is type-only and erased at compile time.
- Access Finch capabilities only through `ctx.*`.
- Declare requested permissions in `package.json#finch.permissions`.
- Treat Node built-ins (`node:fs`, `node:child_process`, network clients) as sensitive. Prefer Finch-provided APIs as they become available.

Current isolation level:

- ✅ Extension `activate()` / tool / composer action code runs outside the main process.
- ✅ ExtensionHost crashes do not directly crash the main process.
- ✅ Finch catches tool and composer action errors and surfaces/logs them safely.
- ⚠️ The host is still a Node child process, not a full OS sandbox. Future versions will add permission grants, brokered filesystem/network/shell APIs, and dangerous-import checks.

## 9  Quick Debug Checklist

| Symptom | Check |
|---|---|
| Tool not appearing in model context | Extension enabled? Activation error? `contributes.tools: true` in manifest? |
| Tool called but does nothing | Check logs for errors inside `execute()`. Return `{ isError: true }` on failure to signal the model. |
| Composer button not showing | `getBadge()` must not throw for the current cwd. Check for unhandled promise rejections. |
| Composer button shows but menu is empty | `getMenu()` returning `[]`? Log the cwd inside `getMenu()`. |
| Storage reads returning `undefined` | Check `ctx.storagePath` exists. Storage is per-extension and reset if the extension id changes. |
| Secret returns `undefined` | Key must be declared in `permissions.secrets` AND the user must have set a value in Settings. |
| Installed extension doesn't show up in Toolcase | Did you install to `<cwd>/.finch/extensions/`? That tier is not scanned for new extensions (§0) — reinstall to personal/global with `npx @finch.app/extensions add .` (no `--cwd`). |
| Extension shadowed by another install with the same id | `npx @finch.app/extensions list` and `list --global` to see both tiers; personal overrides global on id collision — remove or rename one. |
| Not sure if the manifest/source will pass Finch's checks | Run `npx @finch.app/extensions doctor <path>` before installing — it lints for legacy `FinchPluginAPI`, runtime `import ... from 'finch'`, and disallowed `electron`/Finch-internal imports. |

---

## 10  Example: hello-finch

See `<finch-repo>/examples/extensions/hello-finch/` for a complete, buildable
example that demonstrates all three common extension points in ~60 lines:
`ctx.tools.register()`, `ctx.composerActions.register()`, and a bundled skill
(`skills/hello-guide/SKILL.md`, gated by `contributes.skills: true`).

To use it as a starting point:
```bash
cp -r <finch-repo>/examples/extensions/hello-finch my-extension
cd my-extension
# Edit package.json: change finch.id, finch.name
# Edit src/index.ts: replace hello logic with your own
npm install
npm run build
npx @finch.app/extensions doctor .     # validate before installing
npx @finch.app/extensions add .        # install to the personal tier
```

Then open Finch → Toolcase → Extensions, review permissions, and enable it.

For a real-world Composer-action-only example (no Agent tools), the official
`git-branch` extension (published from the `finch-releases` repo) shows the
`getBadge`/`getMenu`/`execute` pattern end-to-end against a live `git` repo.
