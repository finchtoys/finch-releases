# Composer Actions

This document covers toolbar buttons in the Composer.

## 1. Mental model

A Composer action has two parts:

- static manifest declaration in `contributes.composerActions`
- dynamic runtime provider via `ctx.composerActions.register(id, provider)`

The manifest declares the slot. The provider fills in live badge text, menu items, and execution behavior.

## 2. Static declaration

```json
{
  "contributes": {
    "composerActions": [
      { "id": "git-branch", "icon": "GitBranch", "tooltip": "Switch branch" }
    ]
  }
}
```

Keep the declaration minimal:

- `id` must match the runtime registration id
- `icon` is the default icon
- `tooltip` is the user-facing label

## 3. Runtime provider

```ts
ctx.subscriptions.push(
  ctx.composerActions.register('git-branch', {
    async getBadge({ cwd }) {
      return cwd ? 'main' : undefined;
    },
    async getMenu({ cwd }) {
      return [{ id: 'main', label: 'main' }];
    },
    async execute({ cwd }, itemId, actions) {
      await actions.fillComposer(`Selected ${itemId}`);
    }
  })
);
```

`register()` returns a `Disposable & { notifyUpdate() }` handle. When you need **badge auto-refresh** (e.g. background polling), hold the handle outside `subscriptions`:

```ts
const action = ctx.composerActions.register('git-branch', provider);
ctx.subscriptions.push(action);

// Poll git state every 5 s and push a badge refresh when it changes.
let lastBranch = '';
const timer = setInterval(async () => {
  const branch = await getCurrentBranch(cwd);
  if (branch !== lastBranch) {
    lastBranch = branch;
    action.notifyUpdate(); // tells the app to re-call getBadge()
  }
}, 5000);
ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
```

## 4. Provider methods

### `getBadge(ctx)`

- return a string to show badge text
- return `undefined` to show icon only
- throw to hide the button when the current surface or cwd does not apply

`getBadge` is **pulled** by the app — it is called when the toolbar mounts, after
`execute`, or when `notifyUpdate()` signals a refresh. It is not called on a timer
by itself; see `notifyUpdate()` below.

### `notifyUpdate()` — handle method

`notifyUpdate()` is on the **handle returned by `register()`**, not on the provider.
Call it whenever background state changes and the badge should reflect the new value.

```ts
const action = ctx.composerActions.register('counter', provider);
action.notifyUpdate(); // app re-calls getBadge()
```

The call is fire-and-forget and has no debounce — avoid calling it at very high
frequency. A polling interval of ≥ 3 s is recommended.

### `getIcon(ctx)`

Optional dynamic icon override.
Return an `IconRef` or `undefined`.

### `getMenu(ctx)`

Return the menu items shown on click.
If the array is empty, Finch shows an empty menu state.

### `execute(ctx, itemId, actions)`

Handle the selected item. Use `actions.fillComposer()` when the button should write into the current Composer input.

## 5. Menu item patterns

Useful fields:

- `id`
- `label`
- `description`
- `iconName`
- `current`
- `disabled`
- `separator`
- `group`
- `groupLabel`
- `groupMaxVisible`
- `children`

Rules:

- Keep same-group items contiguous.
- Use `children` for hover submenus.
- Use `current` for selected state.
- Use `disabled` instead of removing a still-visible option.

## 6. Surface behavior

`ComposerActionContext.surface` tells you whether the action is on:

- `home`
- `session`

Use it to vary visibility or menu content.

Example:

```ts
async getBadge({ surface }) {
  if (surface === 'home') throw new Error('hidden on home');
  return 'ready';
}
```

## 7. Visibility rules

- Buttons should stay visible when possible.
- Throw only when the action is truly not applicable.
- Use `cwd`-based checks for repo-specific actions.
- Avoid noisy errors for expected states.

## 8. fillComposer()

`actions.fillComposer(text, options)` can:

- replace the current input
- append text to the current input

It also parses `/skill` and `@[path]` tokens.

Use it for quick drafts, templates, and file-linked prompts.

## 9. Common mistakes

- Badge throws on ordinary non-matching state
- Menu items not grouped contiguously
- Using custom DOM instead of Composer actions
- Forgetting that the selected child id is what reaches `execute()`
- Calling `notifyUpdate()` on a tight loop (< 1 s) — it triggers a full re-fetch each time
- Discarding the `register()` return value and losing access to `notifyUpdate()`
- Expecting `getBadge` to be called automatically without `notifyUpdate()` when state changes in the background
