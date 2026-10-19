# Finch Agent

[English](README.md) · **简体中文**

**Finch Agent 是一款轻量的桌面 AI Agent，支持 macOS 与 Windows。**

你用自然语言与它协作。它会读取并处理你授权的本机文件，跨会话保留上下文，并通过
扩展（小程序）、技能和 MCP 集成不断扩展能力。基于开源项目
[Pi](https://pi.dev/) 构建。

[下载](https://finchwork.app/zh/downloads) ·
[文档](https://finchwork.app/zh/docs) ·
[更新日志](https://finchwork.app/zh/changelog) ·
[finchwork.app](https://finchwork.app/)

![home](https://raw.githubusercontent.com/finchtoys/finch-releases/main/home.webp)

| | |
|---|---|
| 平台 | macOS（Apple Silicon 与 Intel）、Windows 10、Windows 11 |
| 价格 | 桌面应用永久免费。云服务与模型 token 单独计费。 |
| 模型 | 13+ 云端模型供应商，同时支持本地模型——API Key 由你自己提供 |
| 扩展能力 | 小程序、技能、MCP server |
| 界面语言 | 简体中文、English |

## 关于本仓库

本仓库是 Finch Agent 的公开发布中心，托管 Finch 的发布产物、官方扩展源码，以及
Finch 应用和社区网站使用的社区索引。

仓库包含：

- **GitHub Releases** —— Finch 桌面应用的正式版本与可下载安装包。
- **`extensions/`** —— 官方 Finch 扩展的源码。
- **`community/`** —— 社区推荐扩展与技能索引。
- **`skills/`** —— Finch 技能配置与文档。
- **`docs/`** —— Finch 用户文档与开发者文档。

> Finch 扩展也叫小程序（mini tool）。在 Finch 文档中统一使用**扩展**这一术语。

## 小工具发布检查清单

把扩展发布到 npm 之前，先执行：

```bash
npm run typecheck
npx @finchtoys/minitools doctor .
npm run build
```

然后确认：

- `package.json#version` 按 SemVer 提升，`finch.id` 保持稳定。
- npm 包只包含 `dist/`、必需资源、`README.md` 和 `package.json`；排除 `src/`、测试、构建配置以及所有 `.env` 文件。
- `prepublishOnly` 会执行构建，且 `@finchtoys/minitool-api` 是仅类型的 `devDependency`。
- 包发布成功，并可以用 `npx @finchtoys/minitools add <package>` 安装。
- 社区投稿需在包根目录提供已发布的 `icon.png`（PNG，128–300 px）。

包结构、npm 发布、社区上架与维护要求见[完整的小工具发布指南](skills/finch-mini-tool-creator/reference/publish.md)。

## 提交你的小工具

希望自己的扩展能在 Finch 里被发现？先发布，再申请上架——社区索引（`community/mini-tools.json` 与 `community/mini-tools.zh-CN.json`）由 Finch 团队维护，请**不要直接开 Pull Request 修改这两个文件**。

1. 把扩展发布到 npm，或让它的 GitHub 仓库可以公开下载。
2. 确认满足上面的[发布检查清单](#小工具发布检查清单)，包含合规的 `icon.png`。
3. [开一个 Issue](https://github.com/finchtoys/finch-releases/issues/new)，打上 `minitool` 标签，参照 [issue #22](https://github.com/finchtoys/finch-releases/issues/22) 的格式，并提供：
   - npm 包名（或 GitHub `repo`）
   - `finch.id`（扩展标识）
   - 当前 `version`
   - 简短的英文描述（有中文翻译一并给出）
   - 确认已包含 `icon.png` 且尺寸符合要求
   - 声明的权限（`filesystem`、`network`、`shell` 等）
   - 建议的分类（见下方列表）

Finch 团队会审核申请，并代你写入 `mini-tools.json` / `mini-tools.zh-CN.json`。

可用分类：`productivity`（效率）、`developer`（开发）、`creative`（创意）、`research`（研究）、`finance`（金融）、`commerce`（电商）、`education`（教育）。

## 社区小工具如何被拉取

Finch 不会把每个社区扩展都打进安装包，而是在运行时拉取推荐索引：

```text
finchtoys/finch-releases
  └── community/mini-tools.json
  └── community/mini-tools.zh-CN.json
            ↓
Finch Toolbox
```

- `mini-tools.json` 是英文源索引，包含完整的扩展元数据。
- `mini-tools.zh-CN.json` 按 `id` 提供中文 `name` 与 `description` 覆盖。
- 没有对应中文覆盖时，Finch 回退到英文元数据。
- 索引更新通过 `community.finchwork.app` 发布，由于边缘缓存，最长约一小时后生效。
- 在 Finch 里选择某个扩展后，安装会走它已发布的 npm 包或公开源码。

## 加入社区

Finch 有一个微信用户群 **Finch 与她的小伙伴**——提问、聊小程序点子、报 bug 都可以来这里。用微信扫码加入。

<div align="center">
  <img src="https://raw.githubusercontent.com/finchtoys/finch-releases/main/wechat-group.webp" alt="Finch 微信用户群二维码" width="240" />
</div>

微信群邀请 7 天过期。如果上面的二维码已经失效，请[开一个 issue](https://github.com/finchtoys/finch-releases/issues)，我们会更新它。
