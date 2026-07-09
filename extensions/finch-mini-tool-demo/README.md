## Finch Mini Tool Demo | 小工具演示

A comprehensive demo extension that showcases all Finch mini tool capabilities — forms, toasts, custom icons, composer actions, and i18n.

## What it does

- **All Field Types** — demonstrates every form field: text, number, password, select, textarea, boolean, with side-by-side layout.
- **Login Form** — a practical login form example with `secret` fields that are never returned to the model.
- **Timeout Test** — shows how to set an auto-cancel timeout on a form (configurable seconds, or no timeout).
- **Project Config** — a multi-field config wizard with selects, booleans, and side-by-side layout.
- **Toast & Messages** — demos `showToast` variants (success / info / warning / error) and the `showMessage` banner, including an Undo action.
- **Custom Icons** — shows how to register and reference custom SVG icons via `ctx.icons.register()`.

All UI strings are fully internationalized (zh-CN / en-US).

## How to use

Open Finch and click the **Mini Tool Demo** button in the Composer toolbar, or ask the Agent directly:

- *"Show me all form field types"*
- *"Test the login form"*
- *"Run a 10-second timeout test"*
- *"Show a success toast"*
- *"Preview all custom icons"*

## Permissions

No filesystem, network, or shell access required.

## Development

```bash
npm install
npm run build
```

Install or update locally:

```bash
npx @finch.app/extensions add .
# or update an existing install
npx @finch.app/extensions update mini-tool-demo
```

---

# Finch Mini Tool Demo（中文）

这是一个全功能演示扩展，覆盖 Finch 小工具的所有核心能力——表单、弹框、自定义图标、工具栏按钮、国际化。

## 功能列表

- **全部字段类型** — 演示所有表单字段：文本、数字、密码、下拉选择、多行文本、布尔，以及并排布局。
- **模拟登录表单** — 含 `secret` 字段的登录表单，密码值不会返回给模型。
- **超时测试** — 演示表单的自动取消超时（可配置秒数，或不超时）。
- **项目配置向导** — 多字段配置表单，含下拉、布尔和并排布局。
- **弹框与提示** — 演示 `showToast` 的四种变体（success / info / warning / error）及顶部 `showMessage`，含撤销按钮。
- **自定义图标** — 展示如何通过 `ctx.icons.register()` 注册并引用自定义 SVG 图标。

所有 UI 文字已完整支持国际化（zh-CN / en-US）。

## 使用方式

在 Finch 中点击工具栏上的**小工具演示**按钮，或直接问 Agent：

- *"用小工具演示展示全部表单字段类型"*
- *"测试登录表单"*
- *"运行一个 10 秒超时的表单"*
- *"弹一个 success toast"*
- *"展示所有自定义图标"*

## 权限

无需文件系统、网络或 Shell 权限。

## 开发

```bash
npm install
npm run build
```

本地安装或更新：

```bash
npx @finch.app/minitools add @finch.app/mini-tool-demo
# 或更新已有安装
npx @finch.app/minitools update @finch.app/mini-tool-demo
```
