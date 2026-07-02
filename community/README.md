# Finch Community Extensions

This directory powers **community.finchwork.app** — the recommended extension registry for the Finch app.

## How it works

```
finchtoys/finch-releases (GitHub)
  └── community/extensions.json   ← you edit this
          ↓  (Cloudflare Worker proxies + caches)
  community.finchwork.app/extensions.json  ← Finch app fetches this
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
| `npm` | string | — | npm package name — enables `npx @finch.app/extensions add <npm>` one-click install |
| `extensionType` | `"official"` \| `"community"` | — | Defaults to `"community"` |
| `categories` | string[] | — | Used for filtering in the Finch extension marketplace |

### Example

```json
[
  {
    "id": "mcp-bridge",
    "name": "MCP Bridge",
    "author": "Finch Team",
    "description": "Connect MCP servers and expose their tools to the Finch agent.",
    "repo": "finchtoys/finch-releases",
    "npm": "@finch.app/mcp-bridge",
    "extensionType": "official",
    "categories": ["mcp", "developer-tools"]
  },
  {
    "id": "my-community-ext",
    "name": "My Extension",
    "author": "yourname",
    "description": "Does something useful.",
    "repo": "yourname/my-finch-extension",
    "npm": "@yourname/finch-extension-my",
    "extensionType": "community",
    "categories": ["productivity"]
  }
]
```

## Adding your extension

1. Fork `finchtoys/finch-releases`.
2. Add your entry to `community/extensions.json` (append to the array, keep alphabetical by `id`).
3. Open a Pull Request — the team will review and merge.

**Requirements before submitting:**
- The extension must be published on npm (so users can install via `npx @finch.app/extensions add <npm>`), or have a public GitHub repo with a downloadable zip.
- `package.json#finch.id` must match the `id` field here.
- Description must be in English.

## Cloudflare Worker setup

To deploy `worker.js` to Cloudflare:

1. Go to **Cloudflare Dashboard → Workers & Pages → Create**.
2. Choose **"Deploy a Worker"** → paste the contents of `worker.js`.
3. Under **Settings → Variables → Secret variables**, add:
   - Name: `GITHUB_TOKEN`
   - Value: a GitHub fine-grained PAT with **read-only access to public repositories**
     (GitHub → Settings → Developer settings → Fine-grained tokens → New token →
     Repository access: `finchtoys/finch-releases` → Contents: Read-only)
4. Under **Settings → Triggers → Custom Domains**, add `community.finchwork.app`.

> **Why a token?** Cloudflare Workers share a small pool of outbound IPs. Without auth,
> GitHub Raw allows only 60 requests/hour per IP — easy to hit. With a token, the limit
> is 5,000 requests/hour, and the 1-hour edge cache means real traffic never comes close.

The Worker pulls from the `main` branch. After a PR is merged, the new data is live within 1 hour (next cache expiry).
