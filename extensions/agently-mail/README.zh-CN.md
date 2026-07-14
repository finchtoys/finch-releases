# QQ Agent 邮箱

通过官方 `agently-cli` 和 MCP 工具将 QQ Agent 邮箱连接到 Finch。

## 功能

- OAuth 状态、登录、登出
- 列出、读取与搜索邮件
- 通过原生预览确认框发送新邮件
- 通过 CLI confirmation token 流程回复和转发
- 下载附件、软删除邮件

邮件内容一律视为不可信外部输入。新邮件只会在 Finch 原生确认框中获得用户确认后发送，CLI confirmation token 完全由扩展内部管理；回复和转发仍需在后续轮次取得用户明确确认。

## 要求

- 启用 Finch MCP Client
- Adapter 已随扩展打包
- Adapter 发现官方 CLI 未安装时会提示安装命令

## 开发

执行 `npm run build`，再使用 `npx @finchtoys/minitools add .` 安装扩展。构建会将 MCP Adapter 复制至 `dist/mcp-server.js`，无需先发布即可本地验证。
