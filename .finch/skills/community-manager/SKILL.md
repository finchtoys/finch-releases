---
name: community-manager
description: >
  管理 finch-releases 仓库 community/ 目录下的官方扩展和技能推荐索引。
  当用户提到「管理社区推荐」「更新扩展列表」「添加新扩展到社区」「更新技能索引」「同步中英文注册表」
  「发布推荐配置」「社区扩展管理」「官方技能列表」等涉及 community/*.json 的操作时触发此 skill。
  也适用于用户说「加一个新的社区扩展到推荐列表」「把这个技能放到社区推荐里」「更新一下 MCP Bridge 的描述」
  「把 XX 标记为已弃用」「检查一下社区推荐配置有没有问题」等涉及推荐清单维护的场景。
  此 skill 只管理 JSON 注册文件本身，不涉及 extensions/* 和 skills/* 的源码文件。
---

# Community Manager — finch-releases 推荐索引管理

## 核心定位

管理 `community/` 目录下的 4 个 JSON 注册文件，这些文件是 Finch App 市场和社区网站的数据源：

| 文件 | 内容 | 用途 |
|---|---|---|
| `community/mini-tools.json` | 小工具推荐索引（英文） | Finch App 小工具市场数据源 |
| `community/skills.json` | 技能推荐索引（英文） | Finch 技能市场数据源 |
| `community/mini-tools.zh-CN.json` | 小工具中文覆盖 | 中文界面降级回退到英文 |
| `community/skills.zh-CN.json` | 技能中文覆盖 | 中文界面降级回退到英文 |

这些文件通过 Cloudflare Worker（`community/worker.js`）发布到 `community.finchwork.app`，修改后约 1 小时生效。

## 文件格式规范

### mini-tools.json 条目 schema

```json
{
  "id": "mcp",                              // 唯一 ID
  "name": "MCP Bridge",                     // 展示名
  "author": "Finch Team",                   // 作者
  "description": "一句话描述",               // 英文描述
  "repo": "finchtoys/finch-releases",       // GitHub owner/repo
  "npm": "@finch.app/mcp-bridge",           // (可选) npm 包名，支持一键安装
  "extensionType": "official",              // (可选) "official" | "community"，默认 "community"
  "installScope": "global",                 // (可选) "global" | "local"
  "categories": ["developer"],               // 分类标签
  "featured": true,                          // (可选) true 则成为客户端精选推荐
  "deprecated": true                         // (可选) 标记已弃用
}
```

### skills.json 条目 schema

```json
{
  "id": "docx",                             // 唯一 ID
  "name": "Document",                       // 展示名
  "author": "Finch Team",                   // 作者
  "description": "一句话描述",               // 英文描述
  "repo": "finchtoys/finch-releases",       // GitHub owner/repo
  "installScope": "global",                 // (可选) "global" | "local"
  "categories": ["productivity", "creative"], // 分类标签
  "featured": true,                            // (可选) true 则成为客户端精选推荐
  "deprecated": true                           // (可选) 标记已弃用
}
```

### zh-CN 覆盖条目 schema（只含用户可见字段）

```json
{
  "id": "mcp",                              // 必须匹配英文条目的 id
  "name": "MCP 桥接",                       // 中文展示名
  "description": "连接 MCP 服务..."          // 中文描述
}
```

### 分类标签固定列表

`productivity`（效率） | `developer`（开发） | `creative`（创意） | `research`（研究） | `finance`（金融） | `commerce`（电商） | `education`（教育）

### 格式规则

- 2 空格缩进，条目按 `id` 字母序排列
- 英文文件保留完整字段，中文覆盖只含 `id`/`name`/`description`
- 末尾换行，不允许尾随逗号

## 工作目录

```bash
cd ../../..  # finch-releases 仓库根目录
```

---

## 操作指令

### 概览

| 操作 | 用户可能的说法 | 使用脚本 |
|---|---|---|
| **查看** | 「看看现在有什么扩展」「列出所有技能」「显示 mcp 的详情」 | 直接 Read |
| **新增** | 「加一个新扩展到推荐」「把这个技能加进去」 | `manage_registry.py add` |
| **更新** | 「改一下 xx 的描述」「把 categories 改成 xx」 | `manage_registry.py update` |
| **弃用** | 「把 xx 标记为不再推荐」「下架 xx」 | `manage_registry.py deprecate` |
| **恢复** | 「取消弃用 xx」 | `manage_registry.py undeprecate` |
| **校验** | 「检查一下配置文件有没有问题」 | `validate.py` |

> **为什么用脚本而不是直接 Edit JSON？** JSON 数组的 Edit 操作容易破坏格式（尾逗号、缩进不对、字母序错乱）。用 Python 脚本保证写入格式一致，自动排序。查看和展示变更摘要时用 Read 工具即可。

### 前置：收集用户意图

每次操作前先 Read 相关 JSON 文件了解当前状态，然后和用户确认字段。不要跳过收集环节直接写入。

### 操作 1：查看（使用 Read 工具）

```bash
# 列出所有小工具
Read community/mini-tools.json

# 列出所有技能
Read community/skills.json

# 查看中文覆盖
Read community/mini-tools.zh-CN.json
Read community/skills.zh-CN.json
```

展示格式示例：
```
## 扩展推荐 (2)

| id | name | author | categories | deprecated |
|---|---|---|---|---|
| github-copilot-chat | GitHub Copilot Chat | Finch Team | developer | — |
| mcp | MCP Bridge | Finch Team | developer | — |
```

### 操作 2：新增（使用脚本）

**交互流程：**
1. Read 当前文件，确认现有条目
2. 逐项收集用户输入，**必须同时询问中英文**
3. 必填：`id`, `name`(英), `author`, `description`(英), `repo`
4. 中文必填：`name_zh`, `description_zh`
5. 选填：`npm`(仅扩展), `extensionType`(默认community), `installScope`, `categories`
6. 校验 id 格式（小写字母、数字、连字符）和唯一性
7. 执行脚本

```bash
cd ../../..

python3 .finch/skills/community-manager/scripts/manage_registry.py add mini-tool '{
  "id": "my-ext",
  "name": "My Extension",
  "author": "Me",
  "description": "Does something useful.",
  "repo": "me/my-repo",
  "npm": "@me/finch-ext-my",
  "extensionType": "community",
  "categories": ["productivity"],
  "name_zh": "我的扩展",
  "description_zh": "做了些有用的事。"
}'
```

```bash
python3 .finch/skills/community-manager/scripts/manage_registry.py add skill '{
  "id": "my-skill",
  "name": "My Skill",
  "author": "Me",
  "description": "A useful skill.",
  "repo": "me/my-repo",
  "categories": ["developer"],
  "name_zh": "我的技能",
  "description_zh": "一个有用的技能。"
}'
```

### 操作 3：更新（使用脚本）

```bash
# 更新小工具的 description 和 categories
python3 .finch/skills/community-manager/scripts/manage_registry.py update mini-tool mcp '{
  "description": "New description.",
  "categories": ["developer"]
}'

# 同时更新中文覆盖（name_zh/description_zh 字段触发 zh-CN 写入）
python3 .finch/skills/community-manager/scripts/manage_registry.py update mini-tool mcp '{
  "description": "New description.",
  "description_zh": "新描述。"
}'
```

支持的更新字段：
- 英文：`name`, `author`, `description`, `repo`, `npm`, `extensionType`, `installScope`, `categories`, `featured`
- 中文：`name_zh`, `description_zh`（传入这两个字段会自动更新或创建 zh-CN 条目）

### 操作 4：删除（使用脚本）

> Finch 端暂未支持 deprecated 过滤，所以「拿掉」= 直接删除条目（包括 zh-CN 覆盖）。
> 等 Finch 支持 deprecated 过滤后再改为软删除方案。

```bash
# 删除一个小工具或技能条目
python3 .finch/skills/community-manager/scripts/manage_registry.py remove mini-tool old-ext
python3 .finch/skills/community-manager/scripts/manage_registry.py remove skill theme-factory
```

### 操作 5：校验（使用脚本）

```bash
python3 .finch/skills/community-manager/scripts/validate.py
```

校验内容：
1. **JSON 合法性** — 每个文件是否能被解析
2. **必填字段** — id/name/author/description/repo 是否齐全
3. **id 格式** — 小写字母、数字、连字符
4. **id 唯一性** — 无重复 id
5. **分类合规** — categories 只使用固定 6 个分类 ID
6. **字母序** — 条目按 id 排序
7. **中文覆盖完整** — 每个英文条目有对应 zh-CN 条目
8. **中文覆盖无多余** — zh-CN 中无已移除的条目
9. **扩展 id 一致性** — 检查 id 是否与 `extensions/<id>/package.json#finch.id` 匹配

### 操作 6：同步中文覆盖（交互式）

当英文文件新增了条目但 zh-CN 还没跟随时执行：

1. 运行 `validate.py` 找出缺失的 zh-CN 条目
2. 逐条询问用户对应的中文 name 和 description
3. 用 `manage_registry.py update` 逐条写入

---

## 变更摘要规范

每次修改后，在对话中输出以下格式的摘要：

```
## 变更摘要

### 新增
- [extension] `github-copilot-chat` — GitHub Copilot Chat
- [extension] `github-copilot-chat` (zh-CN) — GitHub Copilot Chat 扩展

### 修改
- [skill] `find-skills` — description 已更新
- [skill] `find-skills` — categories 改为 productivity

### 删除
- [skill] `theme-factory` — 已移除

### 文件变更
- community/mini-tools.json — 新增 1 条
- community/mini-tools.zh-CN.json — 新增 1 条
- community/skills.json — 修改 1 条

### 下一步
请 review 变更，确认后手动 git commit。
```

## 重要原则

- **community/*.json 是 Finch App 市场的数据源**，格式错误会导致 App 端解析失败。每次修改后用 `validate.py` 自我校验。
- **zh-CN 覆盖是可选降级**，新增条目时必须同时写入。更新纯技术字段（repo, npm 等）不需要同步中文。
- **deprecated 是软删除**，保留条目但 Finch 端过滤不显示。永远不要删除条目。
- **字母序让 diff 清晰可读**，脚本自动处理排序，无需手动插入位置。
- **变更摘要是给用户的，不是 commits**，用户据此决定是否 git commit。
