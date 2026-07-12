# Chrome DevTools for Finch

Chrome DevTools 是 [Finch](https://finchwork.app/) 的扩展。Finch 是一款桌面 AI Agent，可在 [finchwork.app](https://finchwork.app/) 下载。

它通过 MCP 把 Chrome DevTools 接入 Finch。这个扩展会声明 `chrome-devtools` MCP server，并通过 `npx` 运行 Google 的 `chrome-devtools-mcp@1.5.0`，让 Finch 可以检查、调试、截图和操作 Chrome 页面。

## 使用要求

- 已启用 Finch MCP Client
- 系统可使用 Node.js 和 `npx`

用户不需要提前全局安装 `chrome-devtools-mcp`。MCP Client 会通过下面的命令启动它：

```bash
npx -y chrome-devtools-mcp@1.5.0
```

## 开发

```bash
npm install
npm run build
```

本地安装或更新：

```bash
npx @finchtoys/minitools update chrome-devtools
```

这个扩展包不提交扩展目录内的 `package-lock.json`。
