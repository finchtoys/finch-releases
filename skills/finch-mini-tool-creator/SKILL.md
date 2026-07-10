---
name: finch-mini-tool-creator
description: >
  Guide for developing, debugging, installing, and publishing Finch mini tools.
  Invoke this skill whenever the user wants to create a new Finch mini tool,
  extend Finch with custom Agent tools or Composer toolbar buttons, understand
  the finch.d.ts API, debug an existing mini tool, install/deploy/update/remove
  a mini tool with the official `npx @finchtoys/minitools` CLI, publish a
  mini tool to npm/the community catalog, package a mini tool for distribution,
  list a mini tool on the official community, or submit a mini tool to
  finch-releases. Trigger on phrases like "write a finch mini tool", "create a
  finch mini tool", "add a tool to finch", "debug my mini tool", "mini tool not
  loading", "how do I make a composer button", "install this finch mini tool",
  "deploy/publish a finch mini tool", "package my mini tool", "publish to npm",
  "how to list on community", "submit to finch community", etc.
---

# Finch Mini Tool Creator

This skill is the entry point for creating Finch mini tools.

- **Product name:** mini tool
- **Install directory:** `extensions` (unchanged)
- **Tech/API surface:** use the published `@finchtoys/minitool-api` package for Finch APIs

Use this skill as an index first:

1. Learn the basic rules in **§1 Quick Start**.
2. Check the supported folder layout in **§2 Project Structure**.
3. Read the manifest and runtime rules in **§3 Core Rules**.
4. Jump to **References** only when you need exact API details.

---

## 1. Quick Start

A mini tool is an npm-style TypeScript package discovered from the file system. It can contribute Agent tools, Composer toolbar buttons, bundled Skills, and other Finch runtime capabilities through a single `MiniToolContext` (`ctx`) object. `ExtensionContext` remains available as a deprecated compatibility alias.

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

If you only need the exact API signatures, skip ahead to **References**.

---

## 2. Project Structure

Finch discovers mini tools from two supported tiers, checked in this order:

| Tier | Path | Use when |
|---|---|---|
| Personal | `<finchHome>/.finch/extensions/<id>/` | Default choice |
| Global | `~/.finch/extensions/<id>/` | Shared machine-wide install |

Notes:

- The extension id and the directory name should match.
- Project-level installs are not supported.
- Always install with the official CLI so the real path is used.

---

## 3. Core Rules

### Manifest

A minimal mini tool needs:

- `manifestVersion`
- `id`
- `name`
- `main`
- `activationEvents`
- `contributes`
- `permissions` when needed

### API access

All runtime capabilities go through `ctx`:

- `ctx.tools`
- `ctx.composerActions`
- `ctx.ui`
- `ctx.storage`
- `ctx.secrets`
- `ctx.logger`
- `ctx.app` — read Finch app info such as version/build/platform/assistantName (user-customized assistant name, e.g. "帕亚"; use it to personalize tool output)
- `ctx.i18n`
- `ctx.capabilities`
- `ctx.extensions`

### Install and debug

Recommended flow:

1. Build the mini tool.
2. Run `npx @finchtoys/minitools doctor .`.
3. Install with `npx @finchtoys/minitools add .`.
4. Enable it in Finch.
5. Check logs if activation fails.

---

## References

- `reference/finch.d.ts` — full API reference and type definitions.
- `reference/README.md` — detailed authoring guide and patterns.
- Use `@finchtoys/minitool-api` in new mini tools; do not point `paths` at a local Finch repo checkout or the user's environment directory.

When you need exact fields, method signatures, examples, or edge cases, read the reference files directly.
