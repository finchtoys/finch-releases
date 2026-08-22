---
name: finch-mini-tool-creator
description: >
  Guide for developing, debugging, installing, and publishing Finch mini tools
  (also shown in the app UI and to Chinese-speaking users as "Finch 小程序" /
  mini program — the same extension mechanism under a different display name).
  Invoke this skill whenever the user wants to create a new Finch mini tool or
  mini program (小程序), extend Finch with custom Agent tools or Composer
  toolbar buttons, understand the finch.d.ts API, debug an existing mini tool,
  install/deploy/update/remove a mini tool with the official
  `npx @finchtoys/minitools` CLI, publish a mini tool to npm/the community
  catalog, package a mini tool for distribution, list a mini tool on the
  official community, or submit a mini tool to finch-releases. Trigger on
  phrases like "write a finch mini tool", "create a finch mini tool", "创建
  Finch 小程序", "创建小工具", "add a tool to finch", "debug my mini tool",
  "mini tool not loading", "how do I make a composer button", "install this
  finch mini tool", "deploy/publish a finch mini tool", "package my mini
  tool", "publish to npm", "how to list on community", "submit to finch
  community", etc.
---

# Finch Mini Tool Creator

This skill is the entry point for creating Finch mini tools.

- **Product name:** mini tool. In the app UI and to Chinese-speaking users this same concept is now labeled "Finch 小程序" (mini program) — "小程序"/"mini program" and "mini tool"/"扩展" refer to the same extension mechanism, just different display names. Only the UI copy changed; the manifest fields, code, CLI commands, and directory names below are unchanged.
- **Install directory:** `extensions` (unchanged)
- **Tech/API surface:** use the published `@finchtoys/minitool-api` package for Finch APIs

Use this skill as an index first:

1. **Before writing any code**, complete the pre-flight checklist in **§0**.
2. Learn the basic rules in **§1 Quick Start**.
3. Read the tool design principles in **§2 Tool Design Principles** — this is mandatory, not optional.
4. Check the supported folder layout in **§3 Project Structure**.
5. Read the manifest and runtime rules in **§4 Core Rules**.
6. Use **References** for exact API signatures and field details.

---

## 0. Pre-flight — Read Before Coding

**Do not write any code until you have read every reference file that applies to your mini tool.**

Identify what your mini tool needs, then read the matching files:

| Feature | Must read |
|---|---|
| Agent tools | `reference/tools.md` |
| Composer toolbar buttons | `reference/composer-actions.md` **and** `reference/icons.md` |
| Custom icons | `reference/icons.md` — §2 built-in list first, then §3 SVG rules |
| Storage / secrets | `reference/finch.d.ts` → `Storage` / `Secrets` interfaces and `reference/ui.md`; `ctx.storage` is plaintext and credentials must use `ctx.secrets` |
| OAuth account linking | `reference/oauth.md` and `reference/finch.d.ts` → `OAuth` interfaces; standard providers use packaged PNG `OAuthProviderConfig.icon`, while advanced protocol authorization uses trusted `providerIcon` |
| Dialogs / images / Canvas | `reference/ui.md` §6 and `reference/finch.d.ts` → UI, `CanvasWindow` ready/state/visibility lifecycle, atomic `update()`, frame budget, dirty redraw, and Main motion interfaces |
| Right-panel Webview / host Session navigation / file or image annotations | `reference/ui.md` §7 and `reference/finch.d.ts` → `AppPanel`, `WebviewBridgeApi.navigation.openSession`, origin rules, Composer context drafts; static launcher entry via `contributes.appPanel` (see §4) |
| App View opening built-in preview/browser or another mini tool's App View | §4 "Navigation stack" bullet and `reference/finch.d.ts` → `WebviewBridgeApi.appView`, `AppViewContribution.embeddable` |
| Status snapshots | `reference/finch.d.ts` → `Status` interface |
| Bot / remote / Agent Session messaging / container settings menu | `reference/session.md` and `reference/finch.d.ts` → `SessionContainerSettingsMenuProvider` |
| MCP integration | `reference/mcp.md` |
| Publishing | `reference/publish.md`; for a request to list an already-published mini tool in the official community, use `AppCall action=feedback` with `feedbackCategory: "minitool"` — do not directly edit the community index. |

**ComposerAction icons are the most common failure point.** Before setting any `icon` field anywhere (manifest or code), open `reference/icons.md` and confirm the id is in the built-in list (§2). If it is not listed there, it will render as plain text — always register a runtime SVG pack instead of guessing. Do not skip this check.

---

## 1. Quick Start

A mini tool is an npm-style TypeScript package discovered from the file system. It can contribute Agent tools, Composer toolbar buttons, bundled Skills, and other Finch runtime capabilities through a single `MiniToolContext` (`ctx`) object. There is no `ExtensionContext` compatibility alias — `MiniToolContext` is the only name.

Minimum shape:

```
my-mini-tool/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

Core rules:

- Export `activate(ctx)` as a named export.
- Use `import type * as finch from '@finchtoys/minitool-api'` for types only.
- Push every `Disposable` into `ctx.subscriptions`.
- Keep runtime logic in `src/` and compile to `dist/`.
- Use `npx @finchtoys/minitools` for install/update/remove.
- For ComposerAction menus, every actionable item must include `iconName`: reuse a built-in Finch icon first; otherwise register a Lucide (or compatible library) SVG and use its `ext:` reference. See `reference/icons.md`.
- Register Agent tools as lowercase English `snake_case` names in the form `<mini_tool_name>_<function_name>`; never use short generic names such as `init`, `build`, or `status`. See `reference/tools.md`.
- Store credentials only with `ctx.secrets.set()` after declaring exact keys (or a trailing prefix such as `mcp.*`) in `permissions.secrets`; `ctx.storage` is plaintext. Read with `get()` and clear with `delete()`—never write secrets into config JSON.

If you only need the exact API signatures, skip ahead to **References**.

---

## 2. Tool Design Principles

This section is **mandatory reading** before registering any Agent tools. Ignoring these rules produces mini tools that are hard to use, waste model context, and break the tool-selection experience.

### 2.1 Register as few tools as possible

Every registered tool is injected into the model's context on every turn. Too many tools waste tokens and make the model less reliable at choosing the right one.

Rules:
- Register the minimum number of tools that covers the feature.
- If a set of operations shares the same subject and input context, put them in **one tool with an `action` parameter** rather than separate tools.
- If you genuinely need many tools (roughly 10+), expose them as a **local MCP server** so Finch loads them on demand. See `reference/mcp.md`.

### 2.2 Use an `action` parameter to unify related operations

When one logical capability has multiple operations (create / update / delete / list / publish …), model them as a single tool with a required `action` enum:

```ts
ctx.tools.register({
  name: 'pjblog_post',
  title: 'PJBlog Post',
  description: `Manage blog posts.
action:
  list    — list all posts (drafts and published)
  create  — create a new draft post
  update  — update the title, tags, or body of an existing post
  delete  — permanently delete a post
  publish — publish a draft post`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'update', 'delete', 'publish'],
      },
      slug:  { type: 'string', description: 'Post slug (required for update / delete / publish)' },
      title: { type: 'string', description: 'Post title (required for create)' },
      body:  { type: 'string', description: 'Post body in Markdown (optional for create / update)' },
    },
    required: ['action'],
  },
  risk: 'medium',
  async execute(input, exec) {
    switch (input.action) {
      case 'list': /* ... */
      case 'create': /* ... */
      // ...
    }
  },
});
```

**Always enumerate every available action in the `description` field.** This is the only way the model knows what it can do with the tool. One line per action, with a short explanation.

### 2.3 When to use a local MCP server instead

Choose a local MCP server when:
- The tool set is large and most tools are rarely used together.
- The feature wraps an external service that already has an MCP SDK.
- You want Finch to load tools on demand rather than upfront.

See `reference/mcp.md` for the full setup pattern.

### 2.4 Summary checklist before registering tools

- [ ] Is the total number of tools as small as possible?
- [ ] Are multi-operation features unified under one tool with `action`?
- [ ] Does every `action` value appear in the tool `description`?
- [ ] Does each tool name follow `<mini_tool_name>_<function_name>` (snake_case)?
- [ ] Did you read `reference/tools.md`?

---

## 3. Project Structure

Finch discovers mini tools from two supported tiers, checked in this order:

| Tier | Path | Use when |
|---|---|---|
| Personal | `<finchHome>/.finch/extensions/<id>/` | Default choice |
| Global | `~/.finch/extensions/<id>/` | Shared machine-wide install |

Notes:

- The installed directory is named after the runtime id. Do not hard-code or depend on that directory name in your package.
- **For every community mini tool, choose a stable, globally unique `package.json#name`; this is its identity.** Finch derives the runtime extension id at install time, rather than using `finch.id`: `finch-my-tool` → `finch-my-tool`, `@yourscope/finch-my-tool` → `yourscope@finch-my-tool`. Use a scoped npm package (`@your-scope/finch-…`) whenever possible, keep its name stable after publishing, and omit `finch.id` entirely. `finch.id` is only meaningful for Finch's directly copied bundled extensions. See `reference/publish.md` §2 for the compatibility and migration details.
- Project-level installs are not supported.
- Always install with the official CLI so the real path is used.

---

## 4. Core Rules

### Manifest

A minimal mini tool needs:

- `manifestVersion`
- optional `minVersion` when the mini tool depends on APIs introduced by a specific Finch release
- `name`
- `main`
- `activationEvents`
- `contributes`
- `permissions` when needed

`minVersion` declares the lowest Finch app version allowed to load the mini tool. Use one complete SemVer string such as `"1.6.0"`; do not use ranges such as `">=1.6.0"`. Omit it only when the mini tool genuinely works on every Finch release that understands its `manifestVersion`. Finch keeps incompatible mini tools visible in the Toolbox, but blocks activation and shows the required version. `manifestVersion` describes manifest schema compatibility; it does not replace `minVersion`.

For Composer toolbar buttons, declare `id`, `icon`, and short `tooltip` text in `contributes.composerActions`. Longer hover descriptions belong to `hoverText` on items returned by `getMenu()`, not to the manifest button declaration. Session containers may also declare `icon` with the same built-in or `ext:` SVG IconRef strategy; omitted icons fall back to `bot`. A settings menu's `icon` is a separate IconRef with its own fallback of `sliders-horizontal`.

A mini tool may expose **one unified settings menu**. Declare `contributes.settingsMenu` at the top level of `contributes`, then register it at runtime with `ctx.settingsMenu.register({ getMenu, execute })`. One declaration lights up **two surfaces**: the header actions of every session container this mini tool owns (beside the model picker in `inbox` mode, in the header action area in `assistant` mode), and the Toolcase — on the mini tool card left of the enable toggle, plus its detail page action row. `ctx.settingsMenu` receives `surface: 'container' | 'toolcase'` (with `containerId` only on the container surface) so `getMenu()` can vary rows per surface. Use `getMenu()` for rows and `execute()` for the selected row; `execute()` may call `ctx.ui.showModalDialog()` for account login or connection settings.

If the manifest also declares a top-level `settings` schema, Finch appends a built-in **Settings** row to the end of that menu, which opens the native settings form. A mini tool with only a `settings` schema and no `contributes.settingsMenu` still gets the button — clicking it opens the form directly instead of a one-row menu, and it keeps working while the mini tool is disabled.

Legacy: `contributes.sessionContainers[].settingsMenu` + `ctx.sessionContainers.registerSettingsMenu(containerId, provider)` still works, but it is **limited to that container's own header** — it never reaches the Toolcase. Do not use it in new mini tools; migrate to `ctx.settingsMenu.register()`. (Finch does promote a mini tool's *single* legacy container menu into the Toolcase so already-shipped mini tools are not left without an entry.)

### Panel App declaration (`contributes.appPanel`)

Declare the mini tool's unique Panel App with `contributes.appPanel`. One mini tool may declare **at most one** (no plural `appPanels`). This declaration is the single source of truth for the page, title, icon, toolbar, and default instance mode. The right Panel launcher, `ctx.ui.createPanel()`, Composer actions, and Delivery rows all open this same app:

```json
"contributes": {
  "appPanel": {
    "icon": "gauge",
    "viewType": "demo.dashboard",
    "instanceMode": "single",
    "showInLauncher": true,
    "source": { "type": "local", "path": "dist/dashboard.html" }
  }
}
```

- `source.type: "local"` — packaged page inside the mini tool. Finch serves it from the **platform static server** (`http://127.0.0.1:<port>/__finch_ext__/<extensionId>/...`), so the page gets a real http origin: ESM `<script type="module">` and `fetch()` both work. JS Bridge is injected by default. **Never use file:// URLs** — they are opaque origins where ESM/fetch are blocked.
- `source.type: "url"` — developer-hosted service or public page; Bridge is **not** injected. Inline `html` is not supported.
- `instanceMode: "single"` reuses the app in the current Panel scope; omit for `multiple`. Runtime code may override this policy and pass JSON opening context with `ctx.ui.createPanel({ instanceMode, payload })`.
- `showInLauncher` defaults to `true` and controls both the right Panel `+` menu and Welcome page. Set it to `false` for apps opened only by runtime code or Delivery; the declaration remains available to `createPanel()` and Delivery clicks.
- `title` is **optional** — omit it (recommended) and Finch shows the mini tool's own `name`/`displayName` here, same as everywhere else the mini tool is listed. Only set it when this Panel App genuinely needs a different label than the mini tool itself, and if you do, supply the same language overrides via `i18n/<locale>.json` → `appPanel.title`. See "Entry naming consistency" in `docs/minitool-app-view.md` — this applies to `appView.title` too, and the two should not silently diverge.
- **Theme adaptation without FinchUI:** ahead of a full component kit, every eligible page (packaged `local` always; `url` only when it already qualifies for the Bridge) automatically gets Finch's resolved theme as `--finch-*` CSS variables (`--finch-bg-root`, `--finch-text-primary`, `--finch-accent`, `--finch-border`, `--finch-radius-md`, `--finch-shadow-sm`, `--finch-font-body`, …, plus `--finch-theme-mode`: `'light'`/`'dark'`) — pure CSS, no Bridge message needed, re-injected automatically whenever the user's theme/skin changes. See `AppPanelThemeVar` in `reference/finch.d.ts` for the full list; just reference them directly, e.g. `body { background: var(--finch-bg-main); color: var(--finch-text-primary); }`.
  - **Use light/dark-aware standalone fallbacks:** Finch keeps an embedded page hidden until its first `dom-ready` theme injection settles, so a hardcoded light fallback can no longer flash through inside Finch. Still wrap fallback colors in `@media (prefers-color-scheme: dark)` so the packaged page also looks correct when opened directly in a browser, and as defense in depth for older Finch versions. See `examples/extensions/webview-panel-lab/src/panel.html` for the pattern: define intermediate custom properties like `--df-bg-root: var(--finch-bg-root, <light>)` at `:root`, then override the same names with dark literals inside the media query.
- `toolbar` (optional): a static `AppPanelToolbarItem[]` for the panel's **own toolbar row**, rendered directly under the tab bar for as long as this panel is active — not tucked behind a dropdown, mirroring the built-in Browser panel's own address/action bar. Mix plain buttons, a `type: 'menu'` button that opens its own dropdown (`items: AppPanelMenuItem[]`), a `type: 'separator'` divider, and a `type: 'spacer'` flexible blank that pushes everything after it to the trailing edge:
  ```json
  "toolbar": [
    { "id": "reload", "icon": "rotate-cw", "tooltip": "Reload" },
    { "type": "separator" },
    { "id": "share", "label": "Share", "icon": "share-2" },
    { "type": "spacer" },
    { "type": "menu", "id": "more", "icon": "ellipsis", "items": [
      { "id": "clear-log", "label": "Clear log" },
      { "id": "sep", "label": "", "separator": true },
      { "id": "about", "label": "About", "icon": "sparkles" }
    ] }
  ]
  ```
  Every click (a top-level button or dropdown row) is sent directly to the page as `{ type: 'finch:menu', itemId }`; listen with `window.finch.onMessage`. The page may update its tab with `window.finch.panel.setTitle()` and `setIcon()`.
- The app opens in the current Panel scope: a Session, Home, session container, or another Panel-capable view. `ctx.ui.createPanel()` therefore does not require an active Session. `window.finch.composer.addContexts()` works on `'session'` scope (writes into that Session's draft) and `'home'` scope (writes into the current Space's Home Composer draft) — it only rejects on `'container'` scope or an unrecognized scope, neither of which has a Composer draft to attach into. Check `finch:env`'s `view` field before calling it if the behavior needs to differ. Native `ui.toast()`/`ui.confirm()` and tab title/icon updates work in every scope. Finch automatically sends `{ type: 'finch:env', cwd, sessionId, view, spaceId, spaceName, payload }`; `sessionId` is empty outside a real Agent Session, `view` is `'session' | 'home' | 'container' | ''`, and `spaceId`/`spaceName` are empty strings when the scope has no active Space (same value backend code already gets via `ctx`'s workspace context — now exposed to the page itself, no round trip needed). The payload is retained with the Session's Panel tab and delivered again when Finch recreates the page.
- `ctx.ui.onDidOpenPanel(listener)` receives each live Panel App instance opened by the launcher, ComposerAction, Delivery, or `createPanel()`. Use it to attach `panel.onDidReceiveMessage()` once per `panel.id`; subscribing also replays currently live instances, and frontend disposal unregisters the Host handle. Handles returned by `createPanel()` remain directly usable and expose the current opening context as `panel.payload`. The handle also carries `panel.sessionId` / `panel.view` / `panel.spaceId` / `panel.spaceName` — the same classification the page gets via `finch:env`, but available to backend code immediately on open, so `onDidOpenPanel` can record/log which Session opened the panel without waiting on a page round trip (see `examples/extensions/webview-panel-lab` for a demo that persists these into `ctx.storage` and offers a ComposerAction menu to jump back to a recorded Session via `ctx.navigation.openSession`).
- `ctx.ui.delivery.set()` contributes the Session's one Delivery row. Its optional JSON `payload` is forwarded when the row opens this declared Panel App; there is no separate `targetPanelViewType`.

**Icon rule (mandatory):** Before setting the `icon` field, read `reference/icons.md` §2 and confirm the id appears in the built-in table. If it does not, register a runtime SVG pack (§3) and use `ext:<iconId>` for an icon in your own mini tool; Finch expands it to the correct fully-qualified pack id. Only cross-mini-tool references need `ext:<packId>/<iconId>`. An unrecognised bare id silently renders as plain text — there is no warning.

**Manifest i18n rule (mandatory):** AI-generated and hand-authored manifests must use plain English strings as defaults for every user-visible field. Never embed `LocalizedString` language maps in a manifest. Put all localized copy in `i18n/<locale>.json`, using stable IDs, keys, option values, or documented array indexes to override the default. Every new user-visible manifest field must ship with a corresponding i18n override design; inline localization is not an acceptable fallback.

### App View declaration (`contributes.appView`)

Use `contributes.appView` when a mini tool needs a persistent, application-level workspace rather than a right-side Panel tab. Finch adds the entry immediately above Toolcase in the left sidebar and opens it as a full route with the native navigation header.

```json
"contributes": {
  "appView": {
    "icon": "square-terminal",
    "source": { "type": "local", "path": "dist/dashboard.html" }
  }
}
```

- One mini tool may declare at most one `appView`. It is application-level and single-instance by extension id; it has no `viewType`, `instanceMode`, `showInLauncher`, or manifest toolbar.
- Packaged `local` pages use the same static server, isolated Webview partition, and `--finch-*` theme CSS variables as Panel Apps. Public `url` pages are allowed but never receive the Bridge.
- An App View is not an active Panel scope. Do not call `ctx.ui.createPanel()` to open it — but `ctx.ui.onDidOpenPanel()` *does* fire for it, adopted the moment the user opens the App View, with `panel.view === 'appView'` and `panel.sessionId`/`spaceId`/`spaceName` always `undefined`. It is application-level and single-instance by extension id, so re-opening it re-adopts the same `panel.id`.
- The page can use user-gesture-gated `window.finch.ui.toast()`, `window.finch.ui.confirm()`, `window.finch.capture.capturePage()`, and `window.finch.navigation.openSession(sessionId)` (pure renderer-side, no backend involved). `openSession()` performs host-owned navigation in the current Finch window; never render a raw `<a href="finch://open?...">` inside a guest page, because letting the webview load a custom protocol can blank it and handing the link to the OS can activate a different window. The page also gets the reserved `{ type: 'finch:env', view: 'appView', cwd, sessionId: '', spaceId: '', spaceName: '', locale }` bridge message automatically on load — `cwd` is always the app's default/free workspace, never whichever Space happens to be active, and there is no bound Session/Space. It **can** use `window.finch.postMessage()` / `onMessage()` — routed to whatever backend listener attached `panel.onDidReceiveMessage()` via `ctx.ui.onDidOpenPanel()` for this instance, same channel a Panel App tab uses. It cannot use `window.finch.composer.addContexts()` (no Composer draft to attach into), Panel toolbar messages (`appView` has no `toolbar` field yet), or Delivery targeting.
- The page can call `window.finch.panel.setTitle()` / `setIcon()` — same calls a Panel App tab uses — to update the leading `{icon} {title}` segment of the App View's own `小程序 > {icon} {title}` breadcrumb header. This is purely local display state, independent of the adopted `AppPanel` handle's backend `title`/`icon`; it resets to the manifest-declared `appView.title`/`icon` on every reload or navigation away and back. Clicking the breadcrumb's leading `小程序` segment does **not** leave this App View — it forces the `<webview>` back to this same mini tool's own entry page (`appView.source`), discarding any in-page navigation the page had drifted into, and resets this same local title/icon override.
- `title` is **optional** — omit it (recommended) so this entry inherits the mini tool's own `name`/`displayName`, matching `appPanel` and every other place the mini tool is listed. If you do set it, override per-locale via `i18n/<locale>.json` → `appView.title`, and keep it in sync with any `appPanel.title` override — see "Entry naming consistency" in `docs/minitool-app-view.md`. Follow the icon rule below before choosing `icon`.
- `description` is **optional** — a longer sentence shown as the sidebar entry's tooltip. Without it, the tooltip just falls back to the mini tool's own name. Override per-locale via `i18n/<locale>.json` → `appView.description`.
- **Navigation stack** — an App View page can push a child level onto its own breadcrumb via `window.finch.appView`: `openPreview(path)` / `openBrowser(url)` push Finch's built-in file preview / browser panel (no manifest declaration needed, always allowed), while `openApp(extensionId)` pushes *another* mini tool's own `contributes.appView` page — that target must set `"appView": { "embeddable": true, ... }` in its own manifest, or the call rejects; default is not embeddable. The breadcrumb becomes `小程序 > 交付 > 文件预览（report.md）> ...`; clicking any earlier breadcrumb segment closes everything to its right (including the current level) and returns to that level — this is the only way back, there is no separate "close" call. The stack has a bounded depth (currently 3 pushed levels) and rejects re-opening a mini tool already on the current stack path (anti-cycle). Nothing is kept alive across a pop: a closed level is destroyed and reloads fresh if reopened. See `docs/panel-app-navigation-stack.md` in the Finch repo for the full design.

### API access

All runtime capabilities go through `ctx`:

- `ctx.tools` — Agent tools; each `execute(input, exec)` call can use `exec.progress.report(...)` for live long-task progress. For `ToolContent.image`, return raw base64 in `data` plus a separate `mimeType`; never include a `data:image/...;base64,` prefix.
- `ctx.composerActions` — Composer toolbar contributions. The callback argument's `actions.navigation` remains for compatibility but is deprecated; capture `ctx` during `activate()` and use `ctx.navigation` instead.
- `ctx.navigation.openSession(sessionId)` — host-owned navigation to an existing Session in the current Finch window. This is the canonical backend API; Webview pages use the same namespace as `window.finch.navigation.openSession(sessionId)`.
- `ctx.browser.open(url)` — opens a new `http:`/`https:` URL in Finch's built-in Browser Panel within the current Panel scope; it never invokes the system external browser.
- `ctx.ui` — native Finch dialogs, Canvas windows, native file previews, and Panel Apps. Use `ctx.ui.openFilePreview(absolutePath)` to show Markdown, source code, or other previewable text in Finch's existing Panel UI; it needs an active Panel scope but no `appPanel`, and it never returns file content to the mini tool. Declare the mini tool's one embedded app with `contributes.appPanel`; Finch serves packaged `local` pages from its static server so ESM/fetch work, while public `url` pages never receive the Bridge. Open that declaration with `createPanel({ instanceMode })`; `single` reuses one instance in the current Panel scope and `multiple` opens independently. Finch automatically sends `{ type: 'finch:env', cwd, sessionId }`; do not reuse `finch:` for business messages. Manifest toolbar clicks arrive at the page as `finch:menu`, and the page controls its tab title/icon through `window.finch.panel`. Bridge Composer writes require a page user gesture and only add removable draft contexts. Await `CanvasWindow.ready`, observe `state`/`visible` rather than guessing lifecycle, and use atomic `update()` for mode changes. Canvas continuous animation defaults to 30 FPS; use `render()` + `finch.canvas.invalidate()` for static/event-driven content, cap high-DPI pixels with `maxDevicePixelRatio`, and use `CanvasWindow.startMotion()` instead of frame-by-frame `setPosition()`. `showModalDialog().message` supports standalone `![alt](src)` images for UI-only previews such as QR codes; use HTTPS or supported base64 image data URLs, never `ToolContent.image`, when the image is only for the user. The returned Modal handle remains awaitable and adds `close(action?)`, so background success can close the visible dialog and resolve the same action path.
  - **Two ways to collect manual text/token input, same field grid, different lifetime.** Both use the identical `MiniToolFormField[]` shape (`text`/`password`/`textarea`/`number`/`select`/`boolean`/`link`, with `required`/`secret`/`width`/`default`/`options`), so pick based on *when* you need the input, not how to render it:
    - `exec.ui.requestForm(spec)` (only inside a tool's `execute(input, exec)`) — pops a form card in the Composer waiting area. Tied to the running tool call; only appears while the Agent is mid-turn and actually invoked your tool. Good for "the model needs one more piece of info to finish this tool call".
    - `ctx.ui.showModalDialog({ ..., fields })` (available anywhere off `MiniToolContext.ui` — ComposerAction handlers, `sessionContainers` settings-menu `execute()`, even `activate()`) — pops a native modal with the same fields plus your own `actions` buttons. **No tool call or Agent turn required.** This is the right choice for "user clicks a settings button and manually types an API key/token" — it never depends on the AI deciding to call a tool. When `fields` is set, the first `variant: 'primary'` action is disabled until required fields are filled, and the resolved `ModalDialogResult.values` carries what the user typed.
  - Example — a settings-menu "Configure API Key" action that never touches the Agent:
    ```ts
    const result = await ctx.ui.showModalDialog({
      title: 'Configure API Key',
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'save', label: 'Save', variant: 'primary' }],
      fields: [{ key: 'apiKey', label: 'API Key', type: 'password', secret: true, required: true }],
    });
    if (result.action === 'save') await ctx.secrets.set('apiKey', String(result.values?.apiKey ?? ''));
    ```
- `ctx.storage` — plaintext JSON for ordinary extension state only; never store API keys, tokens, passwords, or credentials here
- `ctx.secrets` — manifest-authorized `get/set/delete` backed by Keychain, DPAPI, Secret Service, or KWallet; declare exact keys or a trailing wildcard in `permissions.secrets`
- `ctx.oauth` — isolated Authorization Code + PKCE or Device Flow login and brokered authorized requests. Standard providers ship a packaged PNG through `OAuthProviderConfig.icon`; advanced `initiateAuthorization()` protocol flows use their separate trusted `providerIcon` URL. Users only complete login, and raw tokens are never exposed
- `ctx.logger`
- `ctx.app` — read Finch app info such as version/build/platform/assistantName (user-customized assistant name, e.g. "帕亚"; use it to personalize tool output)
- `ctx.status` — aggregated runtime status, including latest current unread session metadata
- `ctx.sessions` — owner-scoped Session creation, reliable FIFO text/file `send()`, live response events, cursor recovery, and race-safe `waitForTurn()` for one exact terminal result without sleep/polling. Use `onDidReceiveEvent()` for long-lived observation, `waitForTurn()` for request/response orchestration, and `listEvents()` for history/recovery. Background Sessions default to `acceptCalls`, interactive Sessions to `ask`, and `create()` may explicitly choose either; requires `permissions.sessions`. `create()` picks one of three placements: `containerId` (must match a declared `contributes.sessionContainers` id), `space: { spaceId }` (a normal Space conversation, resolved via `ctx.spaces.list()` — see next bullet), or neither for a plain chat Session (same as a user-created "New Chat", still owned by your mini tool); `containerId` and `space` are mutually exclusive. Container titles/descriptions and `starterPrompts` cards support `LocalizedString`; the container home shows at most four cards and sends the selected card's `prompt` in a new container Session. Background container Sessions use a quiet red-dot reminder instead of system notifications. Users may choose a default model per container; Finch applies it automatically to future `create({ containerId })` calls and falls back to the global default when unset or unavailable. To give a container's Sessions a persona, declare `contributes.agentProfiles[]` and point that container's `agentProfile` at the profile id — required in `assistant` mode, optional but usually wanted in `inbox` mode. The binding is per **container**, so every Session created there carries it automatically (both the Finch UI's "New chat" entry and your own `create({ containerId })`); never pass the deprecated `create({ profileId })`, which is ignored. Sessions created into a `space`, and ordinary user conversations, never carry a profile. When a Session stops mid-turn on a permission / question / form card, the owner receives `turn.waiting` with a full `wait` snapshot and a `requestId`, and `turn.wait_resolved` when it settles; `listWaits()` / `waitForWait()` (covered by `permissions.sessions`) read what is blocking, and `respondToWait()` answers it — that one call additionally requires `permissions.sessionInteractions`. Relay the question to your real user and pass the answer directly to the existing card instead of creating a new turn. Destructive permissions may be rejected programmatically so work can continue, but only a human in Finch may approve them. Delegated answers never write `remember`; a human answering first yields `stale`, and background Sessions never produce waits at all.
- `ctx.spaces` — read-only Space directory (`list()` → `{ id, name, alias?, directoryPath? }[]`), gated by the same `permissions.sessions` as `ctx.sessions`. Use it to discover a `spaceId`/name before calling `ctx.sessions.create({ space: { spaceId } })`, without needing to already be running inside that Space. The same data is available to a static `appPanel` page with no backend tool call via the JS Bridge: `window.finch.spaces.list()`.
- `ctx.settingsMenu` — the mini tool's one unified settings menu, rendered in container headers **and** in Toolcase. The manifest must declare `contributes.settingsMenu`; call `register({ getMenu, execute })` once and push its handle to `ctx.subscriptions`. The static declaration reserves the button (an empty or failed `getMenu()` never hides it); Finch calls `getMenu()` every time it opens, passing `surface` and, on containers, `containerId`. Return status rows and clickable actions as separate items (for example disabled “Status · Signed out” plus actionable “Sign in”), use `ctx.ui.showModalDialog()` from `execute()`, and call the handle's `notifyUpdate()` when background login state changes.
- `ctx.sessionContainers` — **deprecated.** `registerSettingsMenu(containerId, { getMenu, execute })` only renders inside that one container's header. Kept working for already-shipped mini tools; new mini tools use `ctx.settingsMenu.register()` instead.
- `ctx.i18n` — put localized runtime copy in `i18n/<locale>.json` (`zh-CN`, `zh-HK`, or `en-US`) and read it with `ctx.i18n.t()`. Keep the manifest in one default language; locale files override `name`, `description`, `systemPrompt`, `promptGuides`, Composer action tooltips, `sessionContainers` (including `starterPrompts` by index), `agentProfiles`, and `settings.fields` by stable `key`. Settings overrides also support select option labels and list `itemFields`.
- `ctx.capabilities` — cross-extension collaboration; see `reference/capabilities.md`
- `ctx.minitool` — this mini tool's own metadata (`id` / `displayName` / `version` / `scope` …). The old `ctx.extension` is deprecated — use `ctx.minitool` in new code.
- `ctx.minitools` — snapshot of enabled mini tools' manifest contributions (`listContributions(point)`). The old `ctx.extensions` is deprecated — use `ctx.minitools` in new code.

### Install and debug

Recommended flow:

1. Build the mini tool.
2. Run `npx @finchtoys/minitools doctor .`; it rejects malformed `minVersion` values. Desktop Finch performs the authoritative current-app compatibility check.
3. Install with `npx @finchtoys/minitools add .`.
4. Enable it in Finch.
5. Check logs if activation fails.

Panel App / App View debug checklist:

- Use `ctx.ui.openFilePreview(absolutePath)` for Markdown, source code, and other text previews. It opens Finch's native preview, does not require `contributes.appPanel`, never exposes file content to the mini tool, and rejects relative paths or calls without an active Panel scope.
- Declare exactly one valid `contributes.appPanel` when you need a right-side Panel; `ctx.ui.createPanel()` only opens that declaration and works in Session, Home, and other active Panel scopes.
- Declare exactly one valid `contributes.appView` for an application-level sidebar entry. It has no Composer scope, tab toolbar, or Delivery integration — but it does support `window.finch.panel.setTitle()` / `setIcon()` for its own breadcrumb header (purely local page state), and `ctx.ui.onDidOpenPanel()` + `window.finch.postMessage()`/`onMessage()` work the same as a Panel App tab.
- Use `source.type: 'local'` for packaged UI and keep the path below the mini tool root. Finch serves it from the platform static server, never `file://`. Public `url` sources do not receive the Bridge; inline HTML is unsupported.
- Verify toolbar actions in the page's `window.finch.onMessage` handler for `finch:menu`. Update the current tab through `window.finch.panel.setTitle()` / `setIcon()`.
- Environment arrives through `finch:env`; for a Panel App tab, `sessionId` is empty outside a real Agent Session and `spaceId`/`spaceName` are empty outside an active Space — the `AppPanel` handle from `ctx.ui.createPanel()`/`onDidOpenPanel` already carries all four so backend code doesn't need to wait for it. For an App View, `view` is always `'appView'` and `sessionId`/`spaceId`/`spaceName` are always empty; `cwd` is always the app's default/free workspace regardless of the active Space.
- Add Composer contexts only from a click or other real user gesture; never auto-submit on page load.
- Push runtime panel handles into `ctx.subscriptions`, stop expensive work while hidden, and test disable/uninstall disposal.
- File ranges are 1-based; image regions use normalized `0..1` coordinates.

Canvas debug checklist:

- Hidden Canvas windows must stop business frames; do not add a separate timer that defeats lifecycle pausing.
- Static content should use `render()` + `finch.canvas.invalidate()`, not an always-running `frame()`.
- Keep the window close to visible content and set `maxDevicePixelRatio` deliberately for large/high-DPI surfaces.
- Continuous native movement uses `startMotion()` / `stopMotion()`; do not loop `setPosition()` from PluginHost.
- Never allocate images, gradients, `Path2D`, large arrays, or text layout inside a hot `frame()` callback.

Secret-storage debug checklist:

- A password field with `secret: true` protects the form/model boundary only; it does not persist or encrypt the value.
- Every key passed to `ctx.secrets` must match `permissions.secrets` exactly or through a trailing wildcard such as `service.*`.
- Search generated `storage.json`, settings files, logs, and tool results to confirm no credential value appears in plaintext.
- When migrating an old `ctx.storage` credential, write it to `ctx.secrets` successfully before deleting the old storage field.
- Never fall back to `ctx.storage` when system secure storage is unavailable; report setup failure instead.

For long-running tools, verify progress and timeout behavior before publishing:

- Set `progressMode: 'indeterminate'` on a tool only when it should show an initial indeterminate bar before it can report progress. Do not set it on ordinary tools.
- `exec.progress.report({ message: 'Working…' })` renders indeterminate progress.
- `exec.progress.report({ message: 'Working…', percent: 35 })` renders determinate progress.
- `exec.progress.report({ message: 'Generating…', kind: 'image', image: { resolution: [1024, 1024] } })` renders the dedicated image-generation visual (animated canvas + shimmering label) instead of the default progress bar — use it for image/video generation tools; `image.resolution` is an optional `[width, height]` tuple shown as a badge and used to size the canvas itself (scaled to roughly the same area as the square case, so a landscape/portrait resolution renders a proportionally wider/taller canvas — matching the aicss.dev reference's own per-instance sizing), so pass the actual pixel size your model will generate rather than a fixed `[1, 1]`.
- The tool still returns one final `ToolResult`; progress updates are not results.
- A tool call is cut off after **2 minutes** unless the tool declares `timeoutMs`. Image/video generation, remote job polling, and other slow work must set it explicitly, e.g. `timeoutMs: 300000`. Finch clamps the value to 15 s – 10 min; a tool parameter such as `timeout_seconds` in `inputSchema` does NOT change the platform timeout — only `timeoutMs` on the tool definition does.
- Prefer the **hybrid pattern** over blocking for the whole window: wait synchronously for a short period (60–100 s), and if the job is still running, return its task id and tell the model to query it later with a separate `status`/`check` action. Blocking the full timeout freezes the turn and leaves the user with no output.
- When a call does time out, Finch tells the model the work may still be running in the background and to look up the existing task instead of re-submitting. Make that possible: give every long-running tool a way to list or query the task it just created, and keep the submit path idempotent where you can.

---

## References

- `reference/finch.d.ts` — full API reference and type definitions.
- `reference/README.md` — detailed authoring guide and patterns.
- `reference/tools.md` — Agent tool naming, inputSchema, risk levels, forms, and common mistakes. **Read this before registering any tool.**
- `reference/composer-actions.md` — Composer button manifest fields, runtime providers, menu-item `hoverText`, menus, and debugging rules.
- `reference/icons.md` — built-in icon list, runtime SVG packs, `IconRef` format, and SVG rules. **Read this before setting any `icon` field.**
- `reference/session.md` — owner-scoped Sessions, containers, Space placement, events, and limits. **Read this before using `ctx.sessions`.**
- `reference/mcp.md` — local MCP server setup for on-demand tool loading.
- `reference/oauth.md` — OAuth permissions, provider config, Authorization Code + PKCE, Device Flow, brokered requests, and security boundaries.
- `reference/ui.md` — Toast, dialog, Canvas window, Webview Panel/Bridge, Composer annotations, and native window-level guidance.
- `reference/capabilities.md` — `ctx.capabilities` provide/get for cross-extension collaboration.
- `reference/publish.md` — packaging, npm publishing, and community listing.
- Use `@finchtoys/minitool-api` in new mini tools; do not point `paths` at a local Finch repo checkout or the user's environment directory.

When you need exact fields, method signatures, examples, or edge cases, read the reference files directly. The §0 pre-flight table tells you which files apply to your feature — read them all before writing code.
