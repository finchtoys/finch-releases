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
});
```

## 4. Provider methods

### `getBadge(ctx)`

- return a string to show badge text
- return `undefined` to show icon only
- throw to hide the button when the current surface or cwd does not apply

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
