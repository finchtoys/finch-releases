# Finch Community Extensions

This directory powers **community.finchwork.app** — the recommended extension registry for the Finch app.

## How it works

```
finchtoys/finch-releases (GitHub)
  └── community/extensions.json        ← English fallback registry
  └── community/extensions.zh-CN.json  ← optional Chinese overrides
          ↓  (Cloudflare Worker proxies + caches)
  community.finchwork.app/extensions.json        ← Finch app fetches this
  community.finchwork.app/extensions.zh-CN.json  ← Finch app fetches this for zh-CN overrides
```

The Cloudflare Worker (`worker.js`) caches the JSON at the edge for 1 hour, so GitHub rate limits are never a concern for end users.

## extensions.json format

Each entry in `extensions.json` is an object with these fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✅ | Unique extension id (matches `package.json#finch.id`) |
| `name` | string | ✅ | Display name shown in Finch |
| `author` | string | ✅ | Author name or org |
| `description` | string | ✅ | One-line description |
| `repo` | string | ✅ | GitHub `owner/repo` (for source / issues link) |
| `npm` | string | — | npm package name — enables `npx @finchtoys/minitools add <npm>` one-click install |
| `extensionType` | `"official"` \| `"community"` | — | Defaults to `"community"` |
| `featured` | boolean | — | When `true`, the item appears under Featured. Defaults to `false`. |
| `categories` | string[] | — | Used for category filters in the Finch marketplace. Use a category id from `categories.json` (see [Categories](#categories)). |

### Example

```json
[
  {
    "id": "mcp-bridge",
    "name": "MCP Bridge",
    "author": "Finch Team",
    "description": "Connect MCP servers and expose their tools to the Finch agent.",
    "repo": "finchtoys/finch-releases",
    "npm": "@finchtoys/mcp-bridge",
    "extensionType": "official",
    "featured": true,
    "categories": ["developer"]
  },
  {
    "id": "my-community-ext",
    "name": "My Extension",
    "author": "yourname",
    "description": "Does something useful.",
    "repo": "yourname/my-finch-extension",
    "npm": "@yourname/finch-extension-my",
    "extensionType": "community",
    "featured": false,
    "categories": ["productivity"]
  }
]
```

## Adding your extension

1. Fork `finchtoys/finch-releases`.
2. Add your entry to `community/extensions.json` (append to the array, keep alphabetical by `id`).
3. Open a Pull Request — the team will review and merge.

**Requirements before submitting:**
- The extension must be published on npm (so users can install via `npx @finchtoys/minitools add <npm>`), or have a public GitHub repo with a downloadable zip.
- `package.json#finch.id` must match the `id` field here.
- Description must be in English.
- Use `featured: true` only for curated items that should appear in Featured.
- Every community item should have at least one `categories` entry so it can be discovered through category filters.

## Featured and Categories

- Featured shows only items with `featured: true`.
- Category filters show all items in that category, whether or not they are featured.
- Items without `categories` do not appear under any category. Finch does not auto-assign a fallback category.

## Categories

The category list lives in [`categories.json`](categories.json) next to the catalogs — it is **the** source of truth for which filters exist, their display order, and their labels for every language. Adding or renaming a category is a registry change; app versions pick it up without a new release.

```json
{
  "schemaVersion": 1,
  "categories": [
    { "id": "games", "labels": { "en-US": "Games", "zh-CN": "游戏", "zh-HK": "遊戲" } }
  ]
}
```

- Array order is display order — the app does not sort.
- `labels` is optional per category. Supported keys today are `en-US`, `zh-CN`, and `zh-HK`; a client that has no label for the active language falls back to `zh-CN` (for zh-HK), then to `default`/`en-US`, then to the raw id. Categories that shipped with the app also fall back to built-in translations.
- Ids must match `^[a-z0-9][a-z0-9-]{0,31}$`; duplicates are ignored after the first.
- A category with no listed items simply shows no filter chip, so declaring one ahead of time is safe.

Current ids (as of this commit):

| id | zh-CN | zh-HK | en-US | Scope |
|---|---|---|---|---|
| `productivity` | 效率 | 效率 | Productivity | 办公文档、日常效率 |
| `developer` | 开发 | 開發 | Developer | 编码、扩展开发、API |
| `creative` | 创意 | 創意 | Creative | 设计、主题、内容创作 |
| `games` | 游戏 | 遊戲 | Games | 游戏、娱乐 |
| `research` | 研究 | 研究 | Research | 数据分析、信息提取 |
| `finance` | 财务 | 財務 | Finance | 财务、记账、报表 |
| `commerce` | 电商 | 電商 | Commerce | 电商、商品、订单 |
| `education` | 教育 | 教育 | Education | 学习、课件、教学辅导 |

## Locale overrides

Keep the main registry files in English:

- `extensions.json`
- `skills.json`

For translated display text, add optional locale override files:

- `extensions.zh-CN.json`
- `skills.zh-CN.json`

Override entries are matched by `id` and should only include translated user-facing fields:

```json
[
  {
    "id": "mcp-bridge",
    "name": "MCP 桥接",
    "description": "连接 Model Context Protocol 服务，并把它们的工具暴露给 Finch Agent。"
  }
]
```

If an override file or field is missing, Finch falls back to the English `name` and `description` in the main registry.