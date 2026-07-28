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
- `tooltip` is the short user-facing label and accessibility name

`tooltip` is only the short hint on the ComposerAction toolbar button; longer per-item descriptions belong to `hoverText` on items returned by `getMenu()`.

## 3. Runtime provider

```ts
ctx.subscriptions.push(
  ctx.composerActions.register('git-branch', {
    async getBadge({ cwd }) {
      return cwd ? 'main' : undefined;
    },
    async getMenu({ cwd }) {
      return [{
        id: 'main',
        label: 'main',
        iconName: 'git-branch',
        hoverText: 'Switch to the main branch.',
      }];
    },
    async execute({ cwd }, itemId, actions) {
      await actions.composer.fill(`Selected ${itemId}`);
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

Returns the button badge. Three return shapes are supported:

| Return value | Effect |
|---|---|
| `string` | Badge text in default colour |
| `{ text?, active? }` | Badge text + optional **active / checked** state |
| `undefined` | Icon only (no badge text) |
| throw | Button is hidden (not applicable for current cwd/surface) |

When `active: true` the button enters a persistent "checked" visual state — accent-coloured icon, accent-coloured badge text, and a subtle background tint — making it obvious that a toggle mode is currently ON.

```ts
// Plain string — git branch, counter, etc.
async getBadge({ cwd }) { return getCurrentBranch(cwd); }

// Active state — planning mode toggle, filter, global switch
async getBadge() {
  if (planningMode) return { text: 'Planning', active: true };
  // Return undefined to hide the badge while mode is off.
  // Throw here instead to hide the *button* entirely when inactive.
  return undefined;
}

// Active-only indicator — no text, just the accent icon + background
async getBadge() {
  return filterActive ? { active: true } : undefined;
}
```

`getBadge` is **pulled** by the app — it is called when the toolbar mounts, when
`cwd` / `surface` / `sessionId` / `spaceId` changes, after `execute`, or when
`notifyUpdate()` signals a refresh. It is not called on a timer by itself; see
`notifyUpdate()` below.

`ctx.sessionId` is available on the `session` surface, so toggle state can be keyed
per conversation instead of being global.

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

Set `hoverText` on a menu item when it needs a longer plain-text explanation. Finch shows it in a HoverCard while that row is hovered, preserves line breaks, and does not parse HTML or Markdown. Nested `children` items support the same field.

#### Trailing hover button (`trailingButton`)

A menu item may carry a standalone **trailing button** for a secondary action distinct from selecting the row itself (open in browser, copy, delete, jump, etc.).

```ts
async getMenu() {
  return [
    {
      id: 'main',
      label: 'main',
      iconName: 'git-branch',
      description: 'default',                       // shown when NOT hovering
      trailingButton: { id: 'open', iconName: 'external-link', tooltip: 'Open on GitHub' },
    },
  ];
}

async execute(ctx, itemId, actions) {
  if (itemId === '__trailing__:open') { openBranchOnGitHub(); return; }  // trailing button
  if (itemId === 'main') { await checkout('main'); }                    // normal row select
}
```

Behavior and constraints:

- **Visible only on hover** — the button appears when the mouse is over that menu row; it stays hidden otherwise.
- **Replaces the description** — while the button is shown, it takes the place of the row's `description` text (they never show at once).
- **Separate click routing** — clicking the button fires `execute(ctx, '__trailing__:<button.id>', actions)`, NOT the row's own `execute(itemId)`. The click does not bubble to the row and does **not** close the menu; if you want to close it, drive the Composer via `actions.composer.*` from your handler.
- **Not on submenu rows** — items with `children` cannot have a trailing button; the field is ignored there (those rows already show the submenu chevron).
- `iconName` is required and follows the usual `IconRef` rules (built-in name or `ext:<packId>/<iconId>`); `tooltip` renders as a native title; `disabled` greys it out.

### `getReminder(ctx)`

Called by Finch **before each user message is sent to the model**. Return a string to inject a per-turn constraint; return `undefined` or throw to skip.

Finch wraps the returned string in a `<reminder>` block and appends it to the outgoing message. The model sees it, but the UI strips it so users never see it in the chat bubble.

Use it for stateful mode switches where you want to constrain the model every turn without requiring the user to type anything:

```ts
const planningBySession = new Map<string, boolean>();
const isPlanning = (sessionId?: string) => !!sessionId && planningBySession.get(sessionId) === true;

const action = ctx.composerActions.register('plan-mode', {
  async getBadge({ sessionId }) {
    return isPlanning(sessionId) ? { text: 'Plan', active: true } : undefined;
  },
  async getIcon({ sessionId }) {
    return isPlanning(sessionId) ? 'clipboard-check' : 'clipboard';
  },
  async onClick({ sessionId }) {
    if (!sessionId) return;
    planningBySession.set(sessionId, !isPlanning(sessionId));
    action.notifyUpdate();
  },
  async getReminder({ sessionId, surface }) {
    if (!isPlanning(sessionId) || surface === 'home') return undefined;
    return 'This turn is planning only — output a plan, do not execute any tools or perform side effects.';
  },
  async onTurnEnd({ sessionId, surface }, actions) {
    if (!isPlanning(sessionId) || surface === 'home') return;
    const result = await actions.composer.confirm({
      text: 'Plan is ready. Start implementation?',
      confirmLabel: 'Start',
      cancelLabel: 'Keep planning',
    });
    if (result === 'confirm') {
      planningBySession.set(sessionId!, false);
      action.notifyUpdate();
      await actions.composer.fill('Start implementing the plan above.');
    }
  },
});
```

Rules:
- Throwing or returning `undefined` skips injection for that provider.
- Multiple providers can each contribute a reminder; Finch joins them with `\n\n`.
- Keep reminders short and directive — one or two sentences max.
- Use `surface === 'home'` to skip the reminder when the Composer is on the Home screen.

### `execute(ctx, itemId, actions)`

Handle the selected item. Use `actions.composer.fill()` when the button should write into the current Composer input.

### `onTurnEnd(ctx, actions)`

Called once after each assistant turn finishes in a session. Use it for post-response UI such as asking the user whether to leave a mode.

```ts
async onTurnEnd(ctx, actions) {
  if (!ctx.sessionId || ctx.surface === 'home') return;
  const result = await actions.composer.confirm({
    text: 'Plan is ready. Start implementation?',
    confirmLabel: 'Start',
    cancelLabel: 'Keep planning',
  });
  if (result === 'confirm') {
    await actions.composer.fill('Start implementing the plan above.');
  }
}
```

`actions.composer.confirm()` renders an inline Composer confirm bar, not a timeline card and not a modal dialog. It resolves to:

- `'confirm'` — user clicked the primary button
- `'cancel'` — user clicked the secondary button
- `'dismissed'` — user ignored the bar and sent a message / the request was cleared

## 5. Menu item patterns

Useful fields:

- `id`
- `label`
- `description`
- `hoverText`
- `trailingButton` — right-aligned hover button (`{ id, iconName, tooltip?, disabled? }`); click fires `execute('__trailing__:<id>')`; ignored on `children` rows
- `iconName`
- `current`
- `disabled`
- `separator`
- `group`
- `groupLabel`
- `groupMaxVisible`
- `children`

Rules:

- **Every actionable menu item must provide `iconName`**. Only structural entries such as `separator` may omit it. This keeps menus scannable and prevents icon-less rows from slipping into mini tools.
- `separator: true` is a standalone structural item, never a flag on an actionable row. Give it its own id and an empty label, e.g. `{ id: 'account-divider', label: '', separator: true }`; the following login/logout row is a separate item without `separator`.
- Prefer an icon already available in Finch; see [`icons.md`](./icons.md) for the supported built-in ids.
- If no built-in icon fits, register an SVG from Lucide (or another compatible icon library) through `ctx.icons.register()` and reference it as `ext:<packId>/<iconId>`; do not pass an unverified Lucide name as plain text.
- Apply the same rule recursively to every item in `children`.
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

## 8. Composer helpers

`actions.composer.fill(text, options)` can:

- replace the current input
- append text to the current input

It also parses `/skill` and `@[path]` tokens.

Use it for quick drafts, templates, and file-linked prompts.

`actions.fillComposer(text, options)` is still supported for backward compatibility, but new code should use `actions.composer.fill()`.

## 9. Common mistakes

- Badge throws on ordinary non-matching state
- Menu items not grouped contiguously
- Omitting `iconName` from an actionable menu item (including nested `children`)
- Using an unverified Lucide name as `iconName` instead of a built-in id or registered `ext:` SVG
- Using custom DOM instead of Composer actions
- Putting menu-row explanations in the button `tooltip` instead of the `getMenu()` item's `hoverText`
- Treating a menu item's `hoverText` as HTML or Markdown; Finch renders it as plain text
- Forgetting that the selected child id is what reaches `execute()`
- Calling `notifyUpdate()` on a tight loop (< 1 s) — it triggers a full re-fetch each time
- Discarding the `register()` return value and losing access to `notifyUpdate()`
- Expecting `getBadge` to be called automatically without `notifyUpdate()` when state changes in the background
- Returning a reminder string unconditionally even on the `home` surface — use `surface === 'home'` guard
- Writing user-visible text in `getReminder` — it's invisible in the UI; use `getBadge` or `actions.composer.confirm()` for UI feedback
- Using `ctx.ui.showConfirmDialog()` for Composer-only choices — prefer `actions.composer.confirm()` so the decision appears inline and restores with the session
