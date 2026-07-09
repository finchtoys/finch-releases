# References

This is the detailed reference area for Finch mini tools. The main guide should stay focused on getting started; this section should cover how to write things correctly and completely.

## Current reference files

- [`finch.d.ts`](./finch.d.ts) — full type definitions and JSDoc annotations; the source of truth for the API
- New mini tools should import types from `@finch.app/minitool-api`, not from a local Finch repo checkout or an environment-specific path.
- [`manifest.md`](./manifest.md) — manifest authoring, permissions, install, publish, version gating
- [`tools.md`](./tools.md) — Agent tools, schema, execution context, forms, risk levels
- [`composer-actions.md`](./composer-actions.md) — Composer buttons, menu behavior, grouping, submenus
- [`ui.md`](./ui.md) — Toasts, dialogs, Canvas Window, and other UI interactions
- [`icons.md`](./icons.md) — built-in icons, runtime packs, `IconRef`, SVG rules
- [`capabilities.md`](./capabilities.md) — `ctx.capabilities` provide/get, versioning, collaboration
- [`mcp.md`](./mcp.md) — MCP contributions, bridge behavior, tool naming, and debugging notes
- [`publish.md`](./publish.md) — packaging for npm, `.npmignore` / `files` best practices, versioning, and community listing via finch-releases

## How to use this section

1. Read `SKILL.md` for the quick start and the high-level rules.
2. Use the topic files above when you need a specific area.
3. Use `finch.d.ts` to confirm the exact signatures and full type surface.
4. If a topic is still too broad, split it into a narrower file and add it here.

## Maintenance rules

- Keep the main guide short.
- Keep topic docs practical and example-driven.
- Split any topic that grows beyond a screen.
- Keep `finch.d.ts` complete; use topic docs to explain intent and usage.
