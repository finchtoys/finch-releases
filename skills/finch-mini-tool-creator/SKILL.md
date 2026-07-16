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
| Storage / secrets | `reference/finch.d.ts` → `Storage` / `Secrets` interfaces |
| MCP integration | `reference/mcp.md` |
| Publishing | `reference/publish.md` |

**ComposerAction icons are the most common failure point.** Before setting any `icon` field anywhere (manifest or code), open `reference/icons.md` and confirm the id is in the built-in list (§2). If it is not listed there, it will render as plain text — always register a runtime SVG pack instead of guessing. Do not skip this check.

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
- For ComposerAction menus, every actionable item must include `iconName`: reuse a built-in Finch icon first; otherwise register a Lucide (or compatible library) SVG and use its `ext:` reference. See `reference/icons.md`.
- Register Agent tools as lowercase English `snake_case` names in the form `<mini_tool_name>_<function_name>`; never use short generic names such as `init`, `build`, or `status`. See `reference/tools.md`.

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

- The extension id and the directory name should match.
- Project-level installs are not supported.
- Always install with the official CLI so the real path is used.

---

## 4. Core Rules

### Manifest

A minimal mini tool needs:

- `manifestVersion`
- `id`
- `name`
- `main`
- `activationEvents`
- `contributes`
- `permissions` when needed

For Composer toolbar buttons, declare `id`, `icon`, and short `tooltip` text in `contributes.composerActions`. Use optional `hoverText` for a longer plain-text HoverCard description; localize both fields under `i18n/<locale>.json → composerActions.<id>`.

Composer 工具栏按钮在 `contributes.composerActions` 中声明 `id`、`icon` 和简短 `tooltip`；较长的悬浮说明使用可选 `hoverText`，并在 `i18n/<locale>.json → composerActions.<id>` 中本地化这两个字段。

**Icon rule (mandatory):** Before setting the `icon` field, read `reference/icons.md` §2 and confirm the id appears in the built-in table. If it does not, register a runtime SVG pack (§3) and use an `ext:` reference. An unrecognised id silently renders as plain text — there is no warning.

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
- `reference/tools.md` — Agent tool naming, inputSchema, risk levels, forms, and common mistakes. **Read this before registering any tool.**
- `reference/composer-actions.md` — Composer button manifest fields, including `hoverText`, runtime providers, menus, and debugging rules.
- `reference/icons.md` — built-in icon list, runtime SVG packs, `IconRef` format, and SVG rules. **Read this before setting any `icon` field.**
- `reference/mcp.md` — local MCP server setup for on-demand tool loading.
- `reference/capabilities.md` — `ctx.capabilities` provide/get for cross-extension collaboration.
- `reference/publish.md` — packaging, npm publishing, and community listing.
- Use `@finchtoys/minitool-api` in new mini tools; do not point `paths` at a local Finch repo checkout or the user's environment directory.

When you need exact fields, method signatures, examples, or edge cases, read the reference files directly. The §0 pre-flight table tells you which files apply to your feature — read them all before writing code.
