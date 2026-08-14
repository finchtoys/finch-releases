# 企业微信 Bot 小工具调研报告

> 目标：评估在企业微信（企微）内与 Finch 对话、派发任务的可行性，设计一个 Finch mini tool / extension 的对接方案。
> 现状参考：Finch 已有微信 Bot（`finch-wechat-bot`，v0.5.19），本会话即其「微信消息管家」容器。
> 调研日期：2026-08-14

## TL;DR 结论

- **可行，且存在官方正门路径**：企微 2025 年推出的「智能机器人」能力支持 **API 模式（URL 回调）** 与 **长连接（WebSocket）模式** 两种接入方式。长连接模式由本地扩展主动出站连接企微服务器，**不需要公网回调地址 / 备案域名**，与微信 Bot 的 iLink 长轮询架构高度同构，是 Finch mini tool 的首选。
- **推荐接入方式**：企微「智能机器人 · 长连接 API 模式」（BotID + Secret → WebSocket）。备选「URL 回调模式」（需公网穿透 + 签名校验 + AES 解密）。
- **不推荐**：传统「群机器人 webhook」只能单向推送（不能收消息，官方明确不支持消息回调配置），无法做对话式交互；「自建应用」需要企业管理员配可信 IP、且被动回复是 XML 协议、交互体验弱于智能机器人（智能机器人支持流式回复、模板卡片、群聊 @）。
- **复用面大**：微信 Bot 的 Session 容器 / agentProfile / 等待卡片中继 / Space 任务派发（TaskManager）/ 回复推送链路几乎可以整体平移，只需替换「传输层」（iLink → 企微长连接/回调）与「媒体层」（CDN AES-ECB → 企微 media URL / media_id）。
- **已有官方实现可参考**：腾讯企微团队发布了 OpenClaw 官方通道插件 `@wecom/wecom-openclaw-plugin` 与配套 Node SDK `@wecom/aibot-node-sdk`（WebSocket 长连接协议官方实现），并开源在 GitHub `WecomTeam/` 组织下。**aibot-node-sdk 可直接作为 Finch mini tool 的依赖**，协议层不必自研（详见第 6 章）。
- **MVP 建议**：一个机器人、单聊文本 + markdown 收发 + Finch Session 映射 + `wechat_space_task` 同款任务派发，2~4 周可落地。

---

## 1. Finch 微信 Bot 架构梳理

代码位置：`extensions/wechat-bot/`（本仓库），核心源码：

| 文件 | 职责 |
|---|---|
| `finch.json` | 扩展清单：sessionContainers（`wechat` inbox 容器）+ agentProfiles（`wechat-assistant`）+ 工具 + 权限 |
| `src/index.ts` | activate 入口：模块组装、入站消息处理、Session 事件 → 微信回复、长轮询循环、Agent 工具注册 |
| `src/ilink-client.ts` | iLink HTTP 客户端（微信官方开放协议：`ilinkai.weixin.qq.com`） |
| `src/auth.ts` | 扫码登录（二维码轮询）、typing 指示器、退出 |
| `src/media.ts` | 微信 CDN 媒体上传/下载 + AES-128-ECB 加解密、文本/图片/视频/文件发送 |
| `src/tasks.ts` | Space 任务管理（TaskRecord CRUD、turn 状态推进、结果回推微信） |
| `src/types.ts` | 常量、iLink 协议类型、BotState |
| `src/utils.ts` | sleep / randomHex / MIME 猜测 / AES-ECB 工具 |

### 1.1 总体架构（消息链路）

```
微信用户
   │  ① 发消息（文本/语音/图片/文件/视频）
   ▼
iLink 服务器 (ilinkai.weixin.qq.com, bot_type=3)
   │  ② 长轮询 getupdates（cursor 游标增量拉取）
   ▼
┌──────────────────────── Finch 桌面端 ────────────────────────┐
│  finch-wechat-bot 扩展                                        │
│  ├─ handleInbound(): 解析文本/媒体 → 应答 pending wait →      │
│  │     ctx.sessions.send(sessionId, {text, attachments})     │
│  ├─ Session 容器 (id=wechat, inbox)  ←─ 消息注入              │
│  │     agentProfile: "微信消息管家"（简洁口语化回复人设）       │
│  ├─ onDidReceiveEvent: turn.waiting → 渲染权限/提问卡片文本     │
│  │     turn.completed → 回复文本+图片 经 media.sendText/        │
│  │     sendMediaByMime 推回微信                                │
│  └─ TaskManager: wechat_space_task → Space Session 派发任务    │
│        → 完成时主动推结果到微信                                 │
└───────────────────────────────────────────────────────────────┘
   │  ③ sendmessage（主动回复 / 主动推送）
   ▼
微信用户
```

### 1.2 核心机制要点

1. **消息收发（iLink 协议）**
   - 入站：`ilink/bot/getupdates` 长轮询，`get_updates_buf` 作为游标增量拉取；`errcode -14` 判定登录失效（会话过期）→ 提示重新扫码。
   - 出站：`ilink/bot/sendmessage`，`client_id` 幂等，`message_type=2`；文本 `item_list[{type:1,text_item}]`，媒体先 `ilink/bot/getuploadurl` 拿 CDN 参数再上传。
   - 头部：`AuthorizationType: ilink_bot_token` + `X-WECHAT-UIN` + `iLink-App-Id/ClientVersion`；`base_info.channel_version` 对齐 openclaw 兼容版本（2.4.6）。

2. **会话容器（Session Container）模式**
   - `finch.json` 声明 `sessionContainers: [{id:"wechat", mode:"inbox", agentProfile:"wechat-assistant", settingsMenu}]`。
   - 运行时 `ctx.sessions.create({containerId, title, permissionMode:"acceptCalls"})`；`KEY_ACTIVE_SESSION` 记住当前活跃会话，「开个新对话」= 新建 session 并切换；旧会话保留在 inbox。
   - `SESSION_MAP_PREFIX<sessionId>` → peerId 映射；`TURN_MAP_PREFIX<turnId>` → peerId 映射，用于 turn 完成后定位回复目标。

3. **等待卡片中继（Wait Relay）**
   - `turn.waiting` 事件（permission 授权 / question 提问 / form 表单）→ 渲染为微信可读文本（含 `#code` 短码）发回微信。
   - 用户回复 `#code 答案` 或自然语言（仅一张卡在途时）→ `respondToPendingWait()` → `ctx.sessions.respondToWait()`。
   - `WAIT_PREFIX` / `WAIT_INDEX_PREFIX` 管理在途卡片；卡片已结算（桌面端/超时）时清理映射，避免歧义。

4. **Space 任务派发（wechat_space_task）**
   - `create`：`ctx.sessions.create({space:{spaceId}})` → 存 TaskRecord → `sessions.send(初始消息)`。
   - `send`：向任务会话追加消息（若该任务有在途 wait，先按 wait 应答处理）。
   - `status`：列出/查看任务；`waitMs` 支持同步等待 turn 终态。
   - 事件回调：`turn.completed/failed` → 更新 TaskRecord → `notifyResult()` 用 ✅/❌ 文本把结果推回微信。

5. **媒体处理**
   - 下载解密：CDN `full_url` + `aes_key`（base64(raw16) 或 base64(hex32)）→ AES-128-ECB 解密。
   - 上传发送：生成随机 AES key → getuploadurl → 密文 POST CDN → `x-encrypted-param` → 组装 `image_item/file_item/video_item` 发送。
   - `sendMediaByMime` 按扩展名路由 image/video/file，语音入站自动转文字（`voice_item.text`）。

6. **扫码登录（AuthManager）**
   - `get_bot_qrcode` 拿二维码 → 本地渲染 PNG 弹窗 → `get_qrcode_status` 1.5s 轮询（wait/scaned/confirmed/expired/need_verifycode/binded_redirect）。
   - `confirmed` 后持久化 `bot_token` / `base_url` / `owner_user_id` 到 `ctx.storage`，删除游标重启消息循环。
   - 隐私：二维码与 token 不进对话上下文（本地弹窗 + storage）。

7. **Agent 工具（给 Finch 模型用）**
   - `wechat_new`：开新微信会话。
   - `wechat_send`：主动推送文本/文件/URL 图片到微信（无入站触发的通知场景）。
   - `wechat_space_task`：任务派发三合一（create/send/status）。

### 1.3 可复用于企微 Bot 的部分（对照）

| 微信 Bot 组件 | 企微 Bot 复用方式 |
|---|---|
| Session 容器声明（inbox + agentProfile「消息管家」人设） | 原样复用，新增 `wecom` 容器 + `wecom-assistant` profile |
| `ctx.sessions.create/send/respondToWait` 对接 | 原样复用（Finch SDK 层不变） |
| `onDidReceiveEvent` 事件分发（waiting/wait_resolved/completed/failed） | 原样复用 |
| Wait Relay（#code 短码 + 自然语言应答） | 原样复用 |
| TaskManager（Space 任务 + 结果回推） | 原样复用 |
| settingsMenu（登录状态/重连/退出菜单） | 复用框架，入口改为「连接企微机器人」配置 |
| iLink 传输层（长轮询 + sendmessage） | **替换**为企微长连接/回调客户端 |
| CDN 媒体加解密（AES-ECB） | **替换**为企微媒体（URL + AES-256-CBC 解密 / media_id） |
| 扫码登录 | **替换**为企微后台配置 BotID/Secret（长连接）或 URL+Token+AESKey（回调） |

---

## 2. 企业微信官方能力调研

### 2.1 三条接入路径概览

| 路径 | 是什么 | 能否收消息 | 交互能力 | 部署要求 |
|---|---|---|---|---|
| **消息推送（原"群机器人"）webhook** | 群内机器人，POST webhook 推送 | ❌ 官方明确「暂不支持设置消息回调配置，支持主动推送」 | 单向通知：text/markdown/图片/图文/文件/语音/模板卡片 | 仅需 webhook URL，**无服务器** |
| **自建应用** | 企业内应用（agentid），会话消息 | ✅ 回调 URL 接收（XML 协议） | 被动回复 + 主动推送应用消息；模板卡片；无流式 | 需公网回调 URL + Token/EncodingAESKey + 企业可信 IP（主动推送） |
| **智能机器人** | 2025 年推出的 AI 机器人（可 @、可单聊） | ✅ API 模式（URL 回调 JSON）或长连接（WebSocket） | 被动回复、主动回复（response_url）、**流式回复**、模板卡片、欢迎语 | API 模式需公网 URL；**长连接模式无需公网入口** |

> 结论：**智能机器人是唯一同时满足「双向对话」「群聊 @」「流式输出」「无需公网（长连接）」的路径**。

### 2.2 官方能力对照表（智能机器人 / 自建应用 / 群机器人）

| 能力 | 智能机器人（API 回调） | 智能机器人（长连接） | 自建应用 | 群机器人 webhook |
|---|---|---|---|---|
| 官方文档 | [101039 概述](https://developer.work.weixin.qq.com/document/path/101039) | [101463 长连接](https://developer.work.weixin.qq.com/document/path/101463) | [90236 发送](https://developer.work.weixin.qq.com/document/path/90236) / [90239 接收](https://developer.work.weixin.qq.com/document/path/90239) | [91770 消息推送](https://developer.work.weixin.qq.com/document/path/91770) |
| 消息接收 | 回调 POST（JSON 加密） | WebSocket `aibot_msg_callback` | 回调 POST（XML 加密） | ❌ |
| 接收消息类型 | text / image / mixed / voice(转文字) / file / video(≤100M) | 同左（image/file/video 仅单聊） | text / image / voice / video / file / location / link / event | — |
| 群聊 | ✅ @机器人 | ✅ @机器人 | ✅ 群聊会话（appchat） | ✅ 推送进群 |
| 单聊 | ✅ 直接发 | ✅ 直接发 | ✅ 应用消息 | ❌ |
| 被动回复（同步回包） | ✅ 加密 JSON | ✅ `aibot_respond_msg` | ✅ XML 回包 | — |
| 主动回复（异步） | ✅ response_url（**每 URL 仅 1 次，有效期 1 小时**） | ✅ `aibot_send_msg`（**需用户先发过消息**） | ✅ message/send（access_token） | ✅ webhook |
| 流式回复 | ✅ `stream` 类型（回调轮询刷新，用户发消息起最长 6 分钟） | ✅ 主动推送流式刷新（10 分钟内 finish） | ❌ | ❌ |
| 模板卡片交互 | ✅ 按钮/选择器/表单卡片 + 点击事件回调 | ✅ 同左（事件 5s 内需响应更新卡片） | ✅ | ✅（仅推送展示型） |
| 欢迎语 | ✅ 首次进入单聊自动触发 | ✅ 同左 | 手动 | — |
| 媒体加密 | AES-256-CBC（与回调 AESKey 相同），下载 URL 5 分钟有效 | 同左 | media_id（临时素材） | media_id（3 天） |
| 鉴权 | 回调签名（Token）+ 消息体 AES（EncodingAESKey） | BotID + Secret 握手 | access_token（corpid+secret） | webhook key（泄露即滥用） |
| 频率限制 | 单会话 30 条/分、1000 条/时（见 101463）；用户同时最多 3 条消息在途 | 同左；24h 内可回复该会话 | 单成员 30 次/分、1000 次/时；每天 账号数×200 人次 | **每机器人 20 条/分** |
| 部署要求 | 公网 HTTPS 回调 URL（URL 验证）+ 自定义 Token/43 位 EncodingAESKey | **纯出站 WebSocket，无公网入口** | 公网 HTTPS 回调 URL + 可信 IP 白名单 | 无 |

### 2.3 回调验证与消息加解密（URL 回调模式，与自建应用同源方案）

官方文档：[101033 回调和回复的加解密方案](https://developer.work.weixin.qq.com/document/path/101033)、[90930 回调配置](https://developer.work.weixin.qq.com/document/path/90930)、[90968 加解密方案说明](https://developer.work.weixin.qq.com/document/path/90968)

- **URL 有效性验证**（保存配置时，GET 请求）：
  - 参数：`msg_signature`、`timestamp`、`nonce`、`echostr`。
  - 流程：按 Token + timestamp + nonce + echostr 字典序拼接 → SHA-1 得签名 → 比对 `msg_signature` → 用 EncodingAESKey（AES-256-CBC，IV=Key 前 16 字节）解密 `echostr` → **1 秒内**原样返回明文（不能加引号/换行/BOM）。
- **回调消息解密**（POST）：body 为 `{"encrypt":"..."}`，解密后得到明文 JSON；智能机器人场景 `receiveid` 传空字符串。
- **被动回复加密**：构造明文 JSON → AES 加密 → 回包 `{encrypt, msgsignature, timestamp, nonce}`。
- 签名算法：参数值字典序排序拼接 + SHA-1，hex 小写。
- 官方提供 C++/Python/PHP/Java/C# 加解密库与 Python 示例。

### 2.4 消息类型与收发限制汇总

**智能机器人支持的消息（msgtype）**：text、image、mixed（图文混排）、voice（语音自动转文本）、file（≤100M）、video（≤100M）；回调字段含 `msgid`（排重）、`aibotid`、`chatid`（群）、`chattype`（single/group）、`from.userid`、`response_url`、`quote`。

**发送限制（长连接模式，官方 101463）**：
- 回复或主动推送：**每会话 30 条/分钟、1000 条/小时**。
- 收到消息回调后 24 小时内可回复该会话。
- 主动推送需用户先在该会话发过消息。
- 流式消息从发送起 10 分钟内必须 `finish=true`。
- 模板卡片点击事件需 5 秒内响应更新。
- 心跳建议 30 秒一次。

**URL 回调模式补充限制**：用户与同一机器人**最多同时 3 条消息交互中**；流式刷新最长 6 分钟（企微持续轮询开发者回调 URL 获取刷新内容）。

**群机器人 webhook**：**每机器人 ≤ 20 条/分钟**；文本 ≤2048 字节、markdown ≤4096 字节；文件 5B~20M、语音 ≤2M/60s AMR；外部群不支持；webhook 泄露可被滥用发垃圾消息。

**自建应用 message/send**：单成员 ≤30 次/分、≤1000 次/时；每天 ≤ 账号上限数×200 人次；基础频率每企业单 cgi ≤1 万次/分、15 万次/时；建议避开整点 0/30 分调用。

### 2.5 主动推送 vs 被动响应（智能机器人）

- **被动响应**：用户消息 → 回调 → 同步加密回包（欢迎语 / 回复消息 / 更新模板卡片）。适合实时问答。
- **主动回复**：回调携带 `response_url`（每个回调一次、1 小时有效）→ 异步 POST 回复。适合「先回执、再异步完成」的 Agent 模式。
- **主动推送（长连接）**：`aibot_send_msg`，无需消息触发，适合定时提醒 / 任务完成通知（这正是 Finch Space 任务回推所需）。

---

## 3. 对接方案设计

### 3.1 方案选型

| 方案 | 模式 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 智能机器人 · 长连接**（推荐） | WebSocket（BotID+Secret） | 无需公网/备案/穿透；纯出站连接，与微信 Bot iLink 架构同构；支持流式、模板卡片、主动推送 | 每机器人同时仅 1 个有效连接（单机单用户天然满足）；主动推送需用户先发言 | ✅ MVP 首选 |
| B. 智能机器人 · URL 回调 | HTTP POST（JSON 加密） | 标准 webhook；无连接保活负担 | 需要公网 HTTPS URL + 内网穿透/服务器；GET 验证 + AES 解密；腾讯云参考文档显示企业侧还有域名备案要求 | 备选（面向服务器部署形态） |
| C. 自建应用 | HTTP POST（XML 加密） | 成熟、文档全；可直接给成员发应用消息 | XML 协议；无流式；需可信 IP；交互链路重 | 不推荐（除非要做组织级应用消息） |
| D. 群机器人 webhook | 单向 POST | 零门槛 | 不能收消息，无法对话 | 仅作辅助通知通道（如 Finch 主动推送到群） |

> 附加观察：企微官方正在大力推 OpenClaw 插件（`npx -y @wecom/wecom-openclaw-cli install`，见 [智能机器人更新日志](https://work.weixin.qq.com/nl/index/openclaw)），支持本地终端扫码关联机器人——与 Finch 微信 Bot 的 iLink 思路同源。该插件的通道架构与官方 Node SDK 是 Finch 企微 Bot 最直接的参考与可复用依赖，详见第 6 章。

### 3.2 需要的组件清单（长连接方案）

1. **企微侧配置**（用户一次性操作）
   - 企业微信管理后台 → 安全与管理 → 管理工具 → 智能机器人 → 创建机器人（选「使用 API 创建」）→ 开启 API 模式 → 选「长连接」→ 获取 **BotID + Secret**。
   - 设置机器人名称/头像/可见范围（哪些成员可在通讯录看到并与其单聊/拉群）。

2. **扩展内组件**（复用微信 Bot 骨架）
   - `WecomLongConnClient`（新）：WebSocket 客户端——`aibot_subscribe` 握手、`aibot_msg_callback` 消息回调、`aibot_event_callback` 事件回调、`aibot_respond_msg` 回复、`aibot_send_msg` 主动推送、心跳 ping（30s）、重连退避（复用 `RECONNECT_BACKOFF_MS` 思路）。
   - `WecomMediaManager`（新）：下载 URL（AES-256-CBC 解密，Key 与回调同源）+ 发送文件/图片（长连接下媒体走 URL 或 base64 上传）。
   - `SessionContainer`（复用）：`finch.json` 新增 `{id:"wecom", mode:"inbox", agentProfile:"wecom-assistant"}`；agentProfile 人设对齐微信版「消息管家」，但注明企微职场语境、@机器人的群聊回复需点名。
   - `InboundRouter`（复用 handleInbound 骨架）：解析 msgtype → 文本/媒体附件 → pending wait 应答 → `ctx.sessions.send`。
   - `EventBridge`（复用 onDidReceiveEvent）：turn.waiting → 渲染卡片文本 → `aibot_respond_msg`/`aibot_send_msg`；turn.completed → 回复。
   - `TaskManager`（复用）：Space 任务派发，完成时 `aibot_send_msg` 回推。
   - `WecomConfigMenu`（复用 settingsMenu）：显示连接状态（已连接/未连接/BotID）、引导「如何创建智能机器人并填入 BotID/Secret」。
   - 工具：`wecom_send`（主动推送）、`wecom_space_task`（任务派发）、`wecom_new`（新对话）。

3. **会话映射设计**
   - 身份主键：`corpid + aibotid + userid`（单聊）或 `corpid + aibotid + chatid`（群聊）。群聊里多人与机器人交互时，按 `from.userid` 区分发言人，整群共用一个 Finch Session（群聊天然是共享上下文）。
   - 存储键（对齐微信 Bot 的 storage 前缀风格）：`wecom:activeSession`、`wecom:session:<peerKey>`、`wecom:turn:<turnId>`、`wecom:task:*`、`wecom:wait:*`。
   - `msgid` 做入站幂等去重（企微可能重复回调）。
   - userid 说明：若机器人创建者是超管，userid 明文；否则为加密 userid，可通过「[自建应用与智能机器人的对接](https://developer.work.weixin.qq.com/document/path/100719)」转明文（MVP 可先直接以原值作为 peerKey）。

### 3.3 架构图（文字描述）

```
企微用户（手机/PC）
   │ 单聊机器人 / 群聊 @机器人（text/image/mixed/voice/file/video）
   ▼
企微服务器（智能机器人 · 长连接 API 模式）
   │ ① aibot_msg_callback（WebSocket 入站，msgid 幂等）
   ▼
┌───────────────────── Finch 桌面端（本地） ─────────────────────┐
│ finch-wecom-bot 扩展                                            │
│                                                                │
│  WecomLongConnClient ──心跳 ping/30s + 断线重连退避──┐          │
│        │  ② 回调分发                                      │          │
│        ▼                                                  │          │
│  InboundRouter: msgid 去重 → 应答 pending wait(#code)      │          │
│        → 解析文本/媒体 → ctx.sessions.send(wecom 容器会话)  │          │
│        │                                                  │          │
│  Session 容器 (id=wecom, inbox, agentProfile: 企微消息管家)│          │
│        │  onDidReceiveEvent                               │          │
│  EventBridge: turn.waiting → 卡片文本 → aibot_respond_msg  │          │
│               turn.completed → 回复文本/图片 → 同上          │          │
│               turn.failed → 错误提示                         │          │
│  TaskManager: wecom_space_task → Space Session 任务         │          │
│        → 完成/失败 → aibot_send_msg 主动推结果到企微          │          │
│  Agent 工具: wecom_send / wecom_space_task / wecom_new      │          │
│  SettingsMenu: 连接状态 + 配置引导（BotID/Secret）            │          │
└──────────────────────────────────────────────────────────────┘
   │ ③ aibot_respond_msg（回复）/ aibot_send_msg（主动推送）
   ▼
企微用户
```

### 3.4 与微信 Bot 的对照：哪里改、哪里不动

| 层 | 微信 Bot（现状） | 企微 Bot（目标） | 改动量 |
|---|---|---|---|
| Finch SDK 对接（sessions/tools/storage） | iLink 之上 | 直接复用 | 0 |
| 容器/人设声明 | wechat inbox | wecom inbox（新增） | 小 |
| 传输 | iLink 长轮询 HTTP | 企微 WebSocket 长连接 | 大（新写客户端，协议有官方示例） |
| 媒体 | CDN + AES-128-ECB | 企微 URL + AES-256-CBC / media_id | 中（加解密算法不同） |
| 身份 | 微信 userId / context_token | corpid+aibotid+userid/chatid | 中 |
| 登录 | 扫码（iLink 二维码） | 后台配置 BotID/Secret（无登录流） | 中（更简单） |
| 等待卡片 | #code + 自然语言应答 | 同左；可升级为模板卡片按钮 | 小 |

### 3.5 MVP 范围（最小可行）

**MVP 包含**：
- 企微智能机器人长连接接入（BotID/Secret 配置、连接/心跳/重连/退出）。
- 单聊文本 + markdown 收发（用户 → Finch Session → 回复）。
- 群聊 @机器人收发（一个群一个 Finch Session，按 userid 标记发言者）。
- 等待卡片中继（权限/提问文本化 + #code 应答）。
- `wecom_space_task`（create/send/status + 完成回推）。
- 图片/文件接收（AES-256-CBC 解密）。

**MVP 不包含**（二期）：
- 流式回复（stream 刷新）、模板卡片按钮交互（可选一期后增强）。
- 主动推送定时任务（wecom_send 定时场景）。
- 多机器人/多企业管理、加密 userid → 明文 userid 转换。

---

## 4. MVP 步骤清单

1. **企微侧准备**：企业微信管理后台创建「智能机器人」（API 创建 → 长连接模式），记录 BotID / Secret；设置可见范围（建议先只对本人）。
2. **扩展骨架**：`finch-wecom-bot` 目录（拷贝 wechat-bot 的 tsconfig/esbuild/finch.json 骨架），注册 `wecom` sessionContainer + `wecom-assistant` agentProfile + permissions。
3. **长连接客户端**：实现 WebSocket 连接（`aibot_subscribe` 握手、错误码处理）、30s 心跳、断线退避重连（复用微信 Bot 的 backoff 数组）、`aibot_msg_callback` 事件分发。
4. **入站管线**：msgid 去重 → 按 msgtype 解析文本/媒体（voice 转文字字段、image/file 下载解密）→ 应答在途 wait → `ctx.sessions.send`。
5. **出站管线**：`onDidReceiveEvent` 桥接 → `aibot_respond_msg`（回复）/ `aibot_send_msg`（主动推送）→ markdown 文本 + 图片。
6. **等待卡片中继**：移植 #code 机制（permission/question/form → 文本化渲染 → 应答）。
7. **Space 任务**：移植 TaskManager + `wecom_space_task` 工具 + 完成回推。
8. **配置与状态菜单**：settingsMenu 显示连接状态、BotID、重连/断开；扩展设置字段（BotID/Secret 存 `ctx.storage`，密文本地保存）。
9. **联调与打磨**：真实企微账号端到端（单聊、群聊 @、图片、任务派发、权限提问）；处理断线重连与消息丢失边界；README（中英）。
10. **发布**：按 [minitools-publishing.md](./minitools-publishing.md) 打包发布，或提交至 finch-releases 社区。

---

## 5. 风险与限制清单

| # | 风险 / 限制 | 等级 | 说明与缓解 |
|---|---|---|---|
| 1 | **长连接单连接限制**：每机器人同时仅 1 个有效连接 | 中 | Finch 本地单实例天然满足；多设备同时开启需提示"后连者踢掉先连者"或引导使用 URL 回调模式 |
| 2 | **主动推送前置条件**：用户必须先给机器人发过消息，才能 `aibot_send_msg` | 中 | 任务回推依赖此限制；引导用户先与机器人对话一次（可在 README/欢迎语中说明） |
| 3 | **频率限制**：单会话 30 条/分、1000 条/时（长连接） | 中 | Finch 回复通常是单条聚合；需在 TaskManager 回推与流式场景做节流/合并，参考微信 Bot 的队列拒绝处理（receipt rejected） |
| 4 | **回复时限**：流式 10 分钟内 finish；模板卡片事件 5 秒内响应；用户同时最多 3 条消息在途 | 中 | 长任务用「先回执、异步推送」模式（response_url / aibot_send_msg），避免同步超时；Finch 长任务天然异步，适合 |
| 5 | **userid 加密**：机器人创建者非超管时回调 userid 为加密值 | 低 | MVP 直接当 peerKey 用；如需关联通讯录再接入「自建应用与智能机器人的对接」转明文 |
| 6 | **媒体时效**：媒体下载 URL 5 分钟有效；AESKey 与回调同源（泄露即所有媒体可解） | 中 | 收到即下载解密转存；密钥只存本地 storage，不落日志 |
| 7 | **公网依赖（URL 回调备选方案）**：需 HTTPS 回调地址 + 内网穿透；部分第三方集成文档提示企业对接还有域名备案要求 | 高（仅备选方案） | 长连接方案完全规避；若选回调模式需准备穿透/服务器与合规域名 |
| 8 | **群机器人 webhook 局限**：20 条/分、不能收消息、外部群不支持 | — | 不用它做对话主通道；可选作「Finch 结果广播到群」的辅助通道（webhook 泄露风险需防） |
| 9 | **重复回调**：企微可能因网络原因重复推送同一 msgid | 低 | 必须按 msgid 去重（微信 Bot 已有 idempotencyKey 思路可借鉴） |
| 10 | **连接生命周期**：桌面端休眠/杀进程导致断线，恢复后需重连 | 中 | 复用微信 Bot 的 `activationEvents:["onStartup"]` 自动恢复 + 退避重连；断线期间消息企微侧可能丢弃或延迟 |
| 11 | **合规与安全**：企业数据（会话内容）进入本地模型处理；Secret 属敏感凭证 | 高 | 隐私说明中明确「消息仅本地处理、不上传」；Secret 存本地 storage 不打印不注入对话；遵循 Finch Red Lines |
| 12 | **平台策略**：智能机器人属较新能力（2025 年推出），接口可能演进；OpenClaw 插件同赛道 | 低 | 锁定文档版本；协议层做薄封装，便于跟随官方更新 |

---

## 6. OpenClaw 企微插件调研（补充）

> 调研对象：OpenClaw（开源 AI agent 框架，原名 Clawdbot / Moltbot）的企业微信接入方案，重点评估其官方插件/适配器、消息通道抽象、以及能否直接复用其企微接入层。

### 6.1 背景：OpenClaw 与企微官方接入

- **OpenClaw**（github.com/openclaw/openclaw，MIT，原 Clawdbot，更早为 Moltbot；本地源码可见 `~/Workspace/aeolus/openclaw`，CHANGELOG 中仍保留对 `CLAWDBOT_*` / `MOLTBOT_*` 旧环境变量的兼容提示）是自托管个人 AI 助手框架，核心是「Gateway + 多消息通道（channel）插件」架构，支持 WhatsApp/Telegram/Slack/Discord/Feishu/LINE/WeChat/QQ 等 20+ 通道。
- **企微官方已提供 OpenClaw 通道插件**，由腾讯企微团队维护，发布在 GitHub `WecomTeam` 组织与 npm：
  - `@wecom/wecom-openclaw-plugin`（通道插件本体，93 个版本，v20206.7.201）
  - `@wecom/aibot-node-sdk`（**智能机器人 WebSocket 长连接官方 Node SDK**，可直接被任何 Node 应用使用）
  - `@wecom/wecom-openclaw-cli`（安装/配置/诊断脚手架：`npx -y @wecom/wecom-openclaw-cli install`，交互输入 BotID + Secret）
- 微信侧同源参考：`@tencent-weixin/openclaw-weixin`（微信个人号通道，finch-wechat-bot 的 iLink 协议即对齐其 2.4.6 版本）。

### 6.2 官方接入栈与能力

```
企微智能机器人（长连接 / Webhook）
   ▲
   │ wss://openws.work.weixin.qq.com（长连接）或 HTTP 回调（webhook）
   ▼
@wecom/aibot-node-sdk   ← 协议层官方实现：认证帧、心跳、重连、消息分发、
                         流式回复、模板卡片、媒体解密/上传（可独立使用）
   ▲
@wecom/wecom-openclaw-plugin  ← OpenClaw 通道插件：接入 OpenClaw Channel SDK，
                                 访问控制、动态 Agent 路由、MCP 工具、15 个 Skills
   ▲
@wecom/wecom-openclaw-cli     ← 安装/更新/诊断脚手架
```

插件能力（官方 README）：
- **双模式**：Bot（智能体：WebSocket 长连接默认 / HTTP webhook 可选，JSON）+ Agent（自建应用：HTTP webhook，XML 加密回调），可独立或并行；**Bot-first、Agent-fallback** 外发投递（WS 不可用时自动走应用 API）。
- 单聊 DM + 群聊；主动消息推送（用户/群/部门/标签）；图片/语音（转文字）/视频/文件/图文混排接收与自动下载；引用消息（quote）；流式回复（含「思考中」占位消息）；Markdown 回复；模板卡片（含点击事件回调）。
- 访问控制：`dmPolicy`（pairing / open / allowlist / disabled）、`groupPolicy`（open / allowlist / disabled）、每群白名单。
- 多账号；`wecom_mcp` 工具 + 拦截器管道；15 个内置 Skills（通讯录、文档、待办、会议、日程、消息、智能表、模板卡片等）。
- 媒体策略：20MB 上限；图片 10MB / 视频 10MB 超限自动降级为文件；语音 2MB 且仅 AMR，否则转文件。
- 网络策略：`egressProxyUrl`（可信 IP 场景出口代理）、超时/重试可配。
- 工程细节：心跳保活、最多 10 次重连、5 次认证失败重试、**anti-kick 保护**（抑制服务端断连时的自动重启，防止多端互踢死循环）。

### 6.3 消息通道抽象：OpenClaw 如何对接企微

从本地 OpenClaw 源码（`src/plugin-sdk/`、`extensions/feishu/`）可提炼出 OpenClaw 的通道插件契约，企微插件即实现这一契约：

| OpenClaw 通道抽象 | 作用 | 企微插件的实现对应 |
|---|---|---|
| `defineBundledChannelEntry({id, name, plugin, secrets, runtime})` | 通道入口声明 | `id: "wecom"`，plugin/secrets/runtime 分离 |
| `createChatChannelPlugin`（channel-core） | 通道插件工厂 | wecom 通道插件主体 |
| `ChannelMessageAdapterShape {send, receive, live, durableFinal}` | 消息收发适配器 | send：`aibot_respond_msg`/`aibot_send_msg`；receive：`aibot_msg_callback` 分发 |
| `ChannelMessageReceiveAdapterShape.defaultAckPolicy` | 接收确认策略（after_receive_record / after_agent_dispatch / after_durable_send / manual） | 对应企微 `req_id` 回执语义 |
| `ChannelMessageLiveAdapterShape`（nativeStreaming 等能力位） | 流式/占位消息能力声明 | 流式回复 + 思考中占位 |
| `getSessionBindingService`（conversation-runtime） | 会话绑定（用户/群 ↔ Agent 会话） | 动态 Agent 路由（见 6.4） |
| `createPairingPrefixStripper`（channel-pairing） | 配对码/前缀剥离 | DM pairing 策略（类似 Finch 微信 Bot 的 #code 应答） |
| `normalizeMessagePresentation` / `renderMessagePresentationFallbackText` | 交互式消息渲染 | 模板卡片、富文本渲染 |
| `createRuntimeOutboundDelegates` | 主动外发 | `aibot_send_msg`（定时提醒/任务结果） |
| secret-contract / setup-core / setup-surface | 密钥管理与登录/配置向导 | `openclaw channels add` 交互式输入 BotID/Secret |

> 关键结论：**OpenClaw 的通道抽象与 Finch mini tool 的 Session 容器/等待卡片/任务派发模型在概念层面高度同构**（都是「消息通道 → 会话绑定 → Agent 处理 → 异步回推 + 交互卡片」）。但 OpenClaw 通道插件强依赖其 plugin-sdk 运行时，**不能把 `@wecom/wecom-openclaw-plugin` 直接装进 Finch**；真正可复用的是底层协议 SDK `@wecom/aibot-node-sdk`（无 OpenClaw 依赖，CJS/ESM 双格式 + TS 类型）。

### 6.4 会话管理与路由：动态 Agent 路由

企微插件的「**动态 Agent 路由**」机制与 Finch 的 Session 容器/会话映射解决的是同一个问题——多用户、多群共用一条消息通道时如何隔离上下文：

| 维度 | OpenClaw 企微插件 | Finch mini tool（微信 Bot 模式） | 企微 Bot 建议 |
|---|---|---|---|
| 会话主键 | 每用户 / 每群自动创建隔离 Agent | `KEY_ACTIVE_SESSION`（单活跃会话，peerId 映射） | 单聊：`corpid+aibotid+userid`；群聊：`corpid+aibotid+chatid` |
| 群聊发言区分 | 消息带 `from.userid`，路由到对应 Agent | 群聊不适用（微信 Bot 仅 owner 单聊） | 群聊共用一个 Finch Session，消息内标注发言人 |
| 上下文生命周期 | Agent 常驻，可手动新建 | 「开个新对话」= 新 Session，旧会话留 inbox | 同微信 Bot：`wecom_new` 工具 |
| 访问控制 | dmPolicy / groupPolicy / allowlist | owner 白名单（`KEY_OWNER_USER` 之外的消息忽略） | 复用 owner 模式 + 可选的 groupPolicy 白名单 |

> 参考价值：企微插件的 pairing 策略（用户需先配对才能私聊）与 Finch 微信 Bot 的 owner 过滤异曲同工；其「按 chatid 路由 + 按 userid 区分发言人」的群聊模型可直接照搬。

### 6.5 与 Finch mini tool 模式的契合度

| 对比项 | OpenClaw 通道插件 | Finch mini tool（企微 Bot 设想） | 契合度 |
|---|---|---|---|
| 运行时 | OpenClaw Gateway（独立进程/容器） | Finch 桌面端扩展（`activate()` 生命周期） | 同构：都是本地常驻 Agent 入口 |
| 通道接入 | plugin-sdk 通道契约 | `ctx.sessions` / `onDidReceiveEvent` | 概念对齐，API 不同 |
| 会话模型 | 动态 Agent 路由 | Session 容器 + 映射 | 对齐 |
| 交互卡片 | 模板卡片 + 事件回调 | 等待卡片中继（#code / 自然语言） | 企微侧更富交互（按钮/选择器），可后续增强 |
| 流式 | 原生流式 + 思考占位 | 无流式（一次性回复） | 企微提供能力位，Finch 侧需适配 turn 事件流 |
| 主动推送 | `aibot_send_msg`（需用户先发言） | `wechat_send` / 任务回推 | 对齐，均有前置条件 |
| 部署形态 | 需要 OpenClaw 全家桶 | 单一 mini tool + `@wecom/aibot-node-sdk` | Finch 更轻 |

结论：**Finch 做企微 Bot 不必自研协议，也不必引入 OpenClaw**——直接依赖官方 `@wecom/aibot-node-sdk`，把「SDK 事件 → Finch Session」桥接起来即可，整体复杂度低于跑一套 OpenClaw + 插件。

### 6.6 可借鉴点清单（直接用于 Finch 企微 Bot）

1. **直接用 `@wecom/aibot-node-sdk` 做传输层**：认证、心跳、指数退避重连（1s→30s）、消息分发（`message.text/image/mixed/voice/file`）、流式回复、模板卡片、媒体解密（AES-256-CBC 独立 aeskey）、媒体分片上传——全部官方实现，免自研协议。微信 Bot 的 iLink 自研层可整体退役。
2. **anti-kick 保护**：企微单机器人同时仅 1 个长连接；SDK/插件对服务端断连不盲目自动重启，避免多端互踢。Finch 需保留「用户手动重连」入口（复用 settingsMenu）。
3. **Bot-first、Agent-fallback**：长连接不可用时回退到应用 API 推送（保通知不丢）。Finch MVP 可只做 Bot 模式，二期加 fallback。
4. **媒体降级策略**：图片 10MB / 视频 10MB / 语音 2MB(AMR) 超限自动转文件发送，上限 20MB——直接抄这套阈值。
5. **会话路由模型**：按 `chatid` 建 Session、按 `userid` 标发言人（群聊），单聊按 userid 一对一。
6. **配对/白名单策略**：`pairing` / `allowlist` / `disabled` 三档私聊策略 + 群白名单，比微信 Bot 的 owner-only 更灵活，可作配置项。
7. **流式「思考中」占位**：Finch 长任务处理时先推「正在处理…」占位，再推最终结果（企微 Bot 模式支持流式刷新，体验接近桌面端）。
8. **CLI/向导式配置**：`openclaw channels add` 的交互输入 BotID/Secret 体验，可映射为 Finch 扩展的 settingsMenu 引导流程。

### 6.7 复用边界与风险

- ✅ **可复用**：`@wecom/aibot-node-sdk`（MIT，独立包）、长连接协议知识、媒体/频率限制经验值、路由模型。
- ❌ **不可直接复用**：`@wecom/wecom-openclaw-plugin`（依赖 OpenClaw plugin-sdk 与 Gateway 运行时）、其 15 个 Skills 与 `wecom_mcp`（属于 OpenClaw 生态，Finch 侧用自身工具体系替代，或后续用 MCP 客户端对接同源能力）。
- ⚠️ **版本耦合**：插件与 OpenClaw 版本有严格兼容矩阵（README 明确 2026.3.22 前后需配对应插件版本）；Finch 若依赖 SDK 需锁定语义化版本并跟踪企微协议更新。
- ⚠️ **账号绑定**：SDK 依赖企微智能机器人（BotID/Secret），与自建应用（Agent 模式）是两套凭证体系；企业侧需管理员在管理后台创建机器人并授权可见范围。

---

## 7. 信息来源

**Finch 侧（代码路径，本仓库）**
- `extensions/wechat-bot/finch.json`、`src/index.ts`、`src/ilink-client.ts`、`src/auth.ts`、`src/media.ts`、`src/tasks.ts`、`src/types.ts`、`src/utils.ts`、`i18n/zh-CN.json`
- `docs/mini-tool-developer-guide.md`（sessionContainers / agentProfiles / onDidReceiveEvent 章节）

**OpenClaw 侧（本地源码与官方仓库）**
- OpenClaw 本地源码：`~/Workspace/aeolus/openclaw`（通道 SDK：`src/plugin-sdk/channel-core.ts`、`src/plugin-sdk/channel-message.ts`、`src/channels/message/types.ts`；通道示例：`extensions/feishu/src/channel.ts`）
- `@wecom/wecom-openclaw-plugin`（企微官方 OpenClaw 通道插件）：https://github.com/WecomTeam/wecom-openclaw-plugin
- `@wecom/aibot-node-sdk`（企微智能机器人 Node SDK）：https://github.com/WecomTeam/aibot-node-sdk
- `@wecom/wecom-openclaw-cli`（安装脚手架，npm README）
- `@tencent-weixin/openclaw-weixin`（微信个人号 OpenClaw 通道，finch-wechat-bot iLink 协议参考）
- 企微智能机器人 OpenClaw 更新日志：https://work.weixin.qq.com/nl/index/openclaw

**企业微信官方文档**
- 智能机器人概述（API 模式）：https://developer.work.weixin.qq.com/document/path/101039
- 智能机器人接收消息：https://developer.work.weixin.qq.com/document/path/100719
- 智能机器人接收事件：https://developer.work.weixin.qq.com/document/path/101027
- 智能机器人被动回复消息：https://developer.work.weixin.qq.com/document/path/101031
- 智能机器人模板卡片类型：https://developer.work.weixin.qq.com/document/path/101032
- 智能机器人回调和回复的加解密方案：https://developer.work.weixin.qq.com/document/path/101033
- 智能机器人主动回复消息：https://developer.work.weixin.qq.com/document/path/101138
- 智能机器人长连接：https://developer.work.weixin.qq.com/document/path/101463
- 消息推送（原群机器人）配置说明：https://developer.work.weixin.qq.com/document/path/91770
- 发送应用消息：https://developer.work.weixin.qq.com/document/path/90236
- 接收消息与事件（自建应用）：https://developer.work.weixin.qq.com/document/path/90239
- 回调配置：https://developer.work.weixin.qq.com/document/path/90930
- 加解密方案说明：https://developer.work.weixin.qq.com/document/path/90968
- 访问频率限制：https://developer.work.weixin.qq.com/document/path/90312
- 企微帮助中心「消息推送」：https://open.work.weixin.qq.com/help2/pc/14931
- 智能机器人更新日志（OpenClaw 官方插件）：https://work.weixin.qq.com/nl/index/openclaw

**第三方参考**
- 腾讯云智能体发布到企微智能机器人（两种接入模式与限制）：https://cloud.tencent.com/document/product/1759/121473
- go-sphere/wecom-bot-api（官方文档镜像，含流式 6 分钟说明）：https://github.com/go-sphere/wecom-bot-api
- easy-wx/wecom-bot-svr（群机器人回调服务框架，参考实现）：https://github.com/easy-wx/wecom-bot-svr
- 腾讯云告警-企微群机器人（20 条/分限制佐证）：https://cloud.tencent.com/document/product/248/50413
