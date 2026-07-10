# QQ Agently Mail MCP Adapter

An MCP stdio adapter for the official `agently-cli` command line client.

## Prerequisite

Install and authorize the official CLI first:

```bash
npm install -g @tencent-qqmail/agently-cli
agently-cli auth login
```

The adapter never reads, stores, or returns OAuth credentials. The CLI owns its credentials.

## Safety

Sending, replying, and forwarding require the CLI's `confirmation_token` flow. The caller must stop after receiving a token and wait for an explicit later user confirmation.
