# Finch

**A lightweight, easy-to-use desktop AI agent for macOS and Windows.**

You work with Finch in natural language. It reads and processes local files you
authorize, remembers context across sessions, and extends through mini tools,
skills, and MCP integrations. Built on the open source project
[Pi](https://pi.dev/).

[Download](https://finchwork.app/en/downloads) ·
[Docs](https://finchwork.app/en/docs) ·
[Changelog](https://finchwork.app/en/changelog) ·
[finchwork.app](https://finchwork.app/)

![home](https://raw.githubusercontent.com/finchtoys/finch-releases/main/home.webp)

| | |
|---|---|
| Platforms | macOS (Apple Silicon and Intel), Windows 10, Windows 11 |
| Price | The desktop app is free, permanently. Cloud services and model tokens are billed separately. |
| Models | 13+ cloud model providers, plus local models — you supply your own API key |
| Extensibility | Mini tools, skills, MCP servers |
| Interface languages | Simplified Chinese, English |
| Built on | [Pi](https://pi.dev/) |

## About this repository

This repository is the public release hub for Finch. It hosts Finch release
assets, official extension source code, and the community registries used by the
Finch app and community website.

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

Want to make your extension discoverable in Finch? Publish it, then request a listing — the community registry (`community/mini-tools.json` and `community/mini-tools.zh-CN.json`) is maintained by the Finch team, so please **do not open a Pull Request editing these files directly**.

1. Publish the extension to npm, or make its GitHub repository publicly downloadable.
2. Make sure it meets the [publishing checklist](#mini-tool-publishing-checklist) above, including a valid `icon.png`.
3. [Open an Issue](https://github.com/finchtoys/finch-releases/issues/new) with the `minitool` label, following the format of [issue #22](https://github.com/finchtoys/finch-releases/issues/22), and include:
   - npm package name (or GitHub `repo`)
   - `finch.id` (the extension identifier)
   - current `version`
   - a short English description (and Chinese translation if available)
   - confirmation that `icon.png` is included and meets the size requirement
   - declared permissions (`filesystem`, `network`, `shell`, etc.)
   - a suggested category from the list below

The Finch team will review the request and add the entry to `mini-tools.json` / `mini-tools.zh-CN.json` on your behalf.

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
