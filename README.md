![home](https://raw.githubusercontent.com/finchtoys/finch-releases/refs/heads/main/home.jpg)

# Finch Mini Tools Releases

This repository is the public release hub for [Finch](https://finchwork.app/). It hosts Finch release assets, official extension source code, and the community registries used by the Finch app and community website.

## About this repository

The repository contains:

- **GitHub Releases** — public Finch desktop app releases and downloadable assets.
- **`extensions/`** — source code for official Finch extensions.
- **`community/`** — recommended community extension and skill registries.
- **`skills/`** — Finch skill configuration and documentation.
- **`docs/`** — Finch user and developer documentation.

> Finch extensions are also called mini tools. In Finch documentation, use **extension** as the unified term.

## Mini tool publishing checklist

Before publishing an extension to npm, run:

```bash
npm run typecheck
npx @finchtoys/minitools doctor .
npm run build
```

Then verify that:

- `package.json#version` is bumped using SemVer and `finch.id` is stable.
- The npm package includes `dist/`, required assets, `README.md`, and `package.json` only; exclude `src/`, tests, build configuration, and every `.env` file.
- `prepublishOnly` runs the build, and `@finchtoys/minitool-api` is a types-only `devDependency`.
- The package is published successfully and can be installed with `npx @finchtoys/minitools add <package>`.
- Community submissions include a published `icon.png` at the package root (PNG, 128–300 px).

See the [complete mini tool publishing guide](skills/finch-mini-tool-creator/reference/publish.md) for package layout, npm release, community listing, and maintenance requirements.

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
Finch Toolbox
```

- `mini-tools.json` is the English source registry and contains complete extension metadata.
- `mini-tools.zh-CN.json` provides Chinese `name` and `description` overrides matched by `id`.
- When an override is unavailable, Finch falls back to the English metadata.
- Registry updates are published through `community.finchwork.app`; they can take up to about one hour to appear because of edge caching.
- Selecting an extension in Finch directs installation through its published npm package or public source.
