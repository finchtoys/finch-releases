# Manifest

This document explains how to author `package.json#finch` for a Finch mini tool.

## 1. What the manifest is for

The manifest tells Finch:

- the mini tool id and display name
- what runtime entry to load
- which capabilities the mini tool contributes
- which permissions it needs
- whether it bundles Skills, icons, or Composer actions

Keep executable code in `src/`, and keep the manifest declarative.

## 2. Minimal fields

A usable mini tool manifest should include:

- `manifestVersion`
- `id`
- `name`
- `main`
- `activationEvents`
- `contributes`
- `permissions` when needed

Example:

```json
{
  "finch": {
    "manifestVersion": 1,
    "id": "my-mini-tool",
    "name": "My Mini Tool",
    "main": "dist/index.js",
    "activationEvents": ["onStartup"],
    "contributes": {
      "tools": true
    }
  }
}
```

## 3. Core manifest rules

- `id` must be stable after install.
- `main` points to the compiled entry file.
- `name` / `description` should be human-facing and concise.
- Keep new mini tools on a default string-based manifest and move locale text into `i18n/<locale>.json`.
- Use `displayName` only for backward compatibility.

## 4. Contributions

### Tools

Set `contributes.tools: true` when the mini tool registers Agent tools.

### Composer actions

Use `contributes.composerActions` for toolbar buttons.
Each item declares the static slot data:

- `id`
- `icon`
- `tooltip`

The dynamic behavior comes from `ctx.composerActions.register(id, provider)`.

### Icons

Use `contributes.iconPacks` for runtime SVG packs.
Prefer runtime registration over file-path SVG declarations.

### Skills

Set `contributes.skills: true` when shipping bundled Skills inside the mini tool.

### MCP servers

Use `contributes.mcpServers` only when the mini tool needs to inject declarative MCP server definitions into the MCP bridge.

## 5. Permissions

Permissions are opt-in. Request only what the mini tool truly needs.

- `filesystem`: `none` / `read` / `readonly` / `readwrite`
- `network`: boolean
- `shell`: boolean
- `secrets`: string[]

Start with the least privileged setting.

## 6. Installation and publishing

- Personal install path: `<finchHome>/.finch/extensions/<id>/`
- Global install path: `~/.finch/extensions/<id>/`
- Use `npx @finchtoys/minitools add|update|remove|list|doctor`
- Do not use a project-level install path
- Publish as a normal npm package if you want `add <package-name>` support

## 7. i18n

Recommended layout:

```text
my-mini-tool/
├── i18n/
│   ├── zh-CN.json
│   └── en-US.json
└── package.json
```

Rules:

- Put default strings in `package.json#finch`
- Put locale overrides in `i18n/<locale>.json`
- Do not localize ids, tool names, command ids, or capability names

## 8. Practical checklist

Before shipping:

1. Confirm the manifest id and install path.
2. Verify the compiled entry exists.
3. Run `npx @finchtoys/minitools doctor .`.
4. Install with the official CLI.
5. Enable the mini tool in Finch.
