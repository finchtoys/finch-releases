# AGENTS.md · finch-releases

## 空间定位

`finch-releases` 是 **Finch App 的社区发布站**，用于集中发布 Finch App 相关文档、官方扩展配置、技能、npm 包以及社区贡献内容。

官方网站：https://finchwork.app/
GitHub 仓库：https://github.com/finchtoys/finch-releases

## 目录结构

```
finch-releases/
├── AGENTS.md          # 本空间规则
├── README.md          # 项目入口说明
├── package.json       # npm workspaces 根配置
├── docs/              # Finch App 文档、用户指南、开发文档
├── extensions/        # Finch 扩展的社区配置文件（JSON 格式）
├── skills/            # Finch 技能（skills）相关配置与说明
├── community/         # 社区贡献内容：推荐配置、插件清单、最佳实践等
└── packages/          # 需要发布到 npm 的官方包 / CLI 工具源码
```

### 目录说明

- **docs/**：面向用户和开发者的文档。可包含用户指南、API 文档、插件开发教程、FAQ 等。
- **extensions/**：存放社区扩展的 **配置文件**（JSON），而非扩展源码。每个扩展推荐一个目录，内含 `finch-extension.json` 或同类清单文件。
- **skills/**：Finch 技能的配置、索引或说明文件。可包含官方技能列表、技能贡献模板等。
- **community/**：社区贡献区。推荐插件清单、主题合集、工作流模板、用户案例等都可以放在这里。
- **packages/**：以 npm 包 / CLI 工具形式发布的官方包源码。本目录启用 npm workspaces，每个子目录是一个独立可发布的包。

## 治理模式

- **官方维护**：本仓库由 Finch 官方团队维护，保证核心内容的质量与一致性。
- **社区贡献**：欢迎社区通过 Pull Request 或 Issue 提交贡献。贡献内容需符合本空间规范，经审核后合并。

## 贡献规范

1. **每个扩展或包单独说明**：在对应目录下提供 `README.md`，说明用途、安装方式、依赖和权限。
2. **配置 JSON 需可校验**：`extensions/` 下的 JSON 配置文件应包含清晰的 schema，优先提供示例和字段说明。
3. **命名清晰**：目录和文件使用小写字母、连字符分隔，避免空格和特殊字符。
4. **版本管理**：官方扩展和 npm 包遵循语义化版本（SemVer），重大变更需更新 changelog。发布前确保对应 `packages/<name>/package.json` 的 `version` 已提升。
5. **权限与安全**：扩展配置需明确声明所需权限；涉及网络、文件系统或 shell 的扩展需额外说明安全策略。
6. **npm 包发布**：`packages/` 下的包通过 `npm run publish:all` 统一发布。脚本会自动跳过 `private: true` 的包以及已存在于 registry 的版本。CI 在推送 `v*` tag 时触发自动发布。

## 发布流程（草案）

1. 内容更新或新增后，在对应目录补充/更新文档和配置。
2. 官方扩展配置变更需同步到 Finch 内置扩展市场索引。
3. 发布 npm 包时，提升 `packages/<name>/package.json` 中的 `version`，然后本地执行 `npm run publish:all` 或推送 `v*` tag 由 GitHub Actions 自动发布。
4. 发布扩展配置时，同步更新 Finch 内置扩展市场索引。
5. 社区贡献通过 PR 合并，官方内容可直接提交或由维护者审核后合并。

## 注意事项

- 本仓库不存放 Finch App 主程序源码；主程序源码位于独立的开发仓库。
- 本仓库也不存放扩展的完整源码，扩展源码由各自仓库维护；这里只保存发布所需的配置和索引。
- `packages/` 使用 npm workspaces 管理，发布脚本位于 `scripts/publish-all.sh`，CI 配置位于 `.github/workflows/publish.yml`。
- 如需调整空间规则，请修改本文件并同步更新 `README.md`。

---

## 社区推荐管理

### 数据文件

`community/` 目录下 4 个 JSON 文件是 Finch App 扩展市场和社区网站的数据源：

| 文件 | 内容 |
|---|---|
| `community/extensions.json` | 扩展推荐索引（英文） |
| `community/skills.json` | 技能推荐索引（英文） |
| `community/extensions.zh-CN.json` | 扩展中文覆盖 |
| `community/skills.zh-CN.json` | 技能中文覆盖 |

这些文件通过 Cloudflare Worker 发布到 `community.finchwork.app`，修改后约 1 小时生效。

### 分类体系

| id | 含义 | 适用场景 |
|---|---|---|
| `productivity` | 效率 | 办公文档、日常事务 |
| `developer` | 开发 | 编码、扩展开发、API 集成 |
| `creative` | 创意 | 设计、主题、内容创作 |
| `research` | 研究 | 数据分析、信息提取、搜索 |
| `finance` | 金融 | 财务、记账、报表、投资 |
| `commerce` | 电商 | 在线商店、商品管理、订单处理 |
| `education` | 教育 | 课件、学习、教学辅导 |

### 管理方式

通过对话管理，使用 `.finch/skills/community-manager/` 下的 community-manager skill：

```bash
cd ../../..

# 新增扩展（中英文同时）
python3 .finch/skills/community-manager/scripts/manage_registry.py add extension '{
  "id": "my-ext",
  "name": "My Extension",
  "author": "Me",
  "description": "Does something.",
  "repo": "me/my-repo",
  "name_zh": "我的扩展",
  "description_zh": "做了些事。"
}'

# 新增技能
python3 .finch/skills/community-manager/scripts/manage_registry.py add skill '{...}'

# 更新条目
python3 .finch/skills/community-manager/scripts/manage_registry.py update skill find-skills '{"description": "New desc."}'

# 删除条目（Finch 暂未支持 deprecated 过滤，直接删）
python3 .finch/skills/community-manager/scripts/manage_registry.py remove skill theme-factory

# 全量校验
python3 .finch/skills/community-manager/scripts/validate.py
```

### 格式规则

- 2 空格缩进，条目按 `id` 字母序排列
- 英文文件保留完整字段，中文覆盖只含 `id`/`name`/`description`
- 新增条目时**必须同时提供中英文 name 和 description**
- `extensionType` 默认 `"community"`，官方扩展设为 `"official"`
- 永远不要直接删除条目后不更新 zh-CN 覆盖

### 校验

每次修改后运行 `validate.py` 自我校验，检查项包括：JSON 合法性、必填字段、id 格式/唯一性、分类合规、字母序、中英文覆盖完整性。`
