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

> **Project-level `<cwd>/.finch/extensions/<id>/` has been removed entirely
> — it is not a tier at all anymore.** Do not scaffold or install extensions
> there; nothing scans that path. Older Finch builds treated it as a
> lowest-precedence dev-only fallback, but it turned out to be effectively
> dead code even then (it read a stale global "last project" pointer, not
> the active Space's directory) — so it was deleted from the scanner,
> service, CLI, and UI rather than kept around. Extensions only ever
> install to personal or global — always install through the CLI (§0.1) so
> extensions show up consistently across every Space.

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
- There is **no `--cwd` / project-scope flag** — project-tier install has been
  **removed entirely** from Finch (scanner, service, CLI, and UI no longer
  support it). Passing `--cwd` to the CLI throws and exits non-zero. Extensions
  only ever install to the personal (default) or `--global` tier (see §0).

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
  },
  "menu.open": "打开文件",
  "toast.opened": "已打开 {name}",
  "dialog.confirm.title": "确认操作"
}
```

External i18n overrides the corresponding user-visible manifest fields for the active UI locale. It supports:

- `name` / `displayName`
- `description`
- `systemPrompt`
- `toolMeta.name`
- `promptGuides.<id>.title/description/prompt`
- `composerActions.<actionId>.tooltip`

The same files also power runtime UI strings through `ctx.i18n.t(key, values)`. Prefer flat keys such as `menu.open` / `toast.opened`; nested objects are also resolved by dotted paths when possible. Finch loads `i18n/zh-CN.json`, `i18n/en-US.json`, and optional `i18n/default.json`, follows the app's active locale, falls back to the other supported locale/default, and returns the key itself if missing.

```ts
export function activate(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.composerActions.register('open-file', {
      async getMenu() {
        return [{ id: 'open', label: ctx.i18n.t('menu.open') }];
      },
      async execute(_ctx, itemId) {
        await ctx.ui.showToast({
          title: ctx.i18n.t('toast.opened', { name: itemId }),
          variant: 'success',
        });
      },
    }),
  );
}
```

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
| `§ 4` `ctx.composerActions` | `ComposerActionProvider`, `ComposerActionMenuItem`, `actions.fillComposer()` |
| `§ 5` `ctx.commands` | _(Phase 2, reserved)_ |
| `§ 6` `ctx.ui` | Toast notifications (`showToast`); Canvas Window (`createCanvasWindow`, §4.8); Webview Panel is reserved |
| `§ 6.5` `ctx.capabilities` | Extension-to-extension provide/get (§5.5 below) |
| `§ 6.5` `ctx.extensions` | Read other enabled extensions' manifest contribution snapshots (`listContributions`) |
| `§ 6.6` `ctx.i18n` | Runtime strings from this extension's `i18n/<locale>.json` (`t`, `has`, `onDidChangeLocale`) |
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

// UI
ctx.ui.showToast({ title, description, variant, position, action }) // → Promise<{ action }>; position TL/TC/TR/BL/BC/BR, default TC
ctx.ui.showConfirmDialog({ title, description, confirmLabel, cancelLabel, variant }) // → Promise<{ confirmed }>
ctx.ui.showModalDialog({ title, description, actions }) // → Promise<{ action }>
ctx.ui.showMessage(message, type)              // compatibility helper; maps to Toast
ctx.ui.createCanvasWindow({ entry, width, height, alwaysOnTop, transparent, clickThrough }) // → CanvasWindow (§4.8, transparent floating window)

// Services
ctx.storage           // { get, set, delete, clear, keys }  — KV store
ctx.settings          // { get, all }          — user settings (manifest `settings` schema; reload on save)
ctx.secrets           // { get }               — read-only secrets
ctx.logger            // { debug, info, warn, error }
ctx.capabilities      // { provide, get, has, getVersion } — cross-extension collaboration (§5.5)
ctx.extensions        // { listContributions(point) } — read other extensions' manifest contributions (§5.6)
ctx.i18n              // { locale, t, has, onDidChangeLocale } — runtime UI strings from i18n/<locale>.json
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
frame as AskUserQuestion cards) and resolves once the user submits/cancels. If
`timeoutMs` is set, Finch auto-cancels at the deadline and shows a countdown in
the card's bottom-left corner.

```ts
const r = await exec.ui.requestForm({
  title: 'Connect service',
  description: 'Secrets stay on this machine and are never sent to the model.',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    // Mixed-width row on a 6-track grid: 2/3 + 1/3 fills one row.
    { key: 'host', label: 'Host', type: 'text', width: '2/3' },
    { key: 'port', label: 'Port', type: 'number', width: '1/3' },
    { key: 'apiKey', label: 'API Key', type: 'password', secret: true },
    { key: 'note', label: 'Note', type: 'textarea' }, // always full-width
  ],
  timeoutMs: 120_000, // optional auto-cancel; omit to wait indefinitely
});
if (!r.submitted) return { content: [{ type: 'text', text: `Cancelled (${r.reason}).` }] };
// Persist r.values.apiKey via ctx.secrets / a local file.
// NEVER echo a `secret` field's value back into the returned ToolResult.
```

- Field types: `text` / `password` / `textarea` / `number` / `select` / `boolean`.
- Controls reuse Finch's own primitives (Input / TextArea / DropdownSelect / CheckBox), so extension forms match the app look.
- `secret: true` → password input; the value is user-entered, the model never sees it.
- **Side-by-side layout** — `width: '1/2' | '1/3' | '2/3' | 'full'` places fields on a 6-track grid that auto-wraps. Fields flow left-to-right in declaration order and a row fills when the fractions add up (e.g. `'2/3'+'1/3'`, `'1/2'+'1/2'`, `'1/3'×3`); anything that doesn't fit drops to the next row. Omit for full width. `textarea` always spans a full row.
- Non-submit results carry `reason`: `'cancelled' | 'timeout' | 'session-ended'`.
- `timeoutMs` shows a visible countdown and resolves with `reason: 'timeout'` when elapsed.
- The official **MCP Bridge** `MCP action=add/edit` dispatcher is a working reference.

**Writing good descriptions:**
The description is the sole signal the model uses to decide when to call the
tool. Be explicit about the trigger conditions, inputs, and what the model can
expect in the output.

---

## 4  Registering Composer Toolbar Buttons (ComposerActions)

Composer actions add buttons to the left side of the Composer input bar. Each
button can show a Lucide icon, a dynamic badge, and a dropdown menu.

### Step 1 — Declare the slot in `package.json`

```json
"contributes": {
  "composerActions": [
    { "id": "my-btn", "icon": "star", "tooltip": "My Button" }
  ]
}
```

`icon` is an **IconRef** (see §4.1). The simplest form is a Finch built-in
[Lucide](https://lucide.dev/icons/) name (kebab-case like `git-branch`, or
PascalCase like `GitBranch` — both resolve). The built-in set is fixed at app
build time. For anything outside that set, declare an `iconPacks` namespace in
manifest and register actual SVGs from code via `ctx.icons.register()` (§4.1).

### Step 2 — Bind a provider in `activate()`

```ts
ctx.subscriptions.push(
  ctx.composerActions.register('my-btn', {   // id must match manifest
    // Badge text on the button. Return undefined = icon only.
    // Throwing = button hidden (e.g. feature not applicable here).
    async getBadge({ cwd }) {
      return cwd ? 'active' : undefined;
    },

    // Optional dynamic toolbar icon (an IconRef). Return undefined to keep the manifest icon.
    async getIcon() {
      const last = await ctx.storage.get<string>('lastAction');
      return last === 'action-b' ? 'settings' : 'my-rocket'; // built-in name OR your own registered icon
    },

    // Dropdown menu items shown when the user clicks the button.
    // `iconName` is also an IconRef. Items support grouping + submenus (below).
    async getMenu({ cwd }) {
      return [
        // A titled, scrollable group: adjacent items sharing `group` render under
        // `groupLabel`; `groupMaxVisible` caps visible rows (rest scroll).
        { id: 'a', label: 'Do A', iconName: 'zap', group: 'actions', groupLabel: 'Actions', groupMaxVisible: 6 },
        { id: 'b', label: 'Do B', group: 'actions' },
        // Second group → separated + its own heading.
        { id: 'mode', label: 'Mode', group: 'settings', groupLabel: 'Settings',
          children: [ // hover to expand a submenu; clicking a child calls execute(childId)
            { id: 'mode-fast', label: 'Fast', current: true },
            { id: 'mode-think', label: 'Think' },
          ] },
        { id: 'c', label: 'Disabled', group: 'settings', disabled: true },
      ];
    },

    // Called when the user selects a menu item.
    // `actions.fillComposer()` writes text into the visible Home or Session Composer.
    // `/skill` directives and `@[path]` file mentions become rich tokens.
    async execute({ cwd }, itemId, actions) {
      if (itemId === 'action-a') await doA(cwd);
      if (itemId === 'action-b') {
        await actions.fillComposer('Draft inserted by my extension');
      }
      if (itemId === 'action-c') {
        await actions.fillComposer('/pdf 请总结 @[docs/report.pdf]');
      }
      if (itemId === 'action-d') {
        await actions.fillComposer('\nExtra line', { mode: 'append' });
      }
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
| `iconName` | `string?` | IconRef (built-in name or runtime icon pack / `ext:<packId>/<iconId>`) |
| `current` | `boolean?` | Shows a checkmark |
| `disabled` | `boolean?` | Greys out the item |
| `separator` | `boolean?` | Inserts a divider before this item |
| `group` | `string?` | Group key. Adjacent items sharing it render as one titled block |
| `groupLabel` | `string?` | Small heading for the group (from the group's first item) |
| `groupMaxVisible` | `number?` | Max rows before the group scrolls (from the group's first item) |
| `children` | `ComposerActionMenuItem[]?` | Hover-expanded submenu. The parent doesn't `execute`; clicking a child calls `execute(childId)` |

**Grouping & submenus:** Adjacent items with the same `group` are collected into
one block; the block shows `groupLabel` as a small heading and a separator above
it (like the model picker's 「模型」/「对话方式」 sections). Set `groupMaxVisible`
on the group's first item to cap its height — extra rows scroll inside a
ScrollArea. An item with a non-empty `children` array becomes a submenu trigger:
hovering opens the nested menu, and only a child selection reaches `execute` (by
the child's `id`). Keep same-`group` items contiguous in the array.

**Icons:** Every icon field (`icon` / `getIcon()` / `iconName`) is an **IconRef**
resolved by Finch's central icon registry (§4.1). The manifest `icon` is the
default toolbar icon; `getIcon(ctx)` can override it dynamically. Unresolvable
refs fall back to the default icon.

**Ordering & layout (no manual control):** Buttons are ordered deterministically
by `(extensionId, manifest declaration order)` — stable across restarts,
independent of activation timing. There is no per-button priority field. When the
Composer runs out of width, buttons automatically collapse to icon-only (the
badge label is hidden but stays in the tooltip), so keep icons meaningful on their
own. The toolbar also hot-updates: buttons appear/disappear as extensions
activate / are enabled / disabled, without needing a session switch.

**Visibility:** The button is queried with the effective `cwd`, which may be an
empty string in plain chat or a Space channel without a bound directory. If your
button does not need a working directory, return a badge / icon (or `undefined`)
so it stays visible everywhere. Throw from `getBadge` or `getIcon` only when the
button is truly not applicable (e.g. git-branch throwing when `cwd` is not a git
repo).

**Surface (Home vs Session):** Every `ComposerActionContext` carries
`surface: 'home' | 'session'` — `'home'` is the Home / new-chat screen (no live
session yet) and `'session'` is inside an open conversation. `getBadge`,
`getIcon`, `getMenu` and `execute` all receive it, so you can vary visibility or
menu contents per surface. Example — only show a button once a conversation is
open:

```ts
async getBadge({ cwd, surface }) {
  if (surface === 'home') throw new Error('hidden on home'); // hide on the Home screen
  return await currentStatus(cwd);
}
```

---

## 4.1  Icons & Custom Icon Contributions (IconRef)

Every place Finch shows an extension icon takes the same string type — an
**`IconRef`** — resolved by one central icon registry (same idea as VS Code's
`ThemeIcon`). Finch's built-in Lucide set is fixed at app build time. Extension
icons should be registered from code as a runtime SVG icon pack.

| Form | Example | Meaning |
|---|---|---|
| Built-in name | `"git-branch"` / `"GitBranch"` | Finch's bundled Lucide set (kebab or PascalCase both resolve) |
| Pack icon id | `"my-rocket"` | An icon registered by this extension's own icon pack |
| Current-pack ext ref | `"ext:my-rocket"` | Shorthand for this extension's own registered icon |
| Explicit ext ref | `"ext:my-icons/my-rocket"` | Fully-qualified reference to an icon pack |

**Recommended: register an icon pack from code**

Manifest only declares the icon pack namespace:

```json
"contributes": {
  "iconPacks": [
    { "id": "my-icons", "label": "My Icons" }
  ]
}
```

Then register actual SVGs in `activate()`:

```ts
import { readFileSync } from 'node:fs';

function icon(name: string) {
  return readFileSync(new URL(`../icons/${name}.svg`, import.meta.url), 'utf-8');
}

export function activate(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(ctx.icons.register('my-icons', {
    'my-rocket': { svg: icon('rocket'), description: 'Launch' },
  }));
}
```

Now reference `"my-rocket"`, `"ext:my-rocket"`, or the fully-qualified
`"ext:my-icons/my-rocket"` from any icon field (`composerActions[].icon`,
`getIcon()`, menu `iconName`). This also lets you build an iconlab in code:
import from an SVG library, normalize names, and register the final SVG strings.

**Compatibility:** older static `contributes.icons` file-path declarations still
work, but new extensions should prefer `iconPacks` + `ctx.icons.register()`.

**SVG rules (enforced by Finch's main-process sanitizer):**
- Register SVG strings only. The main process strips `<script>`, `<foreignObject>`,
  event handlers (`on*`), and external references (`http(s):`, protocol-relative,
  `file:`); only in-document `#id` refs survive.
- Explicit `stroke` / `fill` colors are normalized to `currentColor` so the icon
  inherits the surrounding text color (keep `fill="none"` for outline icons).
  Design a single-color, ~24×24 `viewBox` icon for best results.

> Icons are extensible everywhere: as Finch opens new icon entry points
> (sidebar entries, Space icons, …) they accept the same `IconRef`, so a
> registered icon works across all of them without further changes.

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

## 4.7  UI Toast Notifications

Use `ctx.ui.showToast()` for lightweight, non-blocking user feedback from activation code, tools, or composer actions.

```ts
const result = await ctx.ui.showToast({
  title: 'Saved',
  description: 'The extension settings were updated.',
  variant: 'success',       // 'default' | 'success' | 'info' | 'warning' | 'error' | 'promise'
  position: 'TC',           // TL | TC | TR | BL | BC | BR; default TC
  action: { label: 'Undo' }, // optional right-side button
});
if (result.action === 'action') {
  await undoLastChange();
}
```

Do not implement custom notification UI inside extensions for simple status messages. Let Finch manage Toast duration, stacking, and theme styling. If `action` is provided, `showToast()` resolves with `{ action: 'action' }` when the user clicks it, otherwise `{ action: 'dismissed' }`. `ctx.ui.showMessage(message, type)` is kept for compatibility and maps to Toast (`type` supports `info` / `warning` / `error`).

Use `ctx.ui.showConfirmDialog()` when a plugin needs an explicit yes/no decision. Use `description` for simple plain text, or `message` for Finch's lightweight structured text:

```ts
const { confirmed } = await ctx.ui.showConfirmDialog({
  title: 'Switch branch?',
  message: `The following files would be overwritten:\n\n\`packages/extension-api/finch.d.ts\` {+40}\\g {-0}\\r\n\`src/shared/types.ts\` {+18}\\g {-0}\\r\n\n> Commit or stash changes before continuing`,
  confirmLabel: 'Switch Branch…',
  cancelLabel: 'Cancel',
  variant: 'danger',
});
if (!confirmed) return;
```

Use `ctx.ui.showModalDialog()` for a short text dialog with custom actions:

```ts
const result = await ctx.ui.showModalDialog({
  title: 'Choose export format',
  message: `Pick the format to generate:\n\n\`report.json\` {+12}\\g {-0}\\r\n! Existing files may be overwritten`,
  actions: [
    { id: 'json', label: 'JSON', variant: 'primary' },
    { id: 'csv', label: 'CSV', variant: 'secondary' },
  ],
});
if (result.action === 'json') await exportJson();
```

Dialog content is text only; do not pass HTML. `message` supports only a tiny safe token set: blank lines for spacing, backticks for inline code, `{text}\\g` green, `{text}\\r` red, `{text}\\y` yellow, `{text}\\m` muted, `{text}\\a` accent, `{text}\\b` bold, `{text}\\i` italic, `> muted line`, and `! warning line`. Color tokens do not imply bold; use `\\b` explicitly when needed. `ctx.ui.createWebviewPanel()` is still reserved and throws in the current Finch version.

---

## 4.8  Canvas Windows (desktop pet / floating overlay)

`ctx.ui.createCanvasWindow(options)` opens a **transparent, frameless, draggable, optionally always-on-top floating window** — perfect for desktop pets, floating tools, or small desktop games. It is orthogonal to the reserved `createWebviewPanel` (which is an embedded panel): a Canvas Window is an independent top-level window.

**You do not write HTML.** You provide one **canvas script** (the `entry` path, relative to your extension dir). Finch owns the window shell (transparent surface, devicePixelRatio scaling, requestAnimationFrame loop, event dispatch, two-way messaging). Your script registers a lifecycle object via the injected global `finch.canvas.define(...)`. Phase 1 allows **one window per extension** — calling `createCanvasWindow` again replaces it.

An extension is **two pieces of code** (VS Code webview mental model):

- **Host 段** (`activate()`, runs in the plugin host): registers tools, controls the window lifecycle.
- **Canvas 段** (`entry` script, runs in Finch's canvas shell renderer): pure drawing + interaction.

They talk via `postMessage`.

**Host 段** — create and control the window:

```ts
import type * as finch from 'finch';

export function activate(ctx: finch.ExtensionContext) {
  let win: finch.CanvasWindow | undefined;

  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'pet_show', title: 'Show pet',
      description: 'Show the desktop pet.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        if (win) { win.show(); }
        else {
          win = ctx.ui.createCanvasWindow({ entry: 'pet-canvas.js', width: 220, height: 220, alwaysOnTop: true });
          win.onDidReceiveMessage((msg) => ctx.logger.info('pet →', msg));
          win.onDidDispose(() => { win = undefined; });
        }
        return { content: [{ type: 'text', text: 'Pet is out 🐤' }] };
      },
    }),
    { dispose: () => win?.dispose() }, // clean up on deactivate
  );
}
export function deactivate() {}
```

Host handle (`CanvasWindow`): `show()` / `hide()` / `setAlwaysOnTop(v)` / `setPosition(x,y)` / `setSize(w,h)` / `setClickThrough(v)` / `postMessage(msg)` / `dispose()`, plus events `onDidReceiveMessage` / `onDidMove` / `onDidResize` / `onDidDispose`.

**Canvas 段** — `pet-canvas.js` (plain JS, no imports, no bundler needed). Register via the injected `finch.canvas.define`:

```js
finch.canvas.define({
  init({ canvas, ctx2d, width, height, dpr, finch, initialData }) { this.c = ctx2d; this.w = width; this.h = height; this.t = 0; },
  frame(dt) {                                   // driven by requestAnimationFrame
    this.t += dt / 1000;
    this.c.clearRect(0, 0, this.w, this.h);
    const cy = this.h / 2 + Math.sin(this.t * 2) * 6;
    this.c.fillStyle = '#f7c948';
    this.c.beginPath(); this.c.ellipse(this.w / 2, cy, 58, 52, 0, 0, Math.PI * 2); this.c.fill();
  },
  resize(width, height) { this.w = width; this.h = height; },
  onPointer(e) {                                // { type:'move'|'down'|'up', x, y, button }
    if (e.type === 'down') finch.window.startDrag();  // press-drag the whole window
    if (e.type === 'up') finch.window.endDrag();
  },
  onMessage(msg) { /* from Host 段 postMessage */ },
  dispose() {},
});
```

Injected `finch` bridge inside the canvas script: `finch.postMessage(msg)`; `finch.window.startDrag()` / `endDrag()` / `setAlwaysOnTop(v)` / `setPosition(x,y)` / `setClickThrough(v)` / `close()`. Dragging a frameless window uses `startDrag()`/`endDrag()` around a pointer down/up (CSS `-webkit-app-region` is not used here because canvas needs pointer events).

Notes & limits:
- The canvas renderer is isolated: no Node, no arbitrary network. Only the audited `finch` bridge is exposed.
- `finch.input.beginText()` (a native text-input helper for IME-friendly quick-input boxes) is **reserved** and throws until a later Finch version.
- Status subscription (`ctx.status` / `ctx.notifications`) is planned; until then, push app state to the window yourself via `win.postMessage(...)`.
- Full working example: `examples/extensions/hello-pet/`.

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
| Composer button not showing | `getBadge()` / `getIcon()` must not throw for the current cwd. Check for unhandled promise rejections. |
| Composer icon falls back to default | The IconRef didn't resolve. Use a built-in Lucide name, or declare `contributes.iconPacks` and register SVGs with `ctx.icons.register()` (§4.1). |
| Registered SVG icon renders empty | The registered SVG string failed sanitization (script/external refs). Use a clean single-color 24×24 SVG. |
| Composer button shows but menu is empty | `getMenu()` returning `[]`? Log the cwd inside `getMenu()`. |
| `actions.fillComposer()` does nothing | The action must run from a visible Composer on Home or Session view; pass text as a string and use `mode: "replace"` or `"append"`. `/skill` and `@[path]` are parsed into rich tokens. |
| Form times out unexpectedly | Check `timeoutMs`; Finch displays the countdown and returns `reason: "timeout"` when it elapses. |
| Toast not showing | Use `ctx.ui.showToast({ title: '...', position: 'TC' })`; position must be `TL`/`TC`/`TR`/`BL`/`BC`/`BR`. Check extension host logs for bridge errors. |
| Toast action not firing | Await `ctx.ui.showToast({ ..., action: { label: 'Undo' } })` and handle `result.action === 'action'`. |
| Dialog not resolving | Await `ctx.ui.showConfirmDialog()` / `showModalDialog()` and ensure the renderer window is open; closing returns `confirmed:false` or `action:'dismissed'`. |
| Canvas window blank / never opens | Ensure the `entry` path is correct **relative to the extension dir** and the script calls `finch.canvas.define({...})`. Add `frame()` to draw each tick, or draw once in `init()`. Check extension host logs for "canvas entry script error". |
| Canvas window can't be dragged | Call `finch.window.startDrag()` on pointer `down` and `finch.window.endDrag()` on pointer `up` inside `onPointer`. Frameless canvas windows don't use CSS `-webkit-app-region`. |
| `finch.canvas.define` is undefined | The script runs only inside a Canvas Window shell created by `ctx.ui.createCanvasWindow`. It is not available in the Host 段 (`activate`) or in normal tools. |
| `ctx.i18n.t()` returns the key | Add the key to `i18n/<active-locale>.json`, `i18n/default.json`, or the fallback locale file. Check extension host logs for a one-time missing-key warning. |
| Locale switch does not update text | Runtime text must be produced with `ctx.i18n.t()` when `getMenu()`/toast/dialog/form is called, not cached at module load. Manifest text updates after Finch reloads the extension on locale change. |
| Storage reads returning `undefined` | Check `ctx.storagePath` exists. Storage is per-extension and reset if the extension id changes. |
| Secret returns `undefined` | Key must be declared in `permissions.secrets` AND the user must have set a value in Settings. |
| Installed extension doesn't show up in Toolcase | Did you install to `<cwd>/.finch/extensions/`? That tier is not scanned for new extensions (§0) — reinstall to personal/global with `npx @finch.app/extensions add .` (no `--cwd`). |
| Extension shadowed by another install with the same id | `npx @finch.app/extensions list` and `list --global` to see both tiers; personal overrides global on id collision — remove or rename one. |
| Not sure if the manifest/source will pass Finch's checks | Run `npx @finch.app/extensions doctor <path>` before installing — it lints for legacy `FinchPluginAPI`, runtime `import ... from 'finch'`, and disallowed `electron`/Finch-internal imports. |

---

Then open Finch → Toolcase → Extensions, review permissions, and enable it.

For a real-world Composer-action-only example (no Agent tools), the official
`git-branch` extension (published from the `finch-releases` repo) shows the
`getBadge`/`getMenu`/`execute` pattern end-to-end against a live `git` repo.
