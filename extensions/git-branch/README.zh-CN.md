# Git 分支

Git 分支小工具是 [Finch](https://finchwork.app/) 的扩展。Finch 是一款桌面 AI Agent，可在 [finchwork.app](https://finchwork.app/) 下载。

可在对话框里切换 Git 分支，方便你管理 Git 项目的分支。

## 功能

- 在对话框顶部工具栏显示当前在哪个分支。
- 把 `main`、`master` 这些常用分支放在前面。
- 其他分支放在一个分组菜单里，一次最多显示 6 个。
- 切分支前会检查你有没有没保存的改动，并列出改了哪些文件。
- 新增和删除的行数分别用绿色和红色标出来。
- 如果有没保存的改动，可以先自动存一个 checkpoint，再切过去。
- 切完后告诉你存到了哪个 commit、切到了哪个分支。
- 也可以让 Agent 帮你创建新分支。

## 用法

1. 在 Git 项目目录里打开一个 Finch 对话。
2. 点击对话顶部工具栏的 Git 分支按钮。
3. 选一个分支切换过去。
4. 如果有没保存的改动，对话框会问你先存档再切，还是取消。
5. 点「创建并检出分支...」让 Agent 帮你输入新分支名。

## 权限

这个工具需要在本地执行 `git` 命令，所以需要 shell 权限。不需要联网。

## 开发

```bash
npm install
npm run build
```

本地安装或更新：

```bash
npx @finch.app/minitools update git-branch
```
