# UI

This document covers UI helpers exposed through `ctx.ui`.

## 1. UI philosophy

Use Finch-provided UI primitives whenever possible.
Do not build custom notification or dialog shells for simple cases.

## 2. Toasts

Use `showToast()` for lightweight feedback.

```ts
await ctx.ui.showToast({
  title: 'Saved',
  description: 'Settings updated.',
  variant: 'success',
  position: 'TC'
});
```

Notes:

- use `action` for a simple right-side button
- await the result if you need to react to the click
- keep toast text short

## 3. Confirm dialogs

Use `showConfirmDialog()` for yes/no decisions.

Good for:

- destructive actions
- permission-sensitive operations
- irreversible state changes

Keep the message short and direct.

## 4. Modal dialogs

Use `showModalDialog()` when the user needs to choose one of several actions.

Use it when a confirm dialog is too limited and a full custom window would be overkill.

### 4.1 Collecting manual input: `fields` vs `requestForm`

Both APIs render the exact same field grid — `MiniToolFormField[]` items of type
`text` / `password` / `textarea` / `number` / `select` / `multiselect` / `boolean` / `link`, with
`required`, `secret`, `width` (`'full' | '1/2' | '1/3' | '2/3'`), `default`, and
`options`. Pick between them based on **when** you need the input, not how to render it:

| | `exec.ui.requestForm(spec)` | `ctx.ui.showModalDialog({ ..., fields })` |
|---|---|---|
| Where it's callable | Only inside a tool's `execute(input, exec)` | Anywhere off `MiniToolContext.ui` — ComposerAction handlers, `sessionContainers` settings-menu `execute()`, even `activate()` |
| Depends on an Agent turn | Yes — only appears while the model is mid-turn and actually called your tool | No |
| Where it renders | Composer waiting-area card | Native modal dialog with your own `actions` buttons |
| Good for | "The model needs one more piece of info to finish this tool call" | "The user clicks a settings button and manually types an API key / token" — nothing here should depend on the AI deciding to call a tool |

When `fields` is set on `showModalDialog`, the first `variant: 'primary'` action stays
disabled until every `required` field is filled, and the resolved
`ModalDialogResult.values` carries what the user typed
(`Record<string, string | number | boolean | string[]>`).
`secret: true` only masks the field and keeps its value out of model-visible form content; it does not persist or encrypt anything. Treat these values like any other credential: declare the key in `permissions.secrets`, store it with `ctx.secrets`, and never echo it into a tool result, log, or model-visible content. `ctx.storage` is plaintext JSON and must not contain credentials.

```ts
const result = await ctx.ui.showModalDialog({
  title: 'Configure API Key',
  actions: [
    { id: 'cancel', label: 'Cancel' },
    { id: 'save', label: 'Save', variant: 'primary' },
  ],
  fields: [
    { key: 'apiKey', label: 'API Key', type: 'password', secret: true, required: true },
  ],
});
if (result.action === 'save') {
  await ctx.secrets.set('apiKey', String(result.values?.apiKey ?? ''));
}
```

A `multiselect` field renders the same trigger as `select`, but its popup carries a
check column and stays open while the user toggles items. Its value is always a
`string[]` — `[]` when nothing is checked, and `required: true` means "at least one".
Selected values come back in the order the options were declared, not click order.
The trigger shows the joined labels and collapses to a count past three selections.

```ts
fields: [
  {
    key: 'scopes',
    label: 'Scopes',
    type: 'multiselect',
    required: true,
    default: ['read'],
    options: [
      { value: 'read', label: 'Read' },
      { value: 'write', label: 'Write' },
      { value: 'admin', label: 'Admin' },
    ],
  },
]

// result.values?.scopes → string[]
const scopes = (result.values?.scopes as string[] | undefined) ?? [];
```

See `reference/tools.md` for `exec.ui.requestForm()` usage from inside a tool's `execute()`.

## 5. Structured message text

Dialog `message` supports lightweight structured text:

- blank lines
- inline code
- emphasis tokens
- muted / warning lines
- a standalone Markdown image line: `![alt](src)`

Use dialog images for temporary user-facing visuals such as login QR codes or previews. They stay in Finch UI and are not included in the tool result or model context.

Allowed image sources:

- credential-free `https://` URLs
- base64 `data:image/png`, `data:image/jpeg`, `data:image/webp`, or `data:image/gif` URLs up to 5 MB

Do not use `http://`, `file://`, SVG data URLs, arbitrary HTML, or custom protocols. Put the image syntax on its own line; invalid or unsafe sources render as text.

```ts
const dialog = ctx.ui.showModalDialog({
  title: 'Scan to sign in',
  message: `Open the mobile app and scan this code.\n\n![Login QR](data:image/png;base64,${pngBase64})`,
  actions: [{ id: 'close', label: 'Close' }],
});

// When background login polling reports success, close the visible Modal.
await dialog.close('connected');
const result = await dialog; // { action: 'connected' }
```

`showModalDialog()` remains directly awaitable for existing code. Its returned `ModalDialogHandle` also exposes `close(action?)`; calling it removes the visible dialog and resolves that same handle through the normal action path. Use `dismissed` (the default) when no distinct programmatic outcome is needed. Calling `close()` after the user has already acted is a safe no-op.

Keep the remaining text readable and concise.

### 5.1 Delivery sidebar rows (`ctx.ui.delivery`)

`ctx.ui.delivery.set(options)` / `.remove()` write the current Session's
**one** row in the right Work Sidebar "交付" (Delivery) section — a flat,
Session-scoped record, unrelated to the conversation timeline. There is no
history and no explanation text, just a title plus an optional one-line
`detail`. The platform caps this at exactly one row per mini tool per
Session — there is no `entryId`; calling `set()` again always overwrites
that same row instead of appending a second one.

```ts
await ctx.ui.delivery.set({
  title: 'Sync summary',
  detail: '{+42}\\g {-7}\\r',
  icon: 'GitBranch',
  payload: { documentId: 'summary-42', tab: 'changes' },
});

// Later, once the task is done:
await ctx.ui.delivery.remove();
```

`detail` supports the same inline token subset as dialog `message` text
(section 5 above) — `` `code` `` and `` {text}\g/\r/\y/\m/\a/\b/\i `` colour/
weight/style spans — but is single-line only: no blank lines, `>`/`!`
prefixes, or images. Use `remove()` when the row should no longer be shown.

Clicking a Delivery row opens that mini tool's unique Panel App declared by
`contributes.appPanel`. A mini tool that contributes Delivery must therefore
declare its Panel App; there is no separate target view type or Toolbox fallback.
Optional JSON `payload` is forwarded to that Panel open and retained with the
Session's Panel tab so a recreated page can restore its state.

## 6. Canvas Window

Use `createCanvasWindow()` for floating overlays, pets, and canvas-driven mini UIs.

Important points:

- you provide a script entry, not HTML
- Finch owns the window shell
- the canvas script registers with `finch.canvas.define(...)`
- the host can send messages to the canvas and receive messages back
- use `allowOffscreen: true` only when a window must extend beyond the work-area edge
- use the read-only `finch.window.getDisplays()` for multi-display geometry; it stays current when displays are added/removed or rearranged, so re-read it instead of caching long-term
- overlay-style windows (desktop pets etc.) can opt in to `hiddenInMissionControl` (stay out of Mission Control) and `visibleOnAllWorkspaces` (follow every Space, including fullscreen ones); both default to false and are macOS-only
- `visibleOnAllWorkspaces` controls Space visibility independently from the native window level
- macOS callers can set `alwaysOnTopLevel` to only `normal` or `floating`, plus `alwaysOnTopRelativeLevel`; Windows/Linux ignore these parameters and retain boolean always-on-top behavior
- both the Host handle and Canvas bridge support `setAlwaysOnTop(value, level?, relativeLevel?)`; boolean-only calls remain valid
- await `window.ready` before depending on the runtime; it resolves only after shell load, `define()`, and `init()` succeed, and rejects when creation is cancelled or fails
- use `window.state`, `window.visible`, `onDidChangeState`, and `onDidChangeVisibility` instead of inferring lifecycle from local flags
- use `await window.update({ bounds, alwaysOnTop, alwaysOnTopLevel, clickThrough, visible })` when switching window modes; one update uses one native `setBounds()` and emits only final move/resize state
- `dispose()` is idempotent; Canvas close, native close, reload, and Host dispose produce one `onDidDispose`
- continuous `frame(dt)` animation defaults to 30 FPS; request 60 only when motion quality requires it, or use 15 for low-frequency visuals
- use `maxDevicePixelRatio` (default 2) to cap backing-store pixels on high-DPI displays
- implement `render(ctx2d)` instead of `frame(dt)` for static or event-driven content, then call `finch.canvas.invalidate()` after state changes
- hidden windows automatically pause drawing; do not build a second visibility loop
- do not call `setPosition()` every animation frame for autonomous movement; use Host-side `startMotion()` so Main performs one bounded native movement loop
- decode images and create gradients/paths outside hot `frame()` callbacks; keep transparent windows tightly sized to visible content

```ts
const overlayWindow = ctx.ui.createCanvasWindow({
  entry: 'dist/overlay-canvas.js',
  width: 320,
  height: 180,
  alwaysOnTop: true,
  alwaysOnTopLevel: 'floating',
  frameRate: 30,
  maxDevicePixelRatio: 2,
});

await overlayWindow.ready;
await overlayWindow.update({
  bounds: { x: 480, y: 320, width: 360, height: 696 },
  alwaysOnTop: true,
  alwaysOnTopLevel: 'normal',
  clickThrough: false,
  visible: true,
});

overlayWindow.startMotion({
  kind: 'spring',
  to: { x: 480, y: 320 },
  durationMs: 600,
  bounds: 'display-work-area',
});
```

For on-demand Canvas content:

```js
finch.canvas.define({
  init({ ctx2d }) { this.ctx = ctx2d; this.value = 0; },
  render() { this.ctx.clearRect(0, 0, 320, 180); this.ctx.fillText(String(this.value), 20, 40); },
  onMessage(message) {
    this.value = message.value;
    finch.canvas.invalidate();
  },
});
```

Good uses:

- desktop pet
- floating timer
- tiny visual utility

Do not use it for ordinary app pages.

## 7. Native preview and Diff

Use `ctx.ui.openFilePreview(absolutePath)` to open Markdown, source code, or
another previewable text file, and `ctx.ui.openDiff(request)` for native
file/Git Diff. Both require an active Panel scope but do **not** require
`contributes.appPanel`; their Panel/modal presentation follows the user's
「改动与文件预览」setting.

```ts
await ctx.ui.openFilePreview('/workspace/README.md');
await ctx.ui.openDiff({ type: 'files', leftPath: '/workspace/old.ts', rightPath: '/workspace/new.ts' });
await ctx.ui.openDiff({ type: 'git', repoPath: '/workspace', base: 'HEAD~1', target: 'HEAD' });
```

Pass absolute local paths. These APIs request UI only: Finch reads and renders
the content through its own pipeline, so the mini tool never receives file
content. Finch applies its normal text-size limits and binary detection. Do not
use them as file-reading APIs or assume every path is previewable.

## 8. Panel App

A mini tool declares at most one Panel App with `contributes.appPanel`. That
single declaration owns the app's page source, title, icon, instance default,
and toolbar. It is used by every opening path: the right Panel launcher,
`ctx.ui.createPanel()`, Composer actions, and Delivery rows.

```ts
const panel = ctx.ui.createPanel({
  instanceMode: 'single',
  payload: { documentId: 'summary-42', tab: 'changes' },
});
ctx.subscriptions.push(panel);
panel.onDidReceiveMessage((message) => ctx.logger.info('panel message', message));
panel.postMessage({ type: 'refresh' });
```

`createPanel()` does not accept `viewType`, title, icon, source, Bridge config,
or toolbar. Use `instanceMode: 'single'` to reuse one tab in the current Panel
scope, or `multiple` to create independent instances. The current scope may be
a Session, Home, a session container, or another Panel-capable view. The
manifest default applies to launcher clicks and no-argument `createPanel()`;
runtime code may explicitly override it per open operation. `payload` accepts
JSON values and is retained with that scope's Panel tab. Reopening a `single`
instance replaces its payload; `multiple` instances retain independent values.

Use `ctx.ui.onDidOpenPanel()` when the mini tool must handle page messages from
all opening paths, including launcher and Delivery clicks:

```ts
ctx.subscriptions.push(ctx.ui.onDidOpenPanel((panel) => {
  ctx.subscriptions.push(panel.onDidReceiveMessage(handleMessage));
}));
```

This listener also fires for a `contributes.appView` app-level page the user
opened directly — it never calls `createPanel()` itself, so `onDidOpenPanel()`
is the only way the backend gets a `panel` handle (and can `postMessage()` /
`onDidReceiveMessage()`) for it. Check `panel.view === "appView"` to tell it
apart from a Panel App instance; `panel.sessionId`/`spaceId`/`spaceName` are
always `undefined` for it (an App View is application-level, not scoped to any
Session or Space).

The listener receives each live `panel.id` once and immediately receives any
instances that were already open when it subscribed. Finch unregisters the Host
handle when the frontend Panel is disposed. Callbacks inherit that Panel's own
scope, so `ctx.browser.open()` targets the correct Panel scope and Delivery uses
the Panel's real Session when one exists. A handle returned by `createPanel()`
can still be observed directly. Its current opening context is available as
`panel.payload`.

To open a web URL in Finch's built-in Browser Panel instead of the system
external browser, call:

```ts
await ctx.browser.open('https://example.com/docs');
```

Only `http:` and `https:` URLs are accepted. Each call opens a new Browser tab
in the current Panel scope and requires an active Panel viewer.

Declare the app in the manifest:

```json
"contributes": {
  "appPanel": {
    "title": "Dashboard",
    "icon": "gauge",
    "viewType": "demo.dashboard",
    "instanceMode": "single",
    "showInLauncher": true,
    "source": { "type": "local", "path": "dist/dashboard.html" }
  }
}
```

- `source.type` supports `"local"` (packaged page served by Finch's static server)
  or `"url"`; inline HTML is not a Panel App source.
- `local` sources receive the Bridge and Finch theme variables; public `url`
  sources do not receive the Bridge.
- `showInLauncher` controls both the right Panel `+` menu and Welcome page;
  it defaults to `true`. Setting it to `false` does not disable the app:
  `createPanel()`, Composer actions, and Delivery rows can still open it.
- `toolbar` is declared here. Use `{ type: 'title', id, icon, label }` for a
  static icon-and-label heading; it is display-only and does not send a message.
  From an `AppPanel` handle, `setToolbar(items)` atomically replaces the row and
  `updateToolbarItem(id, { label, icon })` updates one top-level item. Every
  button or menu click reaches the page as `{ type: 'finch:menu', itemId }`
  through `window.finch.onMessage()`.
- The page changes its current tab with `window.finch.panel.setTitle()` and
  `window.finch.panel.setIcon()`. Backend `AppPanel` handles may also replace
  the whole toolbar or update a top-level item as described above.

### 7.1 Bridge security

Packaged `local` pages receive the JS Bridge. Public `url` pages never receive it. Node, Electron, arbitrary IPC, Shell, and unrestricted file reads are never exposed.

Trusted pages access the bridge as `window.finch` (cast it to `finch.WebviewBridgeApi` in page TypeScript):

```ts
const api = (window as Window & { finch: finch.WebviewBridgeApi }).finch;
api.postMessage({ type: 'ready' });
const unsubscribe = api.onMessage((message) => render(message));

// Read-only Space directory, no user gesture or host-extension round trip
// needed — same data as `ctx.spaces.list()` on the backend side.
const spaces = await api.spaces.list();
```

Cross-origin navigation from a bridged page is blocked and opened in the system browser. Do not use a remote page as a privileged UI shell.

### 7.2 Composer contexts and annotations

Bridge calls that write into Composer require a real page user gesture and only add removable draft context; they never send a message automatically.

File line annotation:

```ts
await api.composer.addContexts([{
  type: 'file-range',
  path: '/workspace/src/App.tsx',
  ranges: [{ startLine: 18, endLine: 32 }],
  note: 'Split this state logic',
  displayName: 'App.tsx · 18–32',
}]);
```

Image annotation uses normalized `0..1` rectangles. Finch draws the numbered regions into a PNG and adds notes as removable Composer context:

```ts
const shot = await api.capture.capturePage({ mode: 'viewport' });
await api.composer.addContexts([{
  type: 'image-region',
  ...shot,
  regions: [{ x: 0.18, y: 0.24, width: 0.42, height: 0.16, note: 'Spacing is inconsistent' }],
  displayName: 'Button region',
}]);
```

Keep a `file-range` batch below 20 contexts and image payloads below 20 MB. The page must not attempt to submit contexts on load, timers, or background messages.

### 7.3 Native toast / confirm dialog

`api.ui.toast(options)` and `api.ui.confirm(options)` render the exact same native Finch UI as `ctx.ui.showToast()` / `ctx.ui.showConfirmDialog()` on the extension backend side — **do not use the browser's `confirm()`/`alert()`**, which is unstyled, blocks the renderer, and is not guaranteed to appear consistently inside a sandboxed `<webview>`. Both work directly in a Panel App page without extension backend mediation and require a real page user gesture, same as `composer.addContexts()`:

```ts
document.getElementById('delete-btn').addEventListener('click', async () => {
  const { confirmed } = await api.ui.confirm({
    title: 'Delete this item?',
    message: 'This cannot be undone.',
    variant: 'danger',
  });
  if (!confirmed) return;
  await doDelete();
  await api.ui.toast({ title: 'Deleted', variant: 'success' });
});
```

`ui.toast()` resolves `{ action: 'action' | 'dismissed' }` (`'action'` only when the user clicks the optional `action` button); `ui.confirm()` resolves `{ confirmed: boolean }`. See `ToastOptions`/`ToastResult`/`ConfirmDialogOptions`/`ConfirmDialogResult` in `reference/finch.d.ts` for the full field list (title/description/variant/position/action for toast; title/description/message/confirmLabel/cancelLabel/variant for confirm).

### 7.4 Lifecycle

- A panel is bound to one Panel scope — a Session, Home, a session container,
  or (for an adopted `contributes.appView` page) the app-level scope — not
  only a Session. Creating one requires an active Panel viewer for that scope.
- Mini tool install/enable scope remains personal or global; only the panel instance is scope-bound as above.
- `reveal()` reopens/activates the panel.
- Use `setTitle` and `setIcon` for dynamic chrome; the toolbar itself stays manifest-owned (`contributes.appPanel.toolbar`).
- Stop expensive page work when `onDidChangeVisibility(false)` fires.
- Dispose the panel or push it to `ctx.subscriptions` so disabling the mini tool closes it.

### 7.5 App View host previews and Diff

An App View page may open Finch's native preview surfaces from a real user gesture:

```ts
await window.finch.appView.openPreview('/workspace/report.md');
await window.finch.appView.openDiff({
  type: 'files',
  leftPath: '/workspace/before.ts',
  rightPath: '/workspace/after.ts',
});
await window.finch.appView.openDiff({
  type: 'git',
  repoPath: '/workspace/repo',
  base: 'HEAD~1',
  target: 'HEAD',
});
```

`openPreview()` and `openDiff()` do not accept a presentation option. Finch follows the user's global「改动与文件预览」setting and opens the same native component in either the right Panel or a modal. File Diff requires two absolute paths. Git Diff resolves both commit/refs inside the absolute `repoPath` and may display added, modified, deleted, and renamed files in one multi-file view. The mini tool receives no file contents from these calls.

`openBrowser()` and `openApp()` are different: they remain child levels in the App View breadcrumb navigation stack. `openApp()` still requires the target's `embeddable: true` declaration.

## 9. UI best practices

- Prefer native Finch UI over custom browser UI.
- Keep feedback non-blocking when possible.
- Match toast/dialog wording to the action the user just took.
- Avoid modal overload.
