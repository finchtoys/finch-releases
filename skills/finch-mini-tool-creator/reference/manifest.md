# Manifest

This document explains how to author the manifest for a Finch mini tool.

## 0. Manifest file: `finch.json` vs `package.json#finch`

The manifest can live in one of two places (checked in this order):

| Priority | File | Notes |
|---|---|---|
| 1st | `finch.json` (same directory as `package.json`) | **Recommended for new mini tools.** The file IS the manifest directly — no `finch` wrapper key. |
| 2nd | `package.json#finch` | Legacy approach. Fields are nested under a `finch` key inside `package.json`. |

When `finch.json` is present, `package.json#finch` is ignored.

**Field inheritance from `package.json`** (only when `finch.json` omits the field):

- `id` ← `name`
- `name` / `displayName` ← `name`
- `description` ← `description`
- `main` ← `main`
- `version` is always inherited from `package.json`; without it, defaults to `0.0.0`

Example — standalone `finch.json` with no package.json dependency:

```json
{
  "manifestVersion": 1,
  "id": "my-mini-tool",
  "name": "My Mini Tool",
  "main": "dist/index.js",
  "activationEvents": ["onStartup"],
  "contributes": {
    "tools": true
  }
}
```

Example — `finch.json` relying on `package.json` for `version` and `description` (both fields omitted here, inherited from `package.json`):

```json
{
  "manifestVersion": 1,
  "id": "my-mini-tool",
  "name": "My Mini Tool",
  "main": "dist/index.js",
  "activationEvents": ["onStartup"],
  "contributes": {
    "tools": true
  }
}
```

`package.json` in the same directory then supplies the missing fields:

```json
{
  "name": "my-mini-tool",
  "version": "1.2.0",
  "description": "Does something useful."
}
```

All other sections in this document apply to both `finch.json` and `package.json#finch` equally.

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

### Session containers

Bot, remote, and Agent mini tools that use `ctx.sessions` must declare the containers they can create. `finch.json` (recommended) form:

```json
{
  "manifestVersion": 1,
  "id": "my-mini-tool",
  "name": "My Mini Tool",
  "main": "dist/index.js",
  "activationEvents": ["onStartup"],
  "contributes": {
    "sessionContainers": [
      { "id": "inbox", "icon": "message-circle", "title": "Bot Inbox" },
      {
        "id": "concierge-chat",
        "icon": "users",
        "title": "Travel Concierge",
        "mode": "assistant",
        "agentProfile": "concierge"
      }
    ],
    "agentProfiles": [
      {
        "id": "concierge",
        "name": "Travel Concierge",
        "description": "Patient trip-planning specialist",
        "prompt": "You are a patient travel concierge. Give practical, structured advice."
      }
    ]
  },
  "permissions": { "sessions": true }
}
```

`containerId` is only valid within the current mini tool's own namespace; the runtime cannot create undeclared containers or access Sessions owned by other mini tools or users.

Container `mode` decides the home-screen interaction shape (defaults to `inbox` when omitted):

- `inbox`: Bot / multi-agent aggregation. Sessions are initiated by the mini tool; the home screen shows a session list with no "new session" entry, and supports a container-level default model (the user picks it from the container row's menu).
- `assistant`: Industry-scenario assistant. The user actively starts conversations; the home screen shows a role introduction and starter prompts, hides container model selection, and **must** bind `agentProfile` (referencing an id declared in `contributes.agentProfiles`; new sessions automatically apply that role's prompt).

`icon` follows the same `IconRef` strategy as ComposerAction: use a Finch built-in id directly (e.g. `"message-circle"`, `"users"`), or reference a runtime SVG (e.g. `"ext:agent-logo"` or `"ext:my-icons/agent-logo"`). Custom SVGs still require declaring `contributes.iconPacks` first and registering via `ctx.icons.register()` in `activate()`. Omitted icons fall back to `bot`.

`title` / `description` can be a `LocalizedString` directly, or overridden per container id in a locale file:

```json
{
  "sessionContainers": {
    "inbox": {
      "title": "Bot Inbox",
      "description": "Conversations coming from the external platform"
    }
  }
}
```

Container entries immediately pick up the matching `i18n/<locale>.json` copy after the Finch App language is switched. Container sessions with `activity: "background"` do not trigger a system notification when they complete or wait; they only show a reminder dot on the owning container entry.

Users can pick the container's default model from the container row's menu. New sessions created via `ctx.sessions.create({ containerId })` then automatically use that model; if none is chosen or the model is unavailable, it falls back to the Finch global default. The mini tool does not need to — and cannot — read or override this user preference in code. Sessions created into a `space` do not use a container model.

When creating a Session, reference a statically declared Agent role via `profileId: "concierge"`. The profile prompt is stored as a supplemental snapshot on top of Finch's base system prompt; it cannot replace safety rules or elevate permissions, and the runtime cannot pass an arbitrary system prompt directly.

## 5. Permissions

Permissions are opt-in. Request only what the mini tool truly needs.

| Permission | Values | Purpose |
|---|---|---|
| `filesystem` | `none` / `read` / `readwrite` | Local file access. Default to `none` or `read`. |
| `network` | `boolean` | Outbound network requests. |
| `shell` | `boolean` | Shell command execution. |
| `secrets` | `string[]` | Named secrets the mini tool may read via `ctx.secrets`. |
| `oauth` | `string[]` | OAuth provider ids allowed through `ctx.oauth`. |
| `sessions` | `boolean` | Create owner-scoped Sessions and exchange messages via `ctx.sessions`. |

Start with the least privileged setting. OAuth access is brokered and stored per mini tool; see `oauth.md`. Session permissions require a matching `contributes.sessionContainers` declaration; see `session.md`.

## 6. Settings

Use `finch.settings` to declare user-configurable options that Finch renders natively in the Toolcase detail page. The mini tool reads them via `ctx.settings.get(key)` (read-only); Finch persists the values and reloads the mini tool after the user saves.

```json
{
  "finch": {
    "settings": {
      "fields": [
        { "key": "endpoint", "type": "string", "label": "Endpoint", "placeholder": "https://api.example.com" },
        { "key": "maxItems", "type": "number", "label": "Max items", "default": 10 },
        { "key": "includeDrafts", "type": "boolean", "label": "Include drafts", "default": false },
        { "key": "region", "type": "select", "label": "Region", "options": [{ "value": "us", "label": "US" }, { "value": "eu", "label": "EU" }], "default": "us" },
        {
          "key": "rules",
          "type": "list",
          "label": "Rules",
          "itemFields": [
            { "key": "pattern", "type": "string", "label": "Pattern" },
            { "key": "action", "type": "select", "label": "Action", "options": [{ "value": "allow", "label": "Allow" }, { "value": "deny", "label": "Deny" }] }
          ]
        }
      ]
    }
  }
}
```

All `label` and `description` fields support `LocalizedString`. Field types: `string`, `number`, `boolean`, `select`, `list`. A `string` may be marked `secret: true` for a password input, or `multiline: true` for a textarea. `list` rows are built from scalar item fields only — nested lists are not supported.

## 7. Capabilities

Use `finch.provides` and `finch.requires` for cross-extension collaboration. Names must match the strings passed to `ctx.capabilities.provide()` and `ctx.capabilities.get()`. Only names in `requires` may be fetched; only names in `provides` may be registered.

```json
{
  "finch": {
    "provides": { "capabilities": ["my.feature"] },
    "requires": { "capabilities": ["mcp.client"] }
  }
}
```

See `capabilities.md` for usage rules.

## 8. Other useful fields

- `categories` — catalog categories (array of strings).
- `privacyPolicyUrl` / `termsOfServiceUrl` — links shown in the Toolcase detail view.
- `promptGuides` — cards on the detail page that pre-fill the Home Composer.
- `toolMeta.name` — short tool-bar name override for the mini tool.
- `autoEnable` — only for bundled official mini tools; default `true`. Set to `false` when the tool requires user configuration before it can work (e.g. MCP Client).
- `activationEvents` — currently only `onStartup` is supported; lazy activation events are not yet implemented.

## 9. Installation and publishing

- Personal install path: `<finchHome>/.finch/extensions/<id>/`
- Global install path: `~/.finch/extensions/<id>/`
- Use `npx @finchtoys/minitools add|update|remove|list|doctor`
- Do not use a project-level install path
- Publish as a normal npm package if you want `add <package-name>` support

## 10. i18n

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

## 11. Practical checklist

Before shipping:

1. Confirm the manifest id and install path.
2. Verify the compiled entry exists.
3. Run `npx @finchtoys/minitools doctor .`.
4. If you use `ctx.sessions`, read `session.md` and verify `contributes.sessionContainers` and `permissions.sessions` are declared.
5. If you use `ctx.settings`, verify the schema in `finch.settings`.
6. Install with the official CLI.
7. Enable the mini tool in Finch.
