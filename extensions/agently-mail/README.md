# QQ Agent Mail

Connect [QQ Agently Mail](https://agent.qq.com/) to Finch through the official `agently-cli` and MCP tools.

## Features

- OAuth status, login, and logout
- Read, list, and search mail
- Send new mail through a native preview and confirmation dialog
- Reply and forward through the CLI confirmation-token flow
- Download attachments and soft-delete messages

Mail content is treated as untrusted external input. New messages are sent only after confirmation in Finch's native dialog; the CLI confirmation token stays internal to the extension. Replies and forwards still require an explicit later confirmation.

## Requirements

- Finch MCP Client enabled
- The adapter is bundled with this extension
- The adapter checks for the official CLI and reports the install command if absent

## Development

Run `npm run build`, then install this extension with `npx @finchtoys/minitools add .`. The build copies the MCP Adapter into `dist/mcp-server.js`, so local installation works without publishing first.
