# QQ Agent Mail

Connect [QQ Agently Mail](https://agent.qq.com/) to Finch through the official `agently-cli` and MCP tools.

## Features

- OAuth status, login, and logout
- Read, list, and search mail
- Send, reply, and forward through the CLI confirmation-token flow
- Download attachments and soft-delete messages

Mail content is treated as untrusted external input. Sending, replying, and forwarding always require an explicit later confirmation.

## Requirements

- Finch MCP Client enabled
- The adapter is bundled with this extension
- The adapter checks for the official CLI and reports the install command if absent

## Development

Run `npm run build`, then install this extension with `npx @finchtoys/minitools add .`. The build copies the MCP Adapter into `dist/mcp-server.js`, so local installation works without publishing first.
