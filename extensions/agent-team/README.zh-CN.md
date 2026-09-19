# Agent Team

Agent Team 是一个事件驱动的 Finch 小程序，用项目看板组织多个模型、多个角色与多个 Space 中的并行 Agent 工作。

## 功能

- 使用指挥模型从自然语言生成项目、角色、Workflow、任务依赖与验收标准
- 通过 ToolSearch 按需注入单一动态协作工具，避免在最终回复中交换大段 JSON
- 每个角色可选择不同模型、思考等级、默认 Space 和并发上限；模型不可用时明确阻塞，不静默降级
- 将无依赖任务以 background Session 方式 fan-out 并行执行
- 实时显示 `assistant.delta`，使用持久 Turn 事件推进任务状态
- 将计划、文件产物、Worker 报告与验收结论写入 Artifact / Collaboration 共享层，未通过时自动返工
- 通过 cursor 回放恢复小程序重启或断线期间的事件
- 集中展示权限、提问和表单等待，并将回答提交到原 Wait 卡片
- destructive 权限只允许真人在原 Session 批准
- 支持自定义 Workflow、拖拽任务、精确取消 Turn 和人工重试

## 工作流程

1. 在左侧边栏打开 **Agent Team**。
2. 点击 **AI 创建项目**，描述项目需求。
3. 选择指挥模型、思考等级、Space、权限模式和并行上限。
4. 指挥模型生成项目草案，包含角色、任务图与验收标准。
5. 检查草案并按需编辑 Workflow，然后点击 **启动 Team**。
6. Worker 在指定 Space 中并行执行；看板实时显示排队、运行和等待状态。
7. 需要人类处理时，在 **授权中心** 回答问题、填写表单或跳转原 Session 授权。
8. 指挥模型验收交付；全部任务通过后项目自动完成。

## 状态模型

顶部「运行 / 等待」只统计本扩展创建的 Planner、Worker、Reviewer Session，不反映 Finch 全局会话状态，也不会把你自己创建的对话算进来。

业务 Workflow 与运行时状态彼此独立：

- Workflow：项目自定义，例如 `需求 → 进行中 → 待验收 → 已完成`
- Runtime：`queued → running → waiting → completed / failed / cancelled`

`turn.started` 会记录 Runner 实际采用的模型与思考档位；因此用户调整看板列时，不会破坏 Session 与 Turn 的可靠状态。

## 数据存储

项目状态保存在 Finch 为扩展分配的私有目录 `ctx.storagePath/agent-team.sqlite` 中。数据库使用 SQLite WAL、5 秒 busy timeout 和 `BEGIN IMMEDIATE` 事务，避免并发写入破坏状态或覆盖更新。

实体按项目、任务、运行、等待、活动和 Session 游标分表存储。升级后的首次启动会自动将原 `ctx.storage` 数据迁移进 SQLite；数据库事务提交成功后才清理旧数据。

## 安全策略

- 小程序只能访问自己创建的 Session；动态工具还会按 `exec.sessionId` 校验 Planner、Worker、Reviewer 身份与当前任务。
- 项目数据使用 `ctx.storage` 保存，不保存密钥。
- Wait 应答使用 `respondToWait()`，不会创建新 Turn。
- destructive 权限无法由程序批准，只能拒绝或跳转 Finch 由真人处理。
- 所有发送使用稳定 `idempotencyKey`，避免重复创建 Turn。
- 启动失败或达到最大尝试次数的任务进入阻塞状态，不会无限重试。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
npm run doctor
```

生产文件输出到：

- `dist/backend/`：小程序 Host 端
- `dist/appview/`：React App View

界面使用 Finch `--finch-*` 主题 token、shadcn 风格组件、Radix Dialog 与 Lucide 图标，会自动跟随浅色、深色及自定义皮肤。

## 权限

| 权限 | 用途 |
|---|---|
| `sessions` | 创建 Session、发送消息、读取事件与 Wait |
| `sessionInteractions` | 将用户回答提交到原权限、问题或表单卡片 |
| `artifacts` | 固化计划、Worker 报告和实际文件产物 |
| `collaboration` | 创建 Scope、Document、Task 与 Handoff |
| `filesystem: read` | 只读固化 Worker 明确提交且位于当前工作目录内的文件 |

小程序不申请 network 或 shell 权限；实际 Agent 的操作仍由 Finch Session 权限系统控制。
