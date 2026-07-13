# Finch Releases

This repository is the public release hub for [Finch](https://finchwork.app/). It hosts Finch release assets, official extension source code, and the community registries used by the Finch app and community website.

## About this repository

The repository contains:

- **GitHub Releases** — public Finch desktop app releases and downloadable assets.
- **`extensions/`** — source code for official Finch extensions.
- **`community/`** — recommended community extension and skill registries.
- **`skills/`** — Finch skill configuration and documentation.
- **`packages/`** — official npm packages and CLI tools.
- **`docs/`** — Finch user and developer documentation.

> Finch extensions are also called mini tools. In Finch documentation, use **extension** as the unified term.

## Submit your mini tool

Want to make your extension discoverable in Finch? Publish it, then submit it to the community registry.

1. Publish the extension to npm, or make its GitHub repository publicly downloadable.
2. Fork this repository.
3. Add an entry to [`community/mini-tools.json`](community/mini-tools.json), ordered alphabetically by `id`.
4. Add the matching Chinese display text to [`community/mini-tools.zh-CN.json`](community/mini-tools.zh-CN.json).
5. Open a Pull Request with a short description of your extension.

Each entry in `mini-tools.json` must include:

```json
{
  "id": "my-extension",
  "version": "1.0.0",
  "name": "My Extension",
  "author": "Your name or organization",
  "description": "A concise description of what the extension does.",
  "repo": "owner/repository",
  "npm": "@scope/my-extension",
  "extensionType": "community",
  "categories": ["productivity"]
}
```

The Chinese override contains only the translated user-facing fields:

```json
{
  "id": "my-extension",
  "name": "我的扩展",
  "description": "扩展功能的简短说明。"
}
```

Before opening a Pull Request, ensure that the `id` matches your extension identifier, `version` is current, the entry has at least one valid category, and both registry files remain alphabetically ordered. `featured` is reserved for curated recommendations.

Available categories: `productivity`, `developer`, `creative`, `research`, `finance`, `commerce`, and `education`.

## How community mini tools are pulled

Finch does not bundle every community extension into the app. Instead, it pulls the recommended registry at runtime:

```text
finchtoys/finch-releases
  └── community/mini-tools.json
  └── community/mini-tools.zh-CN.json
            ↓
community.finchwork.app (Cloudflare Worker, cached for about 1 hour)
            ↓
Finch app and community website
```

- `mini-tools.json` is the English source registry and contains complete extension metadata.
- `mini-tools.zh-CN.json` provides Chinese `name` and `description` overrides matched by `id`.
- When an override is unavailable, Finch falls back to the English metadata.
- Registry updates are published through `community.finchwork.app`; they can take up to about one hour to appear because of edge caching.
- Selecting an extension in Finch directs installation through its published npm package or public source.

## Release sync

Use [`.github/workflows/sync-releases.yml`](.github/workflows/sync-releases.yml) to manually mirror GitHub Releases from another repository into this one.

Recommended one-off inputs:

- `source_repo`: `puterjam/finch`
- `target_repo`: `finchtoys/finch-releases`
- `include_drafts`: `false`
- `overwrite_assets`: `false`
- `overwrite_body`: `false`
- `skip_existing_releases`: `true`
- `max_releases`: `0`
