# Finch Skills

Skills 是 Finch 的按需能力包。一个 Skill 通常包含一份 `SKILL.md`，以及可选的脚本、参考文档、模板或素材。Finch 会先读取每个 Skill 的名称和描述，在需要时再加载完整说明，让 AI 按照 Skill 里的流程完成任务。

## 适合用 Skill 的场景

当你有一套稳定、可复用的工作方法时，可以把它做成 Skill，例如：

- 固定格式的写作、总结、审阅流程
- 某类文件的处理规范
- 项目专属的开发、发布、排错步骤
- 需要引用脚本、模板、参考文档的复杂任务
- 你希望 Finch 在特定任务中自动遵守的一套操作指南

如果只是一次性要求，直接在对话里告诉 Finch 即可；如果会反复使用，就适合做成 Skill。

## Skill 放在哪里

Finch 会从以下目录发现 Skills。

### 项目 / 空间 Skills

默认推荐把新建或安装的本地 Skill 放到当前工作目录的：

```text
<cwd>/.finch/skills/<skill-name>/SKILL.md
```

这里的 `cwd` 是当前对话的工作目录：

- 如果你在某个项目目录里使用 Finch，就是该项目目录。
- 如果你在绑定目录的空间里使用 Finch，就是空间绑定的目录。
- 如果你把目录加入了当前会话，Finch 也会读取该目录下的 `.finch/skills`。

示例：

```text
my-project/
└── .finch/
    └── skills/
        └── release-helper/
            ├── SKILL.md
            ├── scripts/
            └── references/
```

### Finch 主目录 Skills

Finch 主目录也可以存放个人通用 Skills：

```text
<finchHomeDir>/.finch/skills/<skill-name>/SKILL.md
```

默认 Finch 主目录通常是：

```text
~/finchnest
```

因此默认路径通常类似：

```text
~/finchnest/.finch/skills/<skill-name>/SKILL.md
```

### 全局 Skills

全局 Skills 存放在 Finch 应用数据目录：

```text
~/.finch/skills/<skill-name>/SKILL.md
```

开发版 Finch 使用：

```text
~/.finch-dev/skills/<skill-name>/SKILL.md
```

全局目录适合放跨项目、跨空间都要使用的基础 Skill。普通项目或空间专用 Skill，优先放在 `cwd/.finch/skills`。

## 发现和优先级

Finch 的读取优先级是：

```text
空间 / 当前授权目录 > 当前主工作目录 > Finch 主目录 > 全局目录
```

如果多个目录里有同名 Skill，Finch 会使用优先级最高的那个。

如果最高优先级的同名 Skill 被停用，Finch 不会自动回退到低优先级的同名 Skill。这样可以让停用行为明确地覆盖低优先级版本。

## 如何触发刷新

Finch 使用被动发现策略，不需要后台监听文件变化。

以下操作会重新扫描 Skills：

- AI 调用 `Skills` 工具时
- 在 Composer 输入框里打开 Skill 检索时
- 打开工具箱的技能列表时
- 在设置或工具箱里启用 / 停用 Skill 时
- 安装内置 Skills 时

因此，当你用 `skill-creator` 创建了 Skill，或用第三方工具把 Skill 放进 `.finch/skills` 后，重新打开技能检索或工具箱技能页即可看到。

## Skill 结构

最小结构如下：

```text
my-skill/
└── SKILL.md
```

推荐结构：

```text
my-skill/
├── SKILL.md              # 必需：frontmatter + 使用说明
├── scripts/              # 可选：脚本或自动化工具
├── references/           # 可选：长文档、API 说明、规范
└── assets/               # 可选：模板、图片、字体等素材
```

`SKILL.md` 是唯一必需文件。其他文件都按需添加。

## SKILL.md 格式

`SKILL.md` 使用 Markdown，并建议在顶部包含 YAML frontmatter：

```markdown
---
name: my-skill
description: 这个 Skill 做什么，以及什么时候应该使用它。
---

# My Skill

## 使用方式

当用户需要……时，按以下步骤处理：

1. 先确认输入材料。
2. 读取必要的参考文件。
3. 按指定格式输出结果。
```

### 必填字段

| 字段 | 说明 |
| --- | --- |
| `name` | Skill 名称。建议使用小写字母、数字和连字符，例如 `release-helper`。 |
| `description` | Skill 的用途和触发场景。Finch 会根据它判断什么时候使用这个 Skill。 |

### description 怎么写

`description` 是最重要的字段。它应该同时说明：

- Skill 能做什么
- 用户说什么、遇到什么任务时应该使用它
- 是否有明确输入或输出类型

较好的写法：

```yaml
description: 帮助发布 Electron 应用，包含版本检查、changelog、构建验证和发布前检查。用户提到发布、打包、发版、release 或 changelog 时使用。
```

不推荐：

```yaml
description: 发布助手。
```

## 如何创建一个 Skill

你可以直接让 Finch 创建：

```text
帮我创建一个 Skill，用来整理会议录音转写稿，输出行动项和风险点。
```

Finch 会使用 `skill-creator` 协助你梳理目标、编写 `SKILL.md`，并把 Skill 放到合适位置。

默认情况下，本地 / 项目 / 空间 Skill 应放在：

```text
<cwd>/.finch/skills/<skill-name>/SKILL.md
```

只有当你明确要求“创建全局 Skill”时，才应放到：

```text
~/.finch/skills/<skill-name>/SKILL.md
```

## 如何手动安装第三方 Skill

如果你拿到一个第三方 Skill 目录，只需要保证它里面有 `SKILL.md`，然后复制到：

```text
<cwd>/.finch/skills/<skill-name>/
```

例如：

```text
my-project/.finch/skills/pdf-review/SKILL.md
```

然后打开 Finch 的工具箱技能页，或在 Composer 里打开 Skill 检索，Finch 就会重新扫描并发现它。

## 如何使用 Skill

### 自动使用

如果任务和某个 Skill 的 `description` 匹配，Finch 会在对话中自动使用它。

### 手动指定

你也可以在输入框里通过 Skill 检索插入 Skill block，让 Finch 明确使用某个 Skill。

插入后，发送时 Finch 会把它转换成类似这样的指令：

```text
Please use the following skill(s): my-skill.
```

然后 Finch 会读取对应的 `SKILL.md` 并按说明执行。

## 工具箱里的 Skill

在工具箱的技能页，你可以：

- 查看当前发现的 Skills
- 查看 Skill 详情和 `SKILL.md` 内容
- 启用或停用 Skill
- 用某个 Skill 开启新对话
- 创建新 Skill

工具箱打开技能列表时会自动重新扫描，所以新放入 `.finch/skills` 的 Skill 会在这里出现。

## 安全提示

Skills 可以包含会影响 Finch 行为的说明，也可能包含脚本或可执行流程。安装第三方 Skill 前，请先检查：

- `SKILL.md` 是否符合你的预期
- `scripts/` 中是否包含你信任的脚本
- Skill 是否要求访问敏感文件、发送网络请求或执行危险命令

不要安装来源不明、内容不透明的 Skills。

## 常见问题

### 我把 Skill 放进目录了，为什么没出现？

请检查：

1. 路径是否是：
   ```text
   <cwd>/.finch/skills/<skill-name>/SKILL.md
   ```
2. 文件名是否是大写的 `SKILL.md`。
3. `SKILL.md` 是否有 `name` 和 `description`。
4. 是否重新打开了 Composer Skill 检索或工具箱技能列表。
5. 当前对话的 `cwd` 是否是你放置 Skill 的项目 / 空间目录。

### 项目 Skill 和全局 Skill 同名会怎样？

项目 / 空间 Skill 优先于 Finch 主目录和全局 Skill。你可以用同名 Skill 覆盖全局行为。

### 可以把多个 Skill 放在一个目录吗？

推荐每个 Skill 一个目录，每个目录里有自己的 `SKILL.md`：

```text
.finch/skills/
├── skill-a/
│   └── SKILL.md
└── skill-b/
    └── SKILL.md
```

这样最清晰，也方便启用、停用和迁移。
