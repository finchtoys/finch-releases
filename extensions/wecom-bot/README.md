# WeCom Box · Finch 企业微信 Bot

通过企业微信官方智能机器人 WebSocket 长连接，把企业微信单聊和群聊接入 Finch。

## 能力

- 使用企业微信官方 `@wecom/aibot-node-sdk`，自动认证、心跳和断线重连。
- 无需公网 IP、回调 URL、Token 或 EncodingAESKey。
- 支持文本、语音转文字、图片、图文混排、文件和视频入站。
- 单聊按 `userid`、群聊按 `chatid` 映射到独立 Finch Session。
- Finch 完成处理后通过流式消息回复；进程重启后可回退为主动推送。
- 提供主动发送文本和本地媒体文件的 Agent 工具。
- BotID 与 Secret 只存入 Finch 系统安全存储，不写入明文配置或 storage。

## 配置

1. 在企业微信管理后台创建或打开智能机器人。
2. 开启「API 模式」，选择「长连接」。
3. 获取长连接专用 `BotID` 和 `Secret`。
4. 在 Finch 的 WeCom Box 设置菜单中选择「配置连接」，填入凭证并连接。
5. 向机器人发送消息。对应会话会出现在「企业微信收件箱」。

官方文档：[智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)

> 企业微信限制同一个 BotID 同时只能保留一个有效长连接；新连接会踢掉旧连接。

## Agent 工具

- `wecom_box_session`
  - `list`：列出已知单聊/群聊的 `peerKey`。
  - `new`：为指定 `peerKey` 开启新的 Finch Session。
- `wecom_box_send`
  - 向指定 `peerKey` 发送 Markdown 文本或本地媒体文件。

## 与 Finch WeChat Bot 的设计关系

两者复用同一条桥接主线：

```text
外部消息 → 平台接入层 → Finch Session → Agent 处理 → Session durable event → 平台回复
```

主要差异：

| 项目 | WeChat Bot | WeCom Box |
|---|---|---|
| 接入协议 | 微信 iLink 长轮询 | 企业微信官方 WebSocket SDK |
| 登录 | 微信扫码 | BotID + 长连接 Secret |
| 会话主体 | 登录账号为主 | 多成员单聊 + 多群聊 |
| 会话映射 | 活跃 Session | 每个 userid/chatid 独立 Session |
| 回复 | context token / iLink API | 原始 req_id 流式回复或 chatid 主动推送 |
| 媒体 | 微信 CDN 协议 | SDK 下载解密、分片上传 |
| 公网服务 | 不需要 | 不需要 |

## 本地开发

```bash
npm install
npm run check
npx @finchtoys/minitools doctor .
npx @finchtoys/minitools add .
```

## 企业微信限制

- 每个 BotID 同时只能有一个长连接。
- 主动推送前，用户需要先在对应会话里给机器人发过消息。
- 单个会话回复与主动推送合计限制为 30 条/分钟、1000 条/小时。
- 流式消息需在 10 分钟内以 `finish=true` 结束。
- 入站媒体下载 URL 仅 5 分钟有效。
- 上传素材有效期为 3 天；图片/视频最高 10MB、语音 2MB、普通文件 20MB。

## 安全

- `wecom.botId` 和 `wecom.secret` 通过 `ctx.secrets` 保存。
- 日志和工具结果不会输出 Secret。
- 媒体只在收到消息时下载并直接作为 Finch Session 附件传递，不持久化为业务 JSON。
