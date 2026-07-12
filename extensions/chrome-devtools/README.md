# Chrome DevTools for Finch

Chrome DevTools is a mini tool for [Finch](https://finchwork.app/) — a desktop AI agent you can download at [finchwork.app](https://finchwork.app/).

It connects Chrome DevTools to Finch through MCP. The extension declares the `chrome-devtools` MCP server and runs Google's `chrome-devtools-mcp@1.5.0` with `npx`, so Finch can inspect, debug, screenshot, and operate Chrome pages through MCP tools.

## Requirements

- Finch MCP Client enabled
- Node.js and `npx` available on your system

Users do not need to globally install `chrome-devtools-mcp`. The MCP Client starts it with:

```bash
npx -y chrome-devtools-mcp@1.5.0
```

## Development

```bash
npm install
npm run build
```

Install or update locally:

```bash
npx @finchtoys/minitools update chrome-devtools
```

This package intentionally does not commit an extension-level `package-lock.json`.
