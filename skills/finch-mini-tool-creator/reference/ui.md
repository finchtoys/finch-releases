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

Keep it readable and plain text only.

## 6. Canvas Window

Use `createCanvasWindow()` for floating overlays, pets, and canvas-driven mini UIs.

Important points:

- you provide a script entry, not HTML
- Finch owns the window shell
- the canvas script registers with `finch.canvas.define(...)`
- the host can send messages to the canvas and receive messages back

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
