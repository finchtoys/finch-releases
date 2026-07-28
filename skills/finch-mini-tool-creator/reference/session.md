# Sessions

This document covers owner-scoped Finch Sessions for mini tools. Use `ctx.sessions` when your mini tool needs its own long-running conversations, such as a bot that mirrors an external platform, a background agent that processes jobs, or a tool that spawns a dedicated side-channel for a user request.

A mini tool can only access Sessions it owns. It cannot read or write the user's normal Composer Sessions or Sessions owned by other mini tools.

---

## 1. Manifest prerequisites

You must declare both a session container and the `sessions` permission:

```json
{
  "finch": {
    "manifestVersion": 1,
    "id": "my-bot",
    "name": "My Bot",
    "contributes": {
      "sessionContainers": [
        {
          "id": "inbox",
          "icon": "message-circle",
          "title": "Bot Inbox",
          "description": "One conversation per external contact",
          "starterPrompts": [
            {
              "title": "Start session",
              "description": "Open a new conversation",
              "prompt": "Hello! I'm ready to help."
            }
          ]
        }
      ],
      "agentProfiles": [
        {
          "id": "responder",
          "name": "Responder",
          "description": "Concise bot personality",
          "prompt": "You are a concise bot. Keep replies short and mobile-friendly."
        }
      ]
    },
    "permissions": {
      "sessions": true
    }
  }
}
```

Rules:

- `contributes.sessionContainers[].id` is scoped to your mini tool. You can only create containers you declared.
- `permissions.sessions` is required for every `ctx.sessions` call.
- Optional `agentProfiles` lets you choose a fixed system-prompt persona at `create()` time via `profileId`. The profile prompt is appended to Finch's base system prompt; it cannot override safety rules or permissions.
- `icon` follows the same `IconRef` rules as Composer actions: use a built-in Finch icon id, or register an SVG icon pack and reference it with `ext:<packId>/<iconId>`. Falls back to `bot` if omitted.
- `title` and `description` support `LocalizedString`; you can also override them in `i18n/<locale>.json` under `sessionContainers.<id>`.
- `starterPrompts` cards appear on the container home. Finch shows at most four cards. When the user clicks a card, Finch creates a new container Session and sends the card's `prompt` as the first message.
- `mode` (optional, `'inbox' | 'assistant'`) picks the container's home-page behavior:
  - `inbox` (default) — Bot / multi-agent aggregation. Sessions are created by the mini tool itself; the home page shows a Session list with no "new chat" entry, and the container supports the per-container default model (see §4).
  - `assistant` — an industry-scenario assistant. The user starts conversations themselves; the home page shows a role introduction plus `starterPrompts`, hides the container model picker, and **requires** `agentProfile` to be set (new Sessions auto-bind to that profile).

### 1.1 Container settings menu

An `inbox` container may reserve one settings-menu button beside its model picker. The manifest declaration controls whether the button exists; dynamic `getMenu()` results must never be used as the visibility signal.

```json
{
  "id": "inbox",
  "title": "Bot Inbox",
  "settingsMenu": {
    "icon": "settings",
    "tooltip": "Account and connection settings"
  }
}
```

Register the one runtime provider during activation:

```ts
let signedIn = false;
const menu = ctx.sessionContainers.registerSettingsMenu('inbox', {
  async getMenu() {
    return signedIn
      ? [
          { id: 'status', label: 'Connection status', description: 'Signed in', iconName: 'toggle-right', disabled: true },
          { id: 'logout', label: 'Sign out', iconName: 'log-in' },
        ]
      : [
          { id: 'status', label: 'Connection status', description: 'Signed out', iconName: 'toggle-left', disabled: true },
          { id: 'login', label: 'Sign in', iconName: 'log-in' },
        ];
  },
  async execute(_context, itemId) {
    if (itemId === 'login') {
      await ctx.ui.showModalDialog({
        title: 'Sign in',
        message: 'Complete account authorization.',
        actions: [{ id: 'close', label: 'Close' }],
      });
    }
  },
});
ctx.subscriptions.push(menu);
```

Rules:

- Finch calls `getMenu()` every time the user opens the menu, so it should return the latest state.
- A status display is not an action. Return it as a disabled row and return login/logout as separate actionable rows with distinct ids.
- `separator: true` is a standalone structural item, not an attribute of the row below it. Return `{ id: 'account-divider', label: '', separator: true }` followed by a separate login/logout row without `separator`.
- Every actionable row needs `iconName`, following the standard `IconRef` rules.
- A successful `execute()` automatically asks Finch to refresh this menu. If state changes later in a background OAuth callback or polling loop, call `menu.notifyUpdate()`; Finch re-fetches immediately while the menu is visible.
- Empty or failed `getMenu()` results do not remove the button. The manifest `settingsMenu` declaration remains authoritative.

---

## 2. Container vs Space placement

When you create a Session you choose where it lives:

- **Container placement** (default for mini tools): the Session appears inside your mini tool's own container. Use `containerId` matching one of your declared `sessionContainers`.
- **Space placement**: the Session appears in a normal Space conversation list, as if the user created it, but it is still owned by your mini tool. Use `space: { spaceId: '...' }` and omit `containerId`.

```ts
// Inside the mini tool's own container
const s1 = await ctx.sessions.create({ containerId: 'inbox' });

// Inside a normal Space, owned by this mini tool
const s2 = await ctx.sessions.create({ space: { spaceId: 'space-123' } });
```

You cannot mix `containerId` and `space` in the same `create()` call.

---

## 3. Creating a Session

```ts
const session = await ctx.sessions.create({
  containerId: 'inbox',          // required for container placement
  title: 'Chat with Alice',      // optional; users can rename later
  profileId: 'responder',        // optional; references declared agentProfiles
  activity: 'interactive',       // default
  permissionMode: 'ask',         // default for interactive
  initialMessage: {
    text: 'Hello from the bot.',
    idempotencyKey: 'welcome-alice-2026-01-01',
  },
});

console.log(session.sessionId);
```

`create()` options:

| Option | Type | Notes |
|---|---|---|
| `containerId` | `string` | Required for container placement. Must match a declared `sessionContainers` id. |
| `space` | `{ spaceId: string }` | Required for Space placement. Mutually exclusive with `containerId`. |
| `title` | `string` | Optional initial title. |
| `profileId` | `string` | Optional Agent profile from `contributes.agentProfiles`. |
| `activity` | `'interactive' \| 'background'` | Defaults to `interactive`. |
| `permissionMode` | `'ask' \| 'acceptCalls'` | Defaults to `ask` for interactive, `acceptCalls` for background. |
| `context` | `'caller'` | Only valid during an Agent tool call; inherits the caller's cwd, model, policy, and Space context. |
| `initialMessage` | `SessionUserMessage` | Optional first message, sent atomically with Session creation. |

A failed `create()` with `initialMessage` does not leave a ghost Session.

---

## 4. Container default model

Users can pick a default model for each container from the container row menu. After that, every `ctx.sessions.create({ containerId })` automatically uses that model. If none is chosen or the model is unavailable, Finch falls back to the global default.

Your mini tool cannot read or override this preference. It is a user setting, not an API parameter. Space-placed Sessions do not use container models. Container default model selection only applies to `inbox`-mode containers; `assistant`-mode containers hide the model picker entirely (see §1).

---

## 5. Sending messages

`send()` is strictly FIFO within a Session:

```ts
const receipt = await ctx.sessions.send(session.sessionId, {
  text: 'What is the weather?',
  idempotencyKey: 'msg-123',
});

if (receipt.state === 'accepted') {
  console.log('turnId', receipt.turnId, 'queued', receipt.queued, 'pending', receipt.pendingCount);
} else if (receipt.state === 'rejected') {
  console.log('Queue full; retry after', receipt.retryAfterMs, 'ms');
}
```

Message limits:

- Text: up to 100,000 characters.
- Attachments: up to 10 per message.
- Each attachment: up to 20 MB.
- Total attachments per message: up to 20 MB.
- `idempotencyKey`: required, up to 512 characters. Use a stable key so duplicate sends return the original receipt instead of creating a new turn.

Attachments:

```ts
const receipt = await ctx.sessions.send(session.sessionId, {
  text: 'Please summarize this.',
  idempotencyKey: 'summary-001',
  attachments: [
    {
      name: 'report.pdf',
      mimeType: 'application/pdf',
      data: pdfBase64,
      kind: 'pdf',
    },
  ],
});
```

`kind` is optional and can be `image`, `pdf`, `text`, or `file`. Finch infers it from `mimeType` when omitted.

### Waiting for one turn

When the current operation needs the final result of the turn it just sent, use `waitForTurn()` instead of sleeping or polling `listEvents()`:

```ts
if (receipt.state !== 'rejected') {
  const result = await ctx.sessions.waitForTurn(
    session.sessionId,
    receipt.turnId,
    { timeoutMs: 60_000 },
  );

  if (result.state === 'completed') console.log(result.outputText);
  if (result.state === 'failed') console.error(result.code);
  if (result.state === 'timeout') console.log('Still running');
}
```

- The default timeout is 60 seconds and Finch clamps it to 1–600 seconds.
- A timeout ends only this wait. It does not cancel or interrupt the turn.
- Calling it after a turn already completed or failed returns immediately.
- Use it for request/response orchestration. Use `onDidReceiveEvent()` for long-lived observation across many Sessions and turns.

---

## 6. Receiving events

Subscribe to all events for your mini tool's Sessions:

```ts
ctx.sessions.onDidReceiveEvent((event) => {
  switch (event.type) {
    case 'assistant.delta':
      // Live streaming chunk. Not persisted; use the final message for recovery.
      console.log('streaming', event.delta);
      break;
    case 'assistant.message':
      // Final assistant message in a turn.
      console.log('message', event.text);
      break;
    case 'turn.completed':
      // The turn finished successfully.
      console.log('completed', event.outputText, event.messageIds);
      break;
    case 'turn.failed':
      // The turn failed.
      console.log('failed', event.code, 'retryable', event.retryable);
      break;
    case 'turn.waiting':
      // The turn is waiting for user permission, a question answer, or a form.
      console.log('waiting', event.reason);
      break;
  }
});
```

`assistant.delta` is a live-only event. If the connection drops, use the durable `assistant.message` or `turn.completed` event for recovery.

You can also query past events:

```ts
const page = await ctx.sessions.listEvents({ sessionId, after: 0, limit: 100 });
for (const event of page.events) {
  console.log(event.sequence, event.type);
}
```

Events are retained for 7 days and capped at 10,000 per mini tool.

---

## 7. Activity and permission mode

- **Interactive** (`activity: 'interactive'`): a normal chat Session. Users see it in the container or Space. The default `permissionMode` is `ask`.
- **Background** (`activity: 'background'`): a quiet worker Session. Completion or waiting does not trigger a system notification; Finch only shows a red dot on the container entry. The default `permissionMode` is `acceptCalls` so unattended work can proceed without interrupting the user.

Use `background` for polled jobs, external-platform integrations, or any work that should not pop notifications. Use `interactive` for user-facing chats.

---

## 8. Caller context

If your tool creates a Session while handling an Agent tool call, you can pass `context: 'caller'` to inherit the caller's cwd, model, policy, and Space context. This is useful when a tool needs to fork a side conversation that should behave like the current one.

```ts
async execute(input, exec) {
  const session = await ctx.sessions.create({
    containerId: 'side-chat',
    context: 'caller',
    initialMessage: { text: 'Start side analysis.', idempotencyKey: 'side-001' },
  });
  return { content: [{ type: 'text', text: `Created ${session.sessionId}` }] };
}
```

`context: 'caller'` is only valid inside an Agent tool call. Outside a tool call it throws an error.

---

## 9. Session lifecycle helpers

```ts
// Look up a single Session
const found = await ctx.sessions.get(sessionId);

// List Sessions in a container
const list = await ctx.sessions.list({ containerId: 'inbox', includeArchived: false });

// List all Sessions owned by this mini tool (including Space-placed ones)
const all = await ctx.sessions.list();
```

`list()` returns descriptors with `placement`, `activity`, `state` (pinned / archived), `profileId`, and timestamps.

---

## 10. Queue and concurrency limits

| Limit | Value |
|---|---|
| Outstanding turns per Session | 20 |
| Outstanding turns per mini tool | 200 |
| Queue-full retry interval | 1,000 ms |
| Events retained per mini tool | 10,000 |
| Event retention | 7 days |
| Terminal turn receipts retained | 10,000 |
| Terminal receipt retention | 7 days |

When the queue is full, `send()` returns a `rejected` receipt with `retryAfterMs`. Wait before retrying; do not flood the API.

---

## 11. Best practices

- Always provide a stable `idempotencyKey` when sending. A good key includes a unique message or turn identifier from your external source, not just a random UUID.
- Handle all durable event types (`assistant.message`, `turn.completed`, `turn.failed`, `turn.waiting`). Do not rely only on `assistant.delta` streaming.
- For external bots, map each external contact/thread to one Finch Session and reuse it. Creating a new Session per message wastes context and state.
- Use `background` activity and `acceptCalls` permission mode for unattended work so the user is not interrupted.
- Keep `initialMessage` short. Large first messages count against the same text and attachment limits as `send()`.
- Do not poll `listEvents()` in a tight loop. Use `onDidReceiveEvent()` for live updates, `waitForTurn()` when one operation needs one exact terminal result, and `listEvents()` only for history/recovery.
- Use `agentProfiles` for fixed personas instead of trying to pass arbitrary system prompts at runtime. Profile prompts are supplements, not overrides.
- If you need a Space-placed Session, ask the user for the Space or obtain it from a tool call's `spaceId`; do not guess Space ids.

---

## 12. Common mistakes

- Creating a Session without `permissions.sessions` or `contributes.sessionContainers`.
- Passing `containerId` that was not declared in the manifest.
- Omitting `idempotencyKey` and sending duplicate messages every time an external webhook fires.
- Using `context: 'caller'` outside an Agent tool call.
- Assuming `assistant.delta` events are persisted. They are not.
- Blocking on `send()` without handling the `rejected` queue-full case.
- Implementing `sleep` + repeated `listEvents()` calls instead of `waitForTurn()`.
- Trying to read or write the user's normal Composer Sessions. `ctx.sessions` only owns Sessions created by this mini tool.
