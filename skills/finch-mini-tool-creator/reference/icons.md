# Icons

This document covers icon references, the built-in icon list, and how to use custom SVG icons.

## 1. IconRef

An `IconRef` is a plain string used wherever Finch accepts an icon —
composer action buttons, menu items, manifest declarations, etc.

Supported forms:

| Form | Example | When to use |
|---|---|---|
| kebab-case built-in | `'clipboard-check'` | Recommended — matches lucide.dev ids |
| PascalCase built-in | `'ClipboardCheck'` | Also works — auto-converted to kebab |
| `lucide:<id>` | `'lucide:clipboard-check'` | Explicit prefix, always safe |
| `ext:<iconId>` | `'ext:my-logo'` | Current pack shorthand (runtime SVG) |
| `ext:<packId>/<iconId>` | `'ext:my-pack/my-logo'` | Fully qualified runtime SVG |

> **If a string is not in the built-in list and not prefixed `lucide:` / `ext:`, Finch renders it as plain text.**
> This is the most common mistake — always verify the id is in the table below before shipping.

---

## 2. Built-in icons

These icons are built into the app and available everywhere without any registration.
Use the **kebab-case id** in your code (e.g. `'clipboard-check'`).
PascalCase variants (`'ClipboardCheck'`) are automatically normalised, so both work.

### General / defaults

| id | visual |
|---|---|
| `folder` | Folder |
| `hash` | Hash `#` |

### Composer actions & menus

| id | visual | typical use |
|---|---|---|
| `check` | ✓ checkmark | confirmation, done state |
| `clipboard` | clipboard | plan / draft |
| `clipboard-check` | clipboard + ✓ | plan mode active ✓ |
| `clipboard-list` | clipboard + list | task list |
| `file` | blank file | file operation |
| `file-text` | file with lines | document |
| `filter` | funnel | filter / search mode |
| `git-branch` | branch fork | git branch name |
| `git-commit-horizontal` | commit dot | commit / history |
| `list` | bullet list | listing / outline |
| `log-in` | door + arrow | sign in / connect |
| `message-circle` | speech bubble | chat / comment |
| `puzzle` | puzzle piece | plugin / extension |
| `settings` | gear | configuration |
| `sparkles` | ✨ sparkles | AI / magic action |
| `star` | ★ star | favourite / rating |
| `timer` | clock with hand | time-based |
| `toggle-left` | toggle off | off/disabled state |
| `toggle-right` | toggle on | on/enabled state |
| `wand-sparkles` | magic wand | transform / generate |
| `zap` | lightning bolt | quick / instant action |
| `zoom-in` | magnifier + | zoom / expand |
| `zoom-out` | magnifier − | zoom / collapse |

### Space icons (also available in mini tools)

| id | id | id | id |
|---|---|---|---|
| `bird` | `book` | `bookmark` | `braces` |
| `briefcase-business` | `calendar` | `camera` | `circle-dollar-sign` |
| `cloud` | `coffee` | `dumbbell` | `gamepad-2` |
| `gift` | `globe` | `graduation-cap` | `heart` |
| `house` | `lightbulb` | `mic` | `music` |
| `newspaper` | `notebook-pen` | `palette` | `plane` |
| `rocket` | `scroll-text` | `shield` | `shopping-cart` |
| `smile` | `sprout` | `square-terminal` | `star` |
| `store` | `users` | `utensils` | `wallet` |

---

## 3. Custom icons (runtime SVG packs)

### Icon selection order

For every ComposerAction menu item, choose icons in this order:

1. **Reuse a built-in Finch icon** from §2 whenever it communicates the action accurately. These are already available in the app and need no registration.
2. If Finch has no suitable icon, take the SVG from **Lucide** (preferred for visual consistency) or another compatible icon library, register it as a runtime pack, then use its `ext:` reference.
3. Do not use a bare icon-library name that Finch has not listed as built-in: it will render as text rather than an icon.

When no built-in icon fits, register your own SVG icons at runtime.

### Step 1 — declare the pack in the manifest

```json
{
  "contributes": {
    "iconPacks": [
      { "id": "my-icons", "label": "My Icons" }
    ]
  }
}
```

### Step 2 — register SVGs in code

```ts
ctx.icons.register('my-icons', {
  'send-message': {
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 2 11 13M22 2 15 22 11 13 2 9l20-7z"/></svg>',
  },
  // SVG copied from Lucide when Finch has no matching built-in icon.
  'translate': {
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
  },
});
```

### Step 3 — reference the icon

Use the registered icon for toolbar icons or ComposerAction menu item `iconName`:

```ts
// Shorthand (same pack only)
async getIcon() { return 'ext:send-message'; }

// Fully qualified (cross-pack or safer)
async getIcon() { return 'ext:my-icons/send-message'; }

async getMenu() {
  return [
    { id: 'translate', label: 'Translate', iconName: 'ext:my-icons/translate' },
  ];
}
```

### SVG requirements

| Rule | Detail |
|---|---|
| ViewBox | `0 0 24 24` recommended |
| Color | Use `currentColor` — Finch themes the icon automatically |
| Stroke width | Match Lucide's `1.8` for visual consistency |
| No scripts | `<script>` tags are stripped by the sanitizer |
| No external refs | No `<image href>`, `url()` pointing outside the SVG |
| Single-color | Avoid hard-coded fill colors that ignore the theme |

---

## 4. Dynamic icon via `getIcon()`

Composer action providers can return a different icon per state:

```ts
async getIcon(ctx) {
  // Swap icon based on toggle state
  return planningMode ? 'clipboard-check' : 'clipboard';
}
```

> `getIcon()` is called on every badge refresh (`notifyUpdate()` or after `execute` / `onClick`).
> Returning `undefined` falls back to the icon declared in the manifest (`contributes.composerActions[].icon`).

---

## 5. Common mistakes

| Mistake | Effect | Fix |
|---|---|---|
| Using a Lucide icon name not in the built-in list | The string is rendered as plain text in the button | Check the table in §2, or use a runtime SVG pack |
| Returning `'ClipboardCheck'` vs `'clipboard-check'` | Both work — auto-normalised | Either is fine; kebab-case is idiomatic |
| Using `ext:iconId` before `ctx.icons.register(...)` runs | Icon is invisible on first render | Register icons in the `activate` function before returning |
| SVG with hard-coded `fill="#000"` | Icon invisible in dark theme | Use `fill="currentColor"` or `stroke="currentColor"` |
| Forgetting `getIcon` in the provider | Falls back to manifest icon | That is often intentional — only add `getIcon` when the icon must change at runtime |
