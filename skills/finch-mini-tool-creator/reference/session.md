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
          "agentProfile": "responder",
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
- `permissions.sessions` is required for every `ctx.sessions` call. Answering interaction cards additionally needs `permissions.sessionInteractions` — see section 6.1.
- Optional `agentProfiles` declares fixed system-prompt personas. A profile is bound to a **container**, not to an individual `create()` call: set `sessionContainers[].agentProfile` to the profile id and every Session born in that container automatically carries it. This works in both modes — required for `assistant`, optional for `inbox` (e.g. a Bot container giving every inbound conversation the same persona) — whether the user clicks "New chat" in the Finch UI or your mini tool calls `ctx.sessions.create()`. The profile prompt is appended to Finch's base system prompt; it cannot override safety rules or permissions. Sessions outside a container (plain conversations, Space-targeted Sessions) never carry a profile.
- Finch injects the profile as a **partner of the user's own Finch assistant**, and both identities coexist: the assistant keeps its name, personality, memory, and safety rules, while your profile supplies the specialty and division of labor. Asked "who are you", it introduces itself as the Finch assistant's partner `<profile name>` and what it can do here. So write `prompt` as a specialty plus working style — never as "you are a brand-new AI unrelated to Finch", and do not hardcode an assistant name, since the user may have renamed theirs.
- `icon` follows the same `IconRef` rules as Composer actions: use a built-in Finch icon id, or register an SVG icon pack and reference this mini tool's icon with `ext:<iconId>`. Finch qualifies it automatically; only cross-pack icons need `ext:<packId>/<iconId>`. Falls back to `bot` if omitted.
- `title` and `description` support `LocalizedString`; you can also override them in `i18n/<locale>.json` under `sessionContainers.<id>`.
- `starterPrompts` cards appear on the container home. Finch shows at most four cards. When the user clicks a card, Finch creates a new container Session and sends the card's `prompt` as the first message.
- `mode` (optional, `'inbox' | 'assistant'`) picks the container's home-page behavior:
  - `inbox` (default) — Bot / multi-agent aggregation. Sessions are created by the mini tool itself; the home page shows a Session list with no "new chat" entry, and the container supports the per-container default model (see §4). `agentProfile` is optional here but usually wanted: it is what gives every inbound conversation a consistent persona (e.g. "reply in short, mobile-friendly messages" for a chat Bot).
  - `assistant` — an industry-scenario assistant. The user starts conversations themselves; the home page shows a role introduction plus `starterPrompts`, hides the container model picker, and **requires** `agentProfile` to be set (new Sessions auto-bind to that profile).

### 1.1 Mini tool settings menu

A mini tool may reserve **one unified settings menu**, declared at the top level of `contributes`. One declaration renders in two surfaces:

- **Container headers** — every session container this mini tool owns. In `inbox` mode the button sits beside the model picker; in `assistant` mode it sits in the assistant header action area.
- **Toolcase** — on the mini tool card, left of the enable toggle, and in the detail page action row.

The manifest declaration controls whether the button exists; dynamic `getMenu()` results must never be used as the visibility signal.

```json
{
  "contributes": {
    "settingsMenu": {
      "icon": "settings",
      "tooltip": "Account and connection settings"
    }
  }
}
```

Register the one runtime provider during activation:

```ts
let signedIn = false;
const menu = ctx.settingsMenu.register({
  async getMenu({ surface }) {
    // `surface` is 'container' | 'toolcase'; `containerId` is present only on 'container'.
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
- `settingsMenu.icon` is optional and follows the same `IconRef` rules (a built-in id, or `ext:<iconId>` for this mini tool's registered SVG; only cross-pack icons need `ext:<packId>/<iconId>`). Omitted, it falls back to `sliders-horizontal` — **not** the container's own `bot` fallback; these are two independent icons. `settingsMenu.tooltip` falls back to "Settings". Both container modes and the Toolcase render the exact same button, so one declaration covers all of them.
- A successful `execute()` automatically asks Finch to refresh this menu. If state changes later in a background OAuth callback or polling loop, call `menu.notifyUpdate()`; Finch re-fetches immediately while the menu is visible.
- Empty or failed `getMenu()` results do not remove the button. The manifest `settingsMenu` declaration remains authoritative.
- When the manifest also declares a top-level `settings` schema, Finch appends a built-in **Settings** row that opens the native settings form. With a `settings` schema and no `contributes.settingsMenu`, the button still appears and clicking it opens the form directly — including while the mini tool is disabled, since the native form does not need a running host.

#### Legacy: container-scoped settings menu

`contributes.sessionContainers[].settingsMenu` + `ctx.sessionContainers.registerSettingsMenu(containerId, provider)` is the older API. It still works, but the button **only renders in that one container's header** and never reaches the Toolcase. Do not use it in new mini tools.

```ts
// Deprecated — prefer ctx.settingsMenu.register().
const legacy = ctx.sessionContainers.registerSettingsMenu('inbox', { getMenu, execute });
```

For compatibility, when a mini tool has exactly one legacy container menu and no `contributes.settingsMenu`, Finch promotes that menu into the Toolcase card and detail page so already-shipped mini tools keep a usable entry point.

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
  // No profileId: the container's declared agentProfile is applied automatically.
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
| `profileId` | `string` | **Deprecated and ignored.** The Agent profile comes from the container's `agentProfile` declaration and is applied automatically. Passing it never fails session creation — Finch logs a deprecation warning and ignores the value. Declare the profile on the container instead. |
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
      // The turn is blocked. `event.wait` carries the full question, and
      // `event.requestId` is what you pass to respondToWait().
      console.log('waiting', event.reason, event.requestId, event.wait);
      break;
    case 'turn.wait_resolved':
      // Someone settled that wait — a human, your mini tool, a timeout, or Finch.
      console.log('resolved', event.requestId, 'by', event.resolvedBy);
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

## 6.1 Handling waits (permission / question / form)

An interactive Session can stop mid-turn and wait for a human: a permission card,
an `AskUserQuestion` card, or a form opened by a mini tool. If nobody is looking at
the Finch window — a WeChat bot, a scheduled job, a remote operator — that Session
stays stuck. These three APIs let your mini tool see the question and answer it.

```ts
// 1. See what is blocking a session right now.
const waits = await ctx.sessions.listWaits(sessionId);

// 2. Or block until one appears (no polling).
const wait = await ctx.sessions.waitForWait(sessionId, { timeoutMs: 120_000 });
if (!wait) return; // timed out, nothing pending

// 3. Relay the question to your real user, then answer on their behalf.
if (wait.kind === 'permission') {
  const decision: 'allow' | 'deny' = await relayPermissionToUser(wait);
  // Remote channels may reject an irreversible operation, but approval must
  // happen in the Finch desktop app. Do not retry a forbidden approval.
  if (wait.destructive && decision === 'allow') {
    await tellUserToApproveInFinch(wait);
    return;
  }
  await ctx.sessions.respondToWait(sessionId, wait.requestId, {
    kind: 'permission',
    allow: decision === 'allow',
  });
} else if (wait.kind === 'question') {
  // Keys are each question's `header`.
  await ctx.sessions.respondToWait(sessionId, wait.requestId, {
    kind: 'question',
    answers: { [wait.questions[0].header]: 'Option A' },
  });
} else {
  await ctx.sessions.respondToWait(sessionId, wait.requestId, {
    kind: 'form',
    submitted: true,
    values: { branchName: 'feat/login' },
  });
}
```

`respondToWait()` never throws on a race. Check the result state:

| state | Meaning |
| --- | --- |
| `accepted` | Your answer was applied and the turn resumed. |
| `stale` | Someone else settled it first; `resolvedBy` tells you who. |
| `not_found` | Unknown `requestId` — usually an already-garbage-collected card. |
| `forbidden` | Policy blocked it, e.g. trying to approve a destructive permission card. |

Hard rules, enforced by Finch and not overridable by any manifest flag:

- **You can only touch your own Sessions.** Every call is ownership-checked.
- **Destructive permission cards may only be rejected by a program.** This lets
  the turn skip the dangerous operation and continue safely. Approval always
  requires a human in the Finch window; programmatic approval gets `forbidden`.
- **A delegated answer never becomes a persistent rule.** `remember` is stripped,
  so you cannot silently widen the user's standing permissions.
- **A human always wins.** If the user answers in the window first, your call
  returns `stale` instead of overwriting their decision.

Permissions: `listWaits()` and `waitForWait()` need only `permissions.sessions`.
`respondToWait()` additionally requires `permissions.sessionInteractions`, which is
shown as its own line in the enable-confirmation dialog.

```json
{
  "finch": {
    "permissions": { "sessions": true, "sessionInteractions": true }
  }
}
```

The intended pattern is **relay, not autopilot**: forward the question to your real
user on whatever channel you own (WeChat, email, a web UI), and submit their answer.
Answering from hardcoded logic turns Finch's permission prompts into a rubber stamp.

Submit the answer to the existing card with `respondToWait()`. Never pass a wait
answer to `sessions.send()`: that creates a new turn and leaves the original card
unsettled, so the task remains stuck.

Note that `activity: 'background'` Sessions never produce waits — they auto-deny
permission cards and cancel question/form cards so unattended work cannot hang. Keep
your bot's own listener Session in the background, and dispatch real work into a
normal Session where waits can surface and be relayed.

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
- Handle all durable event types (`assistant.message`, `turn.completed`, `turn.failed`, `turn.waiting`, `turn.wait_resolved`). Do not rely only on `assistant.delta` streaming.
- If you dispatch work into interactive Sessions, handle `turn.waiting`. An unhandled wait means a Session that silently stops making progress. Relay the question to your real user and submit their answer with `respondToWait()` — do not auto-approve from hardcoded logic.
- For external bots, map each external contact/thread to one Finch Session and reuse it. Creating a new Session per message wastes context and state.
- Use `background` activity and `acceptCalls` permission mode for unattended work so the user is not interrupted.
- Keep `initialMessage` short. Large first messages count against the same text and attachment limits as `send()`.
- Do not poll `listEvents()` in a tight loop. Use `onDidReceiveEvent()` for live updates, `waitForTurn()` when one operation needs one exact terminal result, and `listEvents()` only for history/recovery.
- Use `agentProfiles` for fixed personas instead of trying to pass arbitrary system prompts at runtime, and bind them on the container via `sessionContainers[].agentProfile` rather than per `create()` call. Declaring a profile without pointing a container at it means no Session ever uses it. Profile prompts are supplements, not overrides.
- If you need a Space-placed Session, ask the user for the Space or obtain it from a tool call's `spaceId`; do not guess Space ids.

---

## 12. Common mistakes

- Creating a Session without `permissions.sessions` or `contributes.sessionContainers`.
- Passing `containerId` that was not declared in the manifest.
- Omitting `idempotencyKey` and sending duplicate messages every time an external webhook fires.
- Using `context: 'caller'` outside an Agent tool call.
- Assuming `assistant.delta` events are persisted. They are not.
- Blocking on `send()` without handling the `rejected` queue-full case.
- Implementing `sleep` + repeated `listEvents()` calls instead of `waitForTurn()` or `waitForWait()`.
- Auto-approving every permission card from code. That defeats the point of the prompt; relay it to a human instead.
- Retrying the same answer after `stale` or `forbidden`. `stale` means the card is already settled; `forbidden` means that exact response is blocked. In particular, do not retry destructive approval—send the user to Finch for approval, or submit a rejection if that is their decision.
- Trying to read or write the user's normal Composer Sessions. `ctx.sessions` only owns Sessions created by this mini tool.
