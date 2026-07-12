# Chrome DevTools

Use this skill when the user wants Finch to inspect, debug, or operate a Chrome page through Chrome DevTools MCP.

## When to use

- 网页调试
- DOM 检查
- Console 错误分析
- Network 请求分析
- 页面截图
- 页面性能分析
- Chrome 标签页操作

## How to use

Chrome DevTools MCP tools are exposed by the MCP Client. Before calling any `mcp__chrome_devtools__*` tool, use ToolSearch with `source: "mcp"` to discover and activate the relevant tools.

## Response style

用简洁中文说明：

- 发现了什么
- 证据来自 console / network / DOM / screenshot 哪一类
- 可能原因
- 下一步修复建议
