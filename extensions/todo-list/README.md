# Todo List

A three-state personal Todo List extension for Finch. It stores tasks locally and makes them available across all conversations and Spaces.

## Features

- Manage Todo, In Progress, and Completed Archive states
- Start todo items from a scrollable secondary menu
- Confirm completion inline before archiving an in-progress item
- Draft an automation reminder request from the Composer menu
- Store data locally in Finch extension storage
- Follow the Finch app language with English and Simplified Chinese UI

## Privacy and permissions

Todo List does not request filesystem, network, or shell access. Tasks are stored in the extension's private Finch storage. Do not use it for secrets or sensitive information.

## Development

```bash
npm install
npm run build
npx @finchtoys/minitools doctor .
```

Install a local build with:

```bash
npx @finchtoys/minitools add .
```

---

# 待办清单

一个支持三种状态的 Finch 个人待办扩展。任务保存在本地，并在所有对话和 Space 之间共享。

## 功能

- 管理待办、进行中和已完成归档三种状态
- 从可滚动的二级菜单把待办设为进行中
- 完成进行中事项前显示内联确认，确认后归档
- 从 Composer 菜单注入自动化提醒设置请求
- 使用 Finch 扩展私有存储在本地保存数据
- 中英文界面跟随 Finch App 语言动态切换

## 隐私与权限

Todo List 不申请文件系统、网络或 shell 权限。任务保存在 Finch 的扩展私有存储中。请勿用它保存密钥或敏感信息。

## 开发

```bash
npm install
npm run build
npx @finchtoys/minitools doctor .
```

安装本地构建：

```bash
npx @finchtoys/minitools add .
```
