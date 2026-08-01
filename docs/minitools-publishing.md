---
title: 发布小工具到社区
summary: 将小工具发布到 npm 和 Finch 社区
order: 130
label: 小工具开发
---

# 发布小工具到社区

本文假设你已经按《[小工具开发指南](mini-tool-developer-guide.md)》（尤其是 §10 调试、安装与发布）写好了一个能在本地跑通的小工具。这里只讲**从「本地能跑」到「所有 Finch 用户都能一键安装」**要走的路：打包、发 npm、（可选）提交进 Finch 官方社区目录。构建、`doctor` 静态检查、常见踩坑等本文不再重复，参见开发指南 §10.1–10.3。

## 发布模型

先理解三层关系，剩下的步骤都是围绕它们展开的：

1. **npm 是唯一的分发渠道**。小工具是标准的 npm 包，`package.json#finch`（或 `finch.json`）是它和普通 npm 包的唯一区别。发布到 npm 之后，任何人都可以用 `npx @finchtoys/minitools add <包名>` 安装，这一步**不需要 Finch 官方审核**。
2. **社区目录是可选的"推荐位"，不是安装的前提**。目录数据是 `finchtoys/finch-releases` 仓库里的一份 JSON（`community/mini-tools.json`），由 `community.finchwork.app` 提供边缘缓存后的公开只读 API，Finch 客户端的"社区推荐"面板直接读取它渲染卡片列表。没有进这份 JSON 的包，用户仍然可以通过包名手动安装，只是不会出现在推荐列表里。
3. **图标走 npm 包本身，不需要单独上传**。Finch 展示未安装社区条目的图标时，直接拼 `https://unpkg.com/<npm包名>@<version>/icon.png` 去读——所以 `icon.png` 必须随包一起发布到 npm 根目录，而不是只存在于你的仓库里。

## 1. 发布前检查

在开发指南 §10.2 调试流程的基础上，发布前再确认一遍：

```bash
npm run typecheck                   # 无 TypeScript 报错
npx @finchtoys/minitools doctor .   # manifest / 入口文件静态校验
npm run build                       # dist/ 是最新的
```

`package.json#version` 遵循 semver，每次发布前手动 bump 或用 `npm version patch/minor/major`。

## 2. npm 包只放运行时需要的东西

**不要发布源码。** 用 `package.json#files` 做白名单（推荐）或 `.npmignore` 做黑名单：

```json
{
  "files": [
    "dist/",
    "i18n/",
    "skills/",
    "icons/",
    "icon.png",
    "README.md"
  ]
}
```

| 路径 | 要不要发 | 原因 |
|---|---|---|
| `dist/` | ✅ 必须 | 编译后的运行时入口 |
| `icon.png` | ✅ 必须 | 社区目录展示图标，来自 npm 包本身（见上文） |
| `i18n/` / `skills/` / `icons/` | ✅ 视情况 | 有对应功能才需要 |
| `README.md` | ✅ 推荐 | npm 页面和社区卡片详情都会展示 |
| `src/`、`tsconfig.json`、测试代码、`.env*` | ❌ 不要 | 运行时不需要；`.env*` 尤其不能带密钥 |

## 3. 发布到 npm

```bash
npm login
npm publish --access public   # scoped 包必须带 --access public
```

发布后任何人都可以：

```bash
npx @finchtoys/minitools add <你的包名>
```

更新版本：

```bash
npm version patch   # 或 minor / major
npm publish --access public
```

用户更新：

```bash
npx @finchtoys/minitools update <finch.id>
```

## 4. 推荐的 package.json 结构

```json
{
  "name": "@yourscope/finch-my-tool",
  "version": "0.1.0",
  "description": "npm 页面展示的一句话简介",
  "main": "dist/index.js",
  "files": ["dist/", "i18n/", "skills/", "icons/", "icon.png", "README.md"],
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build"
  },
  "devDependencies": {
    "@finchtoys/minitool-api": "latest",
    "typescript": "^5.0.0"
  },
  "finch": {
    "manifestVersion": 1,
    "id": "my-tool",
    "name": "My Tool",
    "main": "dist/index.js",
    "activationEvents": ["onStartup"],
    "categories": ["developer"],
    "contributes": { "tools": true }
  }
}
```

要点：
- `prepublishOnly` 保证每次 `npm publish` 前都跑一遍构建，避免发布过期的 `dist/`。
- `@finchtoys/minitool-api` 只是类型包，放 `devDependencies`；运行时由 Finch 注入，**不要**放进 `dependencies`。
- `name`（npm 包名）和 `finch.id`（Finch 内部 id）是两回事：`name` 可以改，`finch.id` 首次发布后应保持稳定——它是用户安装目录名和权限记录的 key。
- `finch.categories` 建议从社区目录当前支持的分类里选：`productivity` / `developer` / `creative` / `research` / `finance` / `commerce` / `education`。

## 5. 提交进官方社区目录

进目录前先确认：已发布到 npm，且 `npx @finchtoys/minitools add <包名>` 能正常安装。

1. 确保 npm 包根目录带 `icon.png`：PNG 格式，**128×128 至 300×300 像素**（含边界），并且确实被打进了发布的 tarball（用 `npm pack --dry-run` 核对文件清单）。
2. 到 Finch 官方发布仓库开 issue：**https://github.com/finchtoys/finch-releases/issues**
3. 打上标签 **`小工具发布申请`**。
4. issue 内容包含：
   - npm 包名
   - `finch.id`
   - 一句话简介（会直接显示在社区卡片上）
   - 建议归属的分类（上面 7 个之一）
   - 确认 `icon.png` 已符合规格
   - 是否需要用户配置 API Key / 权限（方便审核时评估风险等级）
   - 截图或演示 GIF（可选，但强烈建议）

Finch 团队审核后会把条目合并进 `community/mini-tools.json`；合并生效后，用户在 Finch 工具箱的"社区推荐"里就能直接看到并一键安装，不需要知道包名。

> 官方目录条目里的 `installScope` 字段决定安装按钮的默认落地位置（`personal` 或 `global`），未特别说明时按 `personal`（个人工作间）处理——这与手动 CLI 安装的默认行为一致。

## 6. 发布后的维护

- **修 bug** → bump patch，`npm publish`，用户用 CLI `update` 即可拿到新版本，无需重新走 issue 流程。
- **加能力** → bump minor，更新 README；如果社区卡片上的简介需要跟着变，在原 issue 下追加说明即可，不必开新 issue。
- **破坏性变更** → bump major，在 README 里写清迁移步骤。
- **停止维护** → `npm deprecate` 标记弃用，并在当初提交用的 issue 里知会用户。

## 检查清单

```
[ ] npm login 已验证
[ ] dist/ 是最新的（npm run build）
[ ] files 或 .npmignore 排除了 src/ 和构建配置
[ ] 包里没有 .env / 密钥等敏感文件
[ ] finch.id 稳定，且和安装目录名一致
[ ] prepublishOnly 会自动跑构建
[ ] README 说明了这个 Mini Tool 做什么、需要什么前置配置
[ ] icon.png 在包根目录，PNG，128×128–300×300 像素，且被打进了 npm tarball
[ ] npm publish --access public 成功
[ ] 实测安装：npx @finchtoys/minitools add <包名>
[ ] （可选）到 finch-releases 开 issue 申请进社区目录
```
