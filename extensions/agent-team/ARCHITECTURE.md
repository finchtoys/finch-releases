# Agent Team Architecture

## 1. 设计目标

Agent Team 将 AI 的不确定规划能力与代码的确定性调度能力分开：模型负责拆解、分工和验收，Orchestrator 负责依赖、并发、状态迁移、恢复及权限边界。

```text
App View
   ↕ business messages
TeamStore + Orchestrator
   ├── dynamic domain tool (`agent_team_collaboration`)
   └── owner-scoped API
Models / Spaces / Sessions / Turn Events / Waits / Artifacts / Collaboration
```

## 2. 领域层次

```text
Project
  ├── WorkflowState[]
  ├── AgentRole[]
  ├── TeamTask[]
  └── AgentRun[]
        └── Session + Turn
```

- **Project**：目标、指挥模型、可用 Space、权限模式和并行上限。
- **AgentRole**：职责、模型、思考等级、默认 Space 和角色并发限制。
- **TeamTask**：工作说明、验收标准、依赖、Workflow 状态及重试预算。
- **AgentRun**：某个 Task 的一次实际执行或验收尝试，与精确 `sessionId + turnId` 绑定。
- **TeamWait**：原始权限、问题或表单卡片在项目层的可视化投影。

Task 与 Turn 不是一对一关系。一个 Task 可以有 Worker、Reviewer 和返工产生的多条运行记录。

## 3. 事件模型

事件只来自本扩展自有的 Session：`ctx.sessions.onDidReceiveEvent()` 是 owner-scoped 的，且每条事件都会先按 `sessionId + turnId` 匹配本项目的 Run，匹配不到就丢弃。因此用户自己创建的对话、以及 `ctx.status` / `ctx.events` 这类 Finch 全局信号都不会驱动看板状态。

### 实时事件

`assistant.delta` 只用于活动预览，160ms 节流后推送到 App View，不作为完成依据，也不依赖它恢复历史。

### 持久事件

| 事件 | 处理 |
|---|---|
| `assistant.message` | 保存最终消息 |
| `turn.started` | 将 Run 置为 running，并记录实际生效的 `modelKey` 与思考档位 |
| `turn.completed` | 完成规划、进入验收或完成任务 |
| `turn.failed` | 标记失败/取消并阻塞任务 |
| `turn.waiting` | 建立 Human Inbox 项目 |
| `turn.wait_resolved` | 移除等待并恢复运行态 |

每个 Session 保存最后处理的 `sequence`。激活时先订阅实时事件，再通过 `listEvents({ after })` 回放缺失事件，最后用 `listWaits()` 校准仍存在的等待卡片。

## 4. 调度

调度器只选择满足以下条件的任务：

1. 项目处于 active。
2. Workflow 类别为 backlog 或 ready。
3. 没有 activeRun。
4. 所有依赖任务都处于 done。
5. 未超过项目并行上限。
6. 未超过角色并行上限。
7. 未达到最大尝试次数。

可执行任务通过 `Promise.all` fan-out。每个 Worker 创建独立 Session；同一项目使用统一 `topic`。配置解析顺序为 Task override → Role → Commander；若最终模型不在实时模型目录中，任务明确阻塞，不会静默降级到 Commander。`turn.started` 会把 Runner 实际采用的模型和思考档位写回 Run。

## 5. 动态协作协议与验收

Planner、Worker、Reviewer 不再通过最终回复交换大段 JSON。小程序注册一个 `exposure: "dynamic"` 的高层领域工具 `agent_team_collaboration`；初始上下文不注入 schema，模型先用 ToolSearch 按需发现。工具 handler 运行在小程序进程内，可直接调用 `ctx.artifacts` 与 `ctx.collaboration`。

工具按 `exec.sessionId` 匹配活跃 Run 并执行角色鉴权，普通会话以及跨任务调用会被拒绝。首版提供四个 action：

- `get_context`：按 Planner / Worker / Reviewer 返回其最小必要上下文。
- `commit_plan`：校验 Workflow、角色、模型映射、任务 DAG 与工作地点；发布 Plan Artifact、创建 Plan Document 与共享 Tasks。
- `submit_result`：固化当前工作目录内的文件 Artifact 与 Worker Report Artifact，并创建发往 Commander 的 Handoff。
- `review_handoff`：以 Handoff 版本执行 accept/reject，同时推进共享 Task；拒绝时进入有限返工。

最终回复只保留一句自然语言确认。旧版 JSON 最终回复解析仍作为兼容回退。所有写操作使用稳定 `idempotencyKey`，重复 Tool Call 或事件回放不会产生重复对象。

## 6. Wait 与安全

- question/form：App View 收集用户输入并调用 `respondToWait()`。
- 普通 permission：用户可在授权中心允许或拒绝本次。
- destructive permission：程序不能批准；界面只允许拒绝或跳转原 Session 由真人确认。
- 回答始终提交给原 Wait，不通过 `sessions.send()` 创建旁路 Turn。

## 7. UI

App View 使用 React、Tailwind、shadcn 组件模式、Radix Dialog 和 Lucide 图标。颜色、边框、圆角、阴影、字号与字体全部映射到 Finch `--finch-*` token，并提供独立打开页面时的浅色/深色 fallback。

主要视图：

- Project Sidebar
- Workflow Kanban
- Team 角色与负载
- Human Inbox
- Activity Timeline
- Task Detail 与 Run History

## 8. SQLite 持久化与限制

项目状态保存在 Finch 私有扩展目录的 `agent-team.sqlite`。数据库使用 WAL、`busy_timeout=5000`、`synchronous=NORMAL` 和 `BEGIN IMMEDIATE` 写事务；每次事务先读取最新已提交状态，再执行领域变更，因此多个写入连接不会用旧快照覆盖新数据。

Schema 版本为 1，按 `projects`、`tasks`、`runs`、`waits`、`activities`、`session_cursors` 分表，并使用 `agent_team_meta` 记录初始化状态和 revision。完整实体 payload 保留在各自行内，以兼容领域字段演进；常用关联和状态字段独立成列并建立索引。

首次升级会在同一事务内导入旧 `ctx.storage` 状态，提交成功后才删除旧 key。活动记录保留最近 500 条，流式增量不作为持久恢复数据。Session 事件本身遵循 Finch 的 7 天/10,000 条保留限制，因此终态摘要会写入项目状态。
