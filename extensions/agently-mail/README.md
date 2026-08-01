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

## CLI version check and one-click update

The "QQ Agent Mail" Composer toolbar menu shows the `agently-cli` status at the bottom:

- Installed and up to date: shows the version, disabled row
- Update available: shows "installed version → latest version"; click to run `npm install -g @tencent-qqmail/agently-cli`
- Not installed: shows an install prompt; click runs the same install command
- Check failed (offline, npm registry unreachable, etc.): shows an error row

The status is checked once on startup and refreshed in the background every 6 hours. Clicking update re-checks immediately afterward and reports the result via a toast. This feature requires the `network` permission to query the npm registry for the latest version.

## Development

Run `npm run build`, then install this extension with `npx @finchtoys/minitools add .`. The build copies the MCP Adapter into `dist/mcp-server.js`, so local installation works without publishing first.
