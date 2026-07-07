# Icons

This document covers icon references and runtime icon packs.

## 1. IconRef

An `IconRef` is the shared string format used wherever Finch accepts an icon.

Supported forms:

- built-in Lucide name, like `GitBranch` or `git-branch`
- runtime icon id from the same pack
- fully qualified form: `ext:<packId>/<iconId>`
- shorthand current-pack form: `ext:<iconId>`

## 2. Built-in icons

Use built-in icons for simple cases.
They are fixed at app build time and do not require registration.

## 3. Runtime icon packs

Declare packs in the manifest:

```json
{
  "contributes": {
    "iconPacks": [
      { "id": "my-icons", "label": "My Icons" }
    ]
  }
}
```

Then register SVGs from code:

```ts
ctx.icons.register('my-icons', {
  rocket: { svg: '<svg viewBox="0 0 24 24">...</svg>' }
});
```

## 4. SVG rules

Keep SVGs:

- single-color
- around 24×24 viewBox
- free of scripts
- free of external references
- safe to sanitize

Finch sanitizes SVG before display.

## 5. Where icons are used

Common icon entry points include:

- Composer actions
- menu items
- extension badges
- detail views
- future Finch surfaces that accept `IconRef`

## 6. Good icon practice

- choose symbols that remain clear at small sizes
- use one visual meaning per icon
- avoid overly detailed artwork
- prefer consistent stroke width and alignment
