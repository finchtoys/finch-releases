# Git 分支

一个 Finch 扩展，用于直接在 Composer 工具栏管理 Git 分支。

## 功能

- 在 Composer 工具栏徽章中显示当前 Git 分支。
- 将 `main`、`master` 等常用分支置顶展示。
- 将更多分支放入带分组的二级菜单，并限制一次可见数量。
- 切换分支前预览未提交文件改动。
- 在确认弹框中用颜色高亮新增和删除行数。
- 切换分支前可将当前工作区改动提交为 checkpoint。
- checkpoint 提交并切换成功后显示 toast 提示。
- 通过 Finch Agent 工具创建并检出新分支。
- 使用运行时 i18n，跟随 Finch App 语言切换。

## 使用方式

1. 在 Git 仓库目录中打开 Finch 会话。
2. 点击 Composer 工具栏中的 Git 分支按钮。
3. 选择要切换到的分支。
4. 如果当前工作区有未提交改动，确认是否先创建 checkpoint commit 再切换。
5. 使用 **创建并检出分支...** 进入新分支创建流程。

## 权限

该扩展需要 shell 权限，因为它会在本地执行 `git` 命令。不需要网络权限。

## 开发

```bash
npm install
npm run build
```

使用 Finch extensions CLI 在本地安装或更新：

```bash
npx @finch.app/extensions update git-branch
```
