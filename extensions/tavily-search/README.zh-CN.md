## Tavily 搜索

Tavily 搜索小工具是 [Finch](https://finchwork.app/) 的扩展。Finch 是一款桌面 AI Agent，可在 [finchwork.app](https://finchwork.app/) 下载。启用后，Finch 就能用 Tavily 做网页搜索、内容提取、站点抓取和站点地图，给出带来源的答案。

## 使用方式

1. 启用 MCP Client 扩展。
2. 启用 Tavily Search 扩展。
3. 对 Finch 说：`帮我设置 Tavily Search`，在弹出的安全表单里填入 Tavily API Key。
4. 配置完成后，用 `/tavily-search` 进行网页研究。

需要 Tavily API Key，可在 [tavily.com](https://www.tavily.com/) 注册获取。

## 工具

- `setup_tavily_search`：填写 Tavily API Key 完成连接。
- `tavily_search_status`：查看 Tavily 是否已连接，以及当前可用的工具。

## 安全说明

Tavily API Key 通过 Finch 表单的 secret 字段收集，不会回显给模型，仅保存在本扩展的本地存储中；卸载 Tavily 时会一并清除。
