# finch-jev

Finch 小程序（mini tool）：把 Jev（[TypeSafe AI](https://docs.typesafe.ai/introduction/quickstart) 的
System One 模型）接进 Finch，注册一个 Agent 工具 `finch_jev_evaluate`。

Jev 不是聊天模型。它接收一段 `state`（待判断的文本）加一组带类型的 `questions`，
返回带概率和置信度的结构化答案：

| 问题类型 | 用途 | `criteria` |
|---|---|---|
| `choice` | 多选一（路由、分类） | 对象：选项 id → 说明，至少两项 |
| `score` | 打分（情绪强度、优先级） | 数组：从低到高的档位标签，至少两项 |
| `noul` | 是/否概率（0~1） | 不需要 |

Jev 只读一遍 `state`，所有问题并行评估，所以「一次调用多个问题」比「多次调用一个问题」更划算。

## 两个 Provider

两家提供**同一套契约**（同样的 `state` / `questions` / 答案结构），可以任选其一，也可以都配好：

| provider | 端点 | 默认 `model` | 去哪里拿 Key |
|---|---|---|---|
| `official` | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest` | [console.typesafe.ai](https://console.typesafe.ai) |
| `openrouter` | `POST https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |

选择顺序：工具参数 `provider` → 设置菜单里选中的那家 → 唯一配了 key 的那家 → `official`。
切换工具：小程序卡片上的设置按钮 → 「切换 Provider」子菜单（当前那家带选中标记）。

OpenRouter 走的是 **alpha Decisions router**，不是 OpenAI 兼容的 `/chat/completions` —— 这点很关键：
只有 Decisions 路由保留 typed questions 与校准概率，走 chat completions 就退回「让模型自己吐 JSON」，
概率也不再是校准的。OpenRouter 自己把 Jev 标为 `output_modalities: ["decisions"]`、
`has_text_output: false`，与 TypeSafe 的定位一致；它的公开模型列表里**不含**这两个 slug，
所以 OpenRouter 下执行 `action=models` 会直接告诉你该用哪两个 slug。

## 为什么不做成模型供应商

Finch 的自定义供应商只接受 `anthropic-messages` / `openai-completions` / `openai-responses`
三种 API 形状，而 Jev 是自定义 JSON 语义端点，因此它只能作为工具调用，不能进模型选择菜单。

## 安装与启用

```bash
cd ~/Workspace/aeolus/finch-releases/extensions/jev
npm install
npm run build
npx @finchtoys/minitools doctor ./
npx @finchtoys/minitools add ./ --dev   # --dev 建立软链，改完 npm run build 即可生效
```

装完还**不会自动启用**：到 Finch 的「工具箱 → 小程序」里点启用，确认它申请的权限（`network`），
这一步才会写入 `grantedPermissions` —— 没有这一步，运行时的网络与密钥访问都会被拦下。

启用后在工具的小程序卡片上点设置按钮。菜单**只显示当前那一家的状态**，不会把两家并排列出来：

```
TypeSafe — 已配置（ts_…abcd）
设置 TypeSafe API Key
测试 TypeSafe 连接
移除 TypeSafe API Key
──────────────
切换 Provider ▸     TypeSafe ✓ / OpenRouter
```

`✓` 是当前选中的那家；选中项存在小工具私有存储里，所以下次调用（`provider=auto`）就走它。

## 工具用法

一个工具、三个 action，外加一个 `provider` 参数：

- `evaluate`（默认）— 传入 `state` + `questions`，拿回答案；
- `models` — 列出该 provider 可用的模型（同时验证 key 是否有效）；
- `configure` — 用安全表单现场向用户要所选 provider 的 API key（key 缺失时 `evaluate` 也会自动弹这个表单）；
- `provider` — `auto`（默认）/ `official` / `openrouter`。

```json
{
  "action": "evaluate",
  "provider": "auto",
  "state": "客户催了三天，Stripe 一直连不上，很急。",
  "model": "jev-latest",
  "questions": {
    "urgency":    { "type": "noul",   "instructions": "这段话表达了紧迫性吗？" },
    "department": { "type": "choice", "instructions": "该由哪个团队处理？",
                    "criteria": { "billing": "支付/订阅问题", "technical": "故障/集成问题" } },
    "frustration":{ "type": "score",  "instructions": "客户的情绪强度",
                    "criteria": ["平静陈述", "有些不满", "非常生气"] }
  }
}
```

> `model` 只在显式传入时覆盖默认值：官方是 `jev-latest`，OpenRouter 是 `typesafe/jev-1.13`
> （或别名 `~typesafe/jev-latest`，永远指向最新版）。

## 图标

Finch 只认扩展根目录的 `icon.png`（`service.ts` 里硬编码 `existsSync(join(dir, "icon.png"))`），
不接受 SVG 文件路径，所以官方 SVG 需要栅格化：

- 素材：`assets/typesafe-mark.svg` —— 取自 TypeSafe console 的官方 favicon
  （`https://console.typesafe.ai/favicons/favicon_console-prod.svg`），本身已是黑底（`#111111`）白色立体方块
- 生成：`npm run icon`（ImageMagick），输出 300×300、8bit sRGB 不透明 PNG，与 `finch-notion` 等现有小程序的图标规格一致
- 换图标：替换 `assets/typesafe-mark.svg` 后重跑 `npm run icon` 即可

## 安全与边界

- 两家的 API key 各自独立，只存 `ctx.secrets`（系统钥匙串，`apiKey` / `openrouterApiKey`），
  不写 `ctx.storage`、不进日志、不回模型；错误信息里只出现 provider 名，绝不回显 key。
- 日志只记录模型名、问题数、耗时、token 数这类元数据，不记录 `state` 正文和答案内容。
- 工具 `risk: medium`，**故意不用 `high`**：Finch 把 `risk: "high"` 短路成「每次调用都要确认」
  （`src/main/services/runner/permission-decision.ts:208`，先于 acceptCalls 的自动放行），
  那样在行动模式下每评估一次都要弹一次卡。用 `medium` 是因为 `action=configure` 会往安全存储写 key。
- 单请求超时 60 秒（`timeoutMs` 75 秒），超时/429/529 会返回可读的错误让模型决定是否重试。

## 开发

```bash
npm run build       # tsc 编译到 dist/
npm run build -- --watch
npm run icon        # 从 assets/typesafe-mark.svg 重新生成 icon.png（需要 ImageMagick）
npm test            # scripts/smoke.mjs：离线冒烟测试（stub fetch，覆盖三条路径与校验分支）
```

本小程序通过 `--dev` 软链安装，源码改动执行 `npm run build` 后在 Finch 里重新加载小程序即可生效。
