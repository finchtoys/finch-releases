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

```ts
const overlayWindow = ctx.ui.createCanvasWindow({
  entry: 'dist/overlay-canvas.js',
  width: 320,
  height: 180,
  alwaysOnTop: true,
  alwaysOnTopLevel: 'floating',
});
```

Good uses:

- desktop pet
- floating timer
- tiny visual utility

Do not use it for ordinary app pages.

## 7. Webview Panel

`createWebviewPanel()` is currently reserved.
Do not rely on it for production mini tools.

## 8. UI best practices

- Prefer native Finch UI over custom browser UI.
- Keep feedback non-blocking when possible.
- Match toast/dialog wording to the action the user just took.
- Avoid modal overload.
