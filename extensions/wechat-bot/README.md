# WeChat Bot · 微信 Bot

通过微信 iLink 把微信消息接入 Finch。通信流程参考 npm 包 [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) 2.4.6，并使用 Finch 1.5.1 / `@finchtoys/minitool-api` 0.2.6 的 Session Container 和原生 Modal 能力。

## 功能

- 在原生登录弹窗中显示微信二维码，不进入模型上下文
- 唯一登录微信账号对应一个当前 Finch Session，历史会话保留在 inbox；新会话标题带 UTC+8 创建时间
- Session Container 使用 `mode: "inbox"`
- 接收文本、语音转文字、图片、文件和视频
- 将 Finch 的最终回复自动发回微信
- 允许其他 Agent 主动发送微信文本消息
- 从微信创建 Space 任务、继续发送消息和查询状态
- 微信收件箱 SessionView 设置菜单提供登录、重连、重新登录和退出控制；独立登录项始终保留，并在状态切换后主动刷新

## 登录入口

微信收件箱的 SessionView 菜单中，「登录微信」和「重新登录」会直接打开原生二维码弹窗，不注册登录 Agent 工具，因此二维码和登录流程不会进入模型上下文。二维码有效期以微信服务端返回为准；扫码确认成功后扩展会主动关闭弹窗。每次新二维码都有独立轮询，旧登录不会阻塞新二维码的成功状态。

若 iLink 要求数字配对码，当前原生 Modal 无文本输入能力，扩展会提示重新获取二维码。

## Agent 工具

### `wechat_new`

立即创建一个新的微信 inbox Session，并把它设为当前会话。旧 Session 会保留；触发工具的当前 turn 仍从旧 Session 回复，之后收到的微信消息进入新 Session。

```json
{ "title": "可选的新会话标题" }
```

### `wechat_send`

向微信主动发送文本：

```json
{
  "message": "任务已经完成。",
  "recipient": "可选的微信 userId"
}
```

`recipient` 省略时发送给扫码登录的微信账号。

### `wechat_space_task`

通过 `action` 管理 Space 任务：

- `create`：需要 `spaceId`、`message`，可选 `title`、`notifyPeerId`
- `send`：需要 `taskId`、`message`
- `status`：可选 `taskId`、`waitMs`；不传 `taskId` 时列出全部任务

任务 Session 会出现在目标 Space 的正常会话列表中，并保留该 Space 的目录、规则和记忆。任务完成或失败后，如设置了 `notifyPeerId`，结果会自动发回微信。

## 登录流程

1. 在 ComposerAction 菜单点击「登录微信」。
2. 扩展直接请求 `get_bot_qrcode`。
3. 将 `qrcode_img_content` 编码为 PNG，通过 `ctx.ui.showModalDialog()` 的 Markdown data URI 展示。
4. 后台长轮询 `get_qrcode_status`。
5. 登录确认后保存 iLink 状态并自动启动 `getupdates` 消息循环。

支持 `wait`、`scaned`、`need_verifycode`、`scaned_but_redirect`、`confirmed`、`expired`、`verify_code_blocked` 和 `binded_redirect` 状态。

## Session 设计

- Container id：`wechat`
- Container mode：`inbox`
- 微信当前 Session：`background` + `acceptCalls` + `wechat-assistant` profile（微信消息管家）
- 唯一登录账号只维护一个当前 Session 指针
- `wechat_new` 创建新 Session 并切换指针，旧 Session 保留
- Space 任务使用 Space placement，不放进微信 inbox
- `turn.completed` 后将最终文本发回微信
- `turn.waiting` 会反映为任务等待状态

## 配置

| 字段 | 说明 |
|---|---|
| `botAgent` | iLink 后端日志归因标识，默认 `Finch/0.1` |
| `autoReply` | 是否把 Finch 回复自动发回微信 |

## 权限与数据

- `network`：访问微信 iLink API 和媒体 CDN
- `sessions`：创建并收发扩展拥有的 Finch Session

登录凭证、消息游标、当前 Session 指针和任务记录保存在扩展私有 `ctx.storage` 中。日志不会主动输出二维码 key、登录凭证或消息正文。

## 开发

```bash
npm install
npm run build
npx @finchtoys/minitools doctor .
```

运行依赖：

- `qrcode` 1.5.4
- `@finchtoys/minitool-api` 0.2.2
