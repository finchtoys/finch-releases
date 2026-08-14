# Dependencies · 依赖清单

## Runtime dependency

| Package | Version | Purpose | License |
|---|---|---|---|
| `@wecom/aibot-node-sdk` | 1.0.7（锁定） | 企微智能机器人 WebSocket 长连接官方 SDK（认证、心跳、重连、消息收发、流式回复、模板卡片、媒体上传/下载解密） | MIT |

> 安装：`npm install`（根据 `package-lock.json` 精确还原版本）。

## Dev dependencies

| Package | Version | Purpose |
|---|---|---|
| `@finchtoys/minitool-api` | 0.2.11 | Finch mini tool SDK 类型（`finch.d.ts`） |
| `@types/node` | ^26.1.1 | Node.js 类型 |
| `esbuild` | 0.28.1 | 打包（src → dist/index.js） |
| `typescript` | ^5.9.3 | 类型检查 / 编译 |

## SDK 传递依赖（自动安装）

`@wecom/aibot-node-sdk` 依赖 `axios`、`eventemitter3`、`ws`（构建后已 bundle 进 `dist/index.js`，运行时无需额外安装）。

## 无运行时服务依赖

- 不需要自建服务器 / 公网回调地址 / 内网穿透。
- 连接为出站 WebSocket：`wss://openws.work.weixin.qq.com`（长连接，默认）。
- 需要企微侧资源：一个「智能机器人」（API 模式 · 长连接）的 **Bot ID + Secret**，以及机器人可见范围授权。

## 验证命令

```bash
npm run typecheck   # tsc --noEmit
npm run build       # esbuild bundle → dist/index.js
npm test            # node scripts/smoke.mjs（7 项：加解密往返、媒体解密、@剥离）
```
