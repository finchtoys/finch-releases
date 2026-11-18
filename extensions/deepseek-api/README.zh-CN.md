# DeepSeek API

一个 DeepSeek API Key，给 Finch 带来三种能力：

| 能力 | 说明 |
| --- | --- |
| 网页搜索 | 按关键词搜索，返回带 url、摘要、可选正文的结构化结果 |
| 网页阅读 | 读一个链接，把页面转成 Markdown |
| OCR | 识别 PDF、Word、PowerPoint 和图片（PNG / JPEG / WebP / GIF / BMP / TIFF）里的文字 |

三者都是 DeepSeek 的原始工具 API（`/v1/tools/search`、`/v1/tools/fetch`、`/v1/tools/ocr`），共用同一个 Bearer Key，所以只需要配一次。

## 安装

```bash
npx @finchtoys/minitools add .
```

装完在工具箱里启用 **DeepSeek API**。

## 配置 Key

两种方式都行，Key 一律存进系统安全存储（Keychain / DPAPI / Secret Service），不写配置文件，也不会返回给模型：

- 在工具箱的 DeepSeek API 卡片上点齿轮 → **配置 API Key**；
- 或者直接让 Finch 帮你连接，工具会用安全表单收集。

Key 在 <https://platform.deepseek.com/api_keys> 创建。

## 工具

### `deepseek_api`

一个工具，四个 action：

| action | 必填 | 说明 |
| --- | --- | --- |
| `search` | `query`（1–128 字符，支持 `site:`、`-site:`、引号） | `count` 1–20（默认 5）、`need_content`（默认 false） |
| `fetch` | `url` | 返回 `# 标题` + Markdown 正文 |
| `ocr` | `path`（本地文件）**或** `url`（远程文件） | `purpose`：`text_recognition`（默认）或 `rich_layout_recognition` |
| `status` | 无 | 确认是否已配置 Key，并显示账户余额 |

### `setup_deepseek_api`

用安全表单收集 Key，并调用余额接口验证是否可用。

## 限制与计费

以下由 DeepSeek 规定，不是本小程序加的：

- Search 与 Fetch 按每 1,000 次成功请求计费（5 元）；失败请求与空结果不计费。
- OCR 按识别成功的页数计费，每 1,000 页 1.5 元；识别失败或超时不计费。文件接收完成后断开连接不会取消识别，完成的照常计费。
- OCR 单文件上限 100 MiB、1,000 页，总时长 180 秒；每账号最多同时 15 个识别，超过返回 429。工具已声明对应超时，大文件会等待而不是提前失败。
- `rich_layout_recognition` 会保留每页的 `<ref>` / `<box>` 坐标标记；`finish_reason` 为 `length` 的页会标注为不完整。

## 隐私

Key 只存在安全存储的 `deepseek.apiKey` 这一个键下，只会发往 `api.deepseek.com`，不额外持久化任何内容。

## 开发

```bash
npm install
npm run build
npx @finchtoys/minitools doctor .
npx @finchtoys/minitools add .
```
