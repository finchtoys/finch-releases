# Notion

连接 Notion 到 Finch — 通过官方 Notion MCP 搜索页面、读取数据库、管理工作区。

## 工作原理

本扩展通过标准 OAuth 流程连接 Finch 到官方 Notion MCP 端点（`https://mcp.notion.com/mcp`）：

1. **RFC 9728** 受保护资源发现
2. **RFC 8414** 授权服务器发现
3. **RFC 7591** 动态客户端注册
4. **授权码 + PKCE**
5. 通过官方 MCP SDK 刷新令牌
6. 认证的 Streamable HTTP MCP 连接

无需管理 API 密钥或令牌 — 一切通过 Notion 官方 OAuth 流程完成。

## 快速开始

### 连接

点击 Composer 工具栏的 **Notion** 按钮，选择 **连接 Notion**。Finch 会直接打开原生 OAuth 授权弹框，随后可继续前往浏览器中的 Notion 授权页面。授权完成后，Finch 即可访问你的 Notion 工作区。

也可以直接对助手说：「连接 Notion」— 助手会调用 `notion_login` 工具。

### 使用 Notion 工具

连接成功后，助手可通过 ToolSearch 直接发现和调用 Notion MCP 工具。可用工具包括：

- **搜索** — 跨所有页面和数据库搜索
- **获取页面** — 读取页面内容和属性
- **创建页面** — 创建带内容的新页面
- **更新页面** — 编辑现有页面内容
- **获取数据库** — 查询数据库条目
- **获取用户 / 团队** — 列出工作区成员和团队

### 断开连接

点击 **Notion** 工具栏按钮 → **断开连接**。将移除本地保存的 OAuth 凭证。再次使用需要重新授权。

## 工具栏菜单

| 状态 | 菜单项 |
|---|---|
| 未连接 | 连接 Notion |
| 已连接 | 搜索页面 · 浏览数据库 · 断开连接 |

## Agent 工具

| 工具 | 说明 |
|---|---|
| `notion_login` | OAuth 连接 / 重新授权。直接启动 Finch 原生 OAuth 流程。用户要求连接时，或 Notion MCP 工具返回鉴权错误时，助手自动调用。 |

## 环境要求

- Finch 且已启用 MCP Client 扩展
- Notion 账号

## 隐私

OAuth 凭证仅保存在本地，不会共享。Notion 内容被视为不可信外部输入。
