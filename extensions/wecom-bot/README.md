# WeCom Bot · 企微 Bot

Connect a **WeCom (企业微信) intelligent bot** to Finch through the official long-connection API. Talk to Finch from WeCom — direct messages, group chats (@the bot), images/files, and dispatch tasks to Finch Spaces.

Built on the official [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk) (WebSocket long-connection channel) — no public callback URL, no tunnel, no domain needed.

## Features

- **DM & group chat**: single chats and group chats with `@bot` mention (mention prefix is stripped automatically).
- **Rich inbound**: text, voice (auto-transcribed), images, files, videos, and mixed (图文混排) messages; media is downloaded and AES-decrypted (each file has its own key) into the Finch Session.
- **Session Container (inbox)**: every peer (user / group) maps to a Finch Session with a "WeCom Message Steward" agent profile. "开个新对话" style fresh sessions via the `wecom_new` tool; history stays in the inbox.
- **Wait-card relaying**: permission / question / form cards from Finch are rendered as text with a `#code`; reply `#code answer` (or natural language when only one card is pending) from WeCom.
- **Space task dispatch**: `wecom_space_task` (create / send / status) runs a task in a dedicated Space and proactively pushes the result back to WeCom.
- **Proactive messaging**: `wecom_send` pushes text / image / file to a user or group (note: the target must have messaged the bot at least once, per WeCom policy).
- **Streaming-ready replies**: replies are sent as final stream messages (`finish=true`), so they render like normal messages with full markdown.
- **Robust connection**: heartbeat keep-alive, exponential-backoff reconnection, auth-failure / reconnect-exhausted errors surfaced in the UI, kicked-by-newer-connection detection.

## Requirements

- Finch desktop app (this is an official-style mini tool).
- A WeCom enterprise account with **admin access** (to create an intelligent bot) or a bot shared to you.
- Node.js only for development/build; the installed extension runs inside Finch.

## Install

The extension lives in this repository under `extensions/wecom-bot`. To build and install:

```bash
cd extensions/wecom-bot
npm install
npm run build        # → dist/index.js
```

Then install the built extension in Finch (mini tool install flow), or publish it per the repo's minitools publishing guide.

## Configuration

1. Open the WeCom admin console (**管理后台**) → **安全与管理 → 管理工具 → 智能机器人** → **创建机器人** and choose **使用 API 创建** (API mode).
2. Edit the bot → enable **API 模式** → select **长连接** (WebSocket). Copy the **Bot ID** and **Secret**.
3. In Finch, open the WeCom inbox container's settings menu → **配置说明**, then fill in the extension settings:
   - **Bot ID** — from step 2.
   - **Bot Secret** — from step 2 (stored locally only).
   - **Bot Name** *(optional)* — the bot's display name in WeCom; used to strip the `@` mention prefix in group chats.
   - **Auto reply** — push replies back to WeCom (default on).
4. From the container settings menu choose **重新连接**. The status shows 已连接 once authenticated.

> The long-connection endpoint defaults to `wss://openws.work.weixin.qq.com` (custom `wsUrl` is supported in the transport for private deployments).

## Usage

- **Single chat**: message the bot directly. Replies come back in the same chat.
- **Group chat**: add the bot to a group, `@机器人 你的问题`. The whole group shares one Finch Session; each message is labeled with its sender.
- **New conversation**: tell Finch "开个新对话" (uses `wecom_new`), or let the agent call it.
- **Waiting cards**: when Finch needs permission / an answer / form input, it sends a card to WeCom with a `#code`. Reply `#code 内容`, or reply directly when only one card is pending.
- **Space tasks**: ask Finch to "把这件事交给 XX Space 处理" — it calls `wecom_space_task`, and the result is pushed back to WeCom when done.

### Agent tools exposed to the Finch model

| Tool | Purpose |
|---|---|
| `wecom_new` | Start a fresh WeCom Session for a peer. |
| `wecom_send` | Proactively send text / image / file to a user or group. |
| `wecom_space_task` | create / send / status for tasks dispatched to Finch Spaces, with result notification. |

## Architecture

```
WeCom user (app / PC)
   │  DM / group @bot: text, voice, image, file, video, mixed
   ▼
WeCom server (intelligent bot · long-connection)
   │  WebSocket  wss://openws.work.weixin.qq.com  (aibot_subscribe / msg callback / respond / send)
   ▼
finch-wecom-bot mini tool (runs inside Finch desktop)
   ├─ WeComTransport  — wraps @wecom/aibot-node-sdk (auth frame, heartbeat, reconnect, serial reply queue)
   ├─ InboundRouter   — msgid dedup → wait-card answer → @mention strip → media decrypt → ctx.sessions.send
   ├─ Session Container (id=wecom, inbox) + agentProfile "WeCom Message Steward"
   ├─ EventBridge     — turn.completed → replyText/replyMedia (req_id passthrough); turn.waiting → card text
   ├─ TaskManager     — wecom_space_task: Space Session + result push-back
   └─ Tools / settings menu — wecom_new / wecom_send / wecom_space_task, connection status & guide
```

Key mapping: **DM → `userid`**, **group → `chatid`** (sender annotated per message). Replies reuse the original callback's `req_id` so they arrive in the right conversation.

## Limitations & notes

- WeCom long-connection limits: **one active connection per bot**; proactive push requires the user to have messaged the bot first; per-session rate limit ≈ 30 msgs/min, 1000 msgs/hour.
- The SDK reconnects automatically with backoff (up to 10 attempts); if the desktop app sleeps or quits, reconnect resumes on next startup (the extension activates on startup).
- Media download URLs are valid for 5 minutes and are AES-256-CBC encrypted — media is downloaded and decrypted immediately on receipt.
- Destructive actions cannot be approved from WeCom (only denied); approve them in the Finch desktop app.
- URL-callback (webhook) mode and Agent (自建应用) mode are **not** implemented in this MVP; the transport and crypto primitives (`WecomCrypto` from the SDK) are in place if needed later.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # esbuild bundle → dist/index.js
npm test            # node scripts/smoke.mjs (crypto round-trip, media decrypt, mention stripping)
```

Source layout: `src/index.ts` (activation, routing, event bridge, tools), `src/wecom-client.ts` (transport over the official SDK), `src/media.ts`, `src/tasks.ts`, `src/types.ts`, `src/utils.ts`, `i18n/`, `icons/`.

---

# WeCom Bot · 企微 Bot（中文）

把**企业微信智能机器人**通过官方长连接 API 接入 Finch，在企微里直接与 Finch 对话：单聊、群聊 @、发图片/文件、把任务派发给 Finch Space。

基于官方 [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk)（WebSocket 长连接通道）——**无需公网回调地址、无需内网穿透、无需备案域名**。

## 功能

- **单聊 + 群聊**：群聊 @机器人 触发，自动剥离 @前缀。
- **富媒体入站**：文本、语音（自动转文字）、图片、文件、视频、图文混排；媒体即时下载并 AES 解密（每文件独立密钥）进入 Finch 会话。
- **Session 容器（收件箱）**：每个对端（用户/群）映射一个 Finch Session，配「企微消息管家」人设；`wecom_new` 开新对话，历史保留在收件箱。
- **等待卡片中继**：Finch 的授权/提问/表单卡片渲染为文本 + `#code`；在企微回复 `#code 答案`（单张卡在途时可直接回复）即可应答。
- **Space 任务派发**：`wecom_space_task`（create/send/status）在专属 Space 里跑任务，完成自动把结果推回企微。
- **主动推送**：`wecom_send` 向用户/群推送文本、图片、文件（注意：按企微策略，目标需先给机器人发过消息）。
- **流式回复就绪**：回复以终态流式消息（finish=true）下发，Markdown 完整渲染。
- **稳定连接**：心跳保活、指数退避重连、认证失败/重连耗尽错误提示、被新连接顶替检测。

## 安装

扩展位于本仓库 `extensions/wecom-bot`。构建：

```bash
cd extensions/wecom-bot
npm install
npm run build        # → dist/index.js
```

在 Finch 中安装构建好的扩展（小工具安装流程）。

## 配置

1. 企微**管理后台 → 安全与管理 → 管理工具 → 智能机器人** → **创建机器人**，选择「使用 API 创建」。
2. 编辑机器人 → 开启 **API 模式** → 选择 **长连接**，复制 **Bot ID** 与 **Secret**。
3. 在 Finch 的企微收件箱容器设置菜单 →「配置说明」查看指引，然后在扩展设置中填写：
   - **Bot ID** — 第 2 步复制。
   - **Bot Secret** — 第 2 步复制（仅本地保存）。
   - **机器人名称**（可选）— 企微中的机器人显示名，用于群聊剥离 @前缀。
   - **自动回复** — 是否把回复推回企微（默认开）。
4. 回到容器设置菜单选择「重新连接」，状态显示「已连接」即成功。

> 长连接默认地址 `wss://openws.work.weixin.qq.com`（传输层支持私有化部署自定义 `wsUrl`）。

## 使用

- **单聊**：直接给机器人发消息，回复回到同一会话。
- **群聊**：把机器人拉进群，`@机器人 你的问题`。整个群共用一个 Finch Session，每条消息标注发言人。
- **新对话**：对 Finch 说「开个新对话」（调用 `wecom_new`）。
- **等待卡片**：Finch 需要权限/提问/表单时，会向企微发送带 `#code` 的卡片文本；回复 `#code 内容`，或在仅一张卡在途时直接回复。
- **Space 任务**：让 Finch「把这件事交给 XX Space 处理」，完成后结果自动推回企微。

## 架构

```
企微用户（手机/PC）
   │  单聊 / 群聊 @机器人：文本、语音、图片、文件、视频、图文混排
   ▼
企微服务器（智能机器人 · 长连接）
   │  WebSocket  wss://openws.work.weixin.qq.com（订阅/消息回调/回复/主动推送）
   ▼
finch-wecom-bot 小工具（运行在 Finch 桌面端）
   ├─ WeComTransport  — 封装官方 SDK（认证帧、心跳、重连、串行回复队列）
   ├─ InboundRouter   — msgid 去重 → 等待卡片应答 → @前缀剥离 → 媒体解密 → ctx.sessions.send
   ├─ Session 容器（id=wecom, inbox）+ agentProfile「企微消息管家」
   ├─ EventBridge     — turn.completed → 回复（透传 req_id）；turn.waiting → 卡片文本
   ├─ TaskManager     — wecom_space_task：Space Session + 结果回推
   └─ 工具/设置菜单 — wecom_new / wecom_send / wecom_space_task、连接状态与指引
```

关键映射：**单聊 → `userid`**，**群聊 → `chatid`**（每条消息标注发言人）。回复透传原回调 `req_id`，保证回到正确会话。

## 已知限制

- 企微长连接限制：**每个机器人同时仅 1 个连接**；主动推送需用户先给机器人发过消息；单会话频率约 30 条/分、1000 条/时。
- SDK 自动退避重连（最多 10 次）；桌面端休眠/退出后下次启动自动恢复连接。
- 媒体下载 URL 5 分钟有效且 AES-256-CBC 加密——收到即下载解密。
- 不可逆操作不能通过企微批准（仅可拒绝），请在 Finch 桌面端批准。
- MVP 未实现 URL 回调（webhook）模式与自建应用（Agent）模式；SDK 的 `WecomCrypto` 加解密原语已具备，后续可按需扩展。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm run build       # esbuild bundle → dist/index.js
npm test            # node scripts/smoke.mjs（加解密往返、媒体解密、@剥离）
```

源码结构：`src/index.ts`（激活/路由/事件桥接/工具）、`src/wecom-client.ts`（官方 SDK 传输层）、`src/media.ts`、`src/tasks.ts`、`src/types.ts`、`src/utils.ts`、`i18n/`、`icons/`。
