# PJBlog For Finch

Write blog posts together with AI — markdown writing, static site generation, live preview while writing, and one-click publish to GitHub Pages.

> 和 AI 一起写日志 —— Markdown 写作、静态博客生成、边写边实时预览、一键发布到 GitHub Pages。

## Install

PJBlog For Finch is a **Finch mini tool**. Download Finch from [finchwork.app](https://finchwork.app/), then open **Toolcase → Mini Tools** in the Finch app and add the npm package:

```text
finch-pjblog
```

After enabling it, ask Finch to initialize a blog or use the notebook button in the Composer.

## Features

- **Blog scaffolding** — `pjblog_init` opens a form (title / author / theme / directory) and creates a full blog workspace: `posts/`, `pages/`, `assets/`, `themes/`, `blog.config.json`, an `AGENTS.md` writing guide, a welcome post, `.gitignore`, a GitHub Pages workflow, and `git init` with a first commit.
- **Write with AI** — `pjblog_new_post` creates a post file with proper frontmatter; Finch writes the content with you in plain markdown.
- **Static site generator** — `pjblog_build` renders home, post pages, year-grouped archive, tag pages, standalone pages, RSS, sitemap and 404 from mustache-style theme templates. Zero external dependencies.
- **Live preview** — `pjblog_preview` starts a local server with file watching + SSE auto-reload: edit a post (you or the AI) and the browser refreshes itself. Drafts are visible with a badge in preview and excluded from publish.
- **Composer menu** — the toolbar button shows a localized previewing state, with start/stop/open actions and shortcuts for writing and publishing.
- **One-click publish** — `pjblog_publish` is two-phase: first call returns a change summary for user confirmation; with `confirm=true` it rebuilds (no drafts), commits and pushes. The bundled GitHub Actions workflow deploys `public/` to GitHub Pages automatically.
- **4 built-in themes** — all copied into the blog's `themes/` directory so they can be freely customized:
  | id | Style |
  |---|---|
  | `plain` | 素笺 · minimal light, serif, whitespace-first |
  | `nocturne` | 夜航 · pure black & white dark, monospace accents |
  | `journal` | 胶片 · warm paper, magazine cards |
  | `pjblog-classic` | 经典 PJBlog · tribute to the classic PJBlog 2.x blue two-column layout |

## Tools

| Tool | Purpose |
|---|---|
| `pjblog_init` | Scaffold a new blog workspace (form-driven) |
| `pjblog_new_post` | Create a markdown post with frontmatter |
| `pjblog_build` | Generate the static site into `public/` |
| `pjblog_preview` | Start/stop/open the live preview server |
| `pjblog_publish` | Two-phase build + git commit + push |
| `pjblog_theme` | List / switch themes |
| `pjblog_status` | Workspace overview (posts, git, preview) |
| `pjblog_manage` | List, bind or unbind entries in the private “My Blogs” registry; does not delete files |

## Blog workspace layout

```
my-blog/
├── blog.config.json      # site config (title, theme, publish mode…)
├── AGENTS.md             # writing rules for Finch in this Space
├── posts/YYYY/           # markdown posts: YYYY-MM-DD-slug.md
├── pages/                # standalone pages (about.md …)
├── assets/               # images and other resources
├── themes/<id>/          # templates: index/post/archive/page.html + style.css
├── public/               # build output (do not edit)
└── .github/workflows/    # GitHub Pages deploy workflow
```

Post frontmatter:

```markdown
---
title: My first post
date: 2026-07-11
tags: [life, notes]
summary: optional one-liner
draft: true
---
```

## Permissions / 权限说明

- `filesystem: write` — scaffold the blog, write posts and build output inside the blog directory.
- `shell: true` — runs `git` for version control and publishing, and opens the preview URL in the default browser. No other commands are executed.
- `network: false` — the extension itself makes no network requests; pushing uses the local `git` credential setup.

## 中文说明

这是 Finch 的小工具。请先从 [finchwork.app](https://finchwork.app/) 下载 Finch，然后在 App 的「工具箱 → 小工具」中添加 npm 包 `finch-pjblog` 并启用。

安装后对 Finch 说「帮我初始化一个博客」即可开始。日常流程：

1. **写作** — 「帮我写一篇关于 XX 的日志」，Finch 创建带 frontmatter 的 md 文件并陪你写作；
2. **预览** — 「开启预览」，浏览器自动打开本地站点，你或 AI 每次保存文件都会自动重建并刷新页面；草稿带「草稿」角标；
3. **发布** — 「发布博客」，先展示变更摘要，确认后自动构建（排除草稿）、commit、push，GitHub Pages 工作流自动部署。

建议初始化后把博客目录绑定为一个 Finch Space，写作会话即拥有独立的空间规则（`AGENTS.md`）。

## License

MIT
