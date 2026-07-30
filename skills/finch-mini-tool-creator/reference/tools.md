# Tools

This document covers Agent tools, execution context, schemas, and forms.

## 1. What an Agent tool is

A tool is callable by the model during a conversation. Finch sends the tool description and input schema to the model, then calls your `execute()` implementation when the tool is selected.

A good tool has:

- a clear `name`
- a short `title`
- a specific `description`
- a strict `inputSchema`
- a safe `execute()` body

## 2. Tool definition

```ts
ctx.tools.register({
  name: 'docs_helper_search_docs',
  title: 'Search Docs',
  description: 'Search the project docs when the user asks about docs or asks to find a section.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' }
    },
    required: ['query']
  },
  risk: 'low',
  async execute(input, exec) {
    return { content: [{ type: 'text', text: '...' }] };
  }
});
```

Optional `ToolDefinition` fields:

- `defaultEnabled` — whether the tool is enabled by default when the mini tool is first activated. Defaults to `false`; users can still toggle it in the Toolcase.
- `risk` — `low` / `medium` / `high`. Affects how Finch presents permission checks.
- `exposure` — `startup` (default, included in every new session's tool list) or `dynamic` (injected only after runtime registration, useful for large on-demand sets such as MCP tools).
- `owner` — override provenance when one mini tool registers a tool on behalf of another.
- `callDisplay` — configure the inline summary shown next to the tool name in the timeline.

## 3. Naming and description rules

Tool names are model-facing global identifiers. **Always use this exact format:**

```text
<mini_tool_name>_<function_name>
```

- Use only lowercase English letters, digits, and underscores (`snake_case`).
- Convert the mini tool id/name to lowercase `snake_case` for `<mini_tool_name>` before composing the name. For example, `docs-helper` becomes `docs_helper`.
- Use a specific lowercase `snake_case` capability for `<function_name>`.
- Keep the mini tool prefix even when the function looks obvious: use `pjblog_init`, `pjblog_new_post`, and `docs_helper_search_docs`, **not** `init`, `new_post`, or `search_docs`.
- Do not use short generic names such as `init`, `build`, `status`, `search`, or `preview`; they are ambiguous in the model tool list and can collide with other mini tools.
- Make the complete name readable on its own.
- Use the description to tell the model exactly when to call it.
- Put trigger conditions, side effects, and output expectations in the description.

## 4. ToolExecutionContext

Use `exec` inside `execute()` for call-specific data:

- `toolCallId` — stable id for this tool call in the timeline.
- `sessionId` — current Finch session id, if any.
- `spaceId` — current Space id, if any.
- `cwd` — effective working directory for the current context.
- `signal` — an `AbortSignal` when the user cancels or the request times out; check `signal.aborted` before heavy work.
- `logger` — per-call logger; also available on `ctx.logger`.
- `storage` — mini-tool private KV storage; also available on `ctx.storage`.
- `secrets` — read-only secrets; also available on `ctx.secrets`.
- `progress` — live progress reporter for long-running work.
- `ui` — request forms from the user during the call.

Treat `exec` as per-call state, not a long-lived cache.

Use `exec.progress.report()` for long-running work such as image generation, exports, uploads, or remote jobs:

```ts
exec.progress.report({
  stage: 'generating',
  message: 'Generating image',
  percent: 35,
});
```

- `message` is required and should be short and user-facing.
- `stage` is optional, stable machine-readable metadata.
- `percent` is optional and must represent `0–100`.
- Omit `percent` when the provider cannot quantify progress; Finch shows an indeterminate animated strip.
- Progress is live UI only. It is not added to the model context and does not replace the final `ToolResult`.

## 5. Result shape

Return a `ToolResult`:

```ts
{
  content: [{ type: 'text', text: 'Done' }],
  isError: false
}
```

Rules:

- `content` is required
- return `isError: true` when the model should treat the call as failed
- keep returned text concise and model-usable
- never return secrets or private form input values

## 6. Forms

Use `exec.ui.requestForm()` when the tool needs user input.

`requestForm()` only works inside a running tool call — it pops a form card in the
Composer waiting area and blocks until the user submits/cancels or it times out. If you
need to collect manual input **without** a tool call in flight (e.g. a settings-menu
button, a ComposerAction click, or code in `activate()`), use
`ctx.ui.showModalDialog({ ..., fields })` instead — it renders the identical field grid
(same `MiniToolFormField[]` shape below) inside a native modal with your own action
buttons. See `reference/ui.md` §4.1 for the comparison and an example.

Recommended field types:

- `text`
- `password`
- `textarea`
- `number`
- `select`
- `boolean`
- `link` — display-only clickable link (not an input); opens `href` in the system
  browser. Produces no value and is not part of the submitted result.

Tips:

- Use `secret: true` for sensitive values. Password fields render a built-in
  show/hide (eye) toggle so users can verify what they typed.
- Use `width` for side-by-side layout — `link` fields honor `width` too, so you
  can place a "Get an API key" link right next to the key input.
- Keep `textarea` for longer freeform content.
- Use a `type: 'link'` field to guide users to a provider's signup/API-key page.
  Set `label` as the link text and `href` as the destination.
- Let the user cancel or timeout cleanly.

Example:

```ts
const result = await exec.ui.requestForm({
  title: 'Connect service',
  description: 'Fill in the service settings.',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'host', label: 'Host', type: 'text', width: '2/3' },
    { key: 'port', label: 'Port', type: 'number', width: '1/3' },
    { key: 'apiKey', label: 'API Key', type: 'password', secret: true, width: '2/3' },
    { key: 'signup', label: 'Get an API key', type: 'link',
      href: 'https://app.tavily.com', width: '1/3' } // sits next to apiKey
  ]
});
```

## 7. Risk levels

- `low`: read-only or no side effects
- `medium`: limited writes or local state changes
- `high`: deletions, shell, network, or external impact

Use the lowest risk level that matches the tool.

## 8. Good tool patterns

- **Register as few tools as possible.** Every tool is injected into the model context on every turn. Excess tools waste tokens and reduce selection accuracy.
- **Use an `action` parameter** to unify related operations (create / update / delete / list …) into a single tool instead of separate registrations. Always enumerate every action value in the `description` so the model knows what is available.
- **One tool = one job** when the operations are genuinely unrelated.
- **Prefer small, composable tools** over a giant catch-all tool.
- **Consider a local MCP server** when the total tool count would exceed roughly 10. MCP tools are loaded on demand and do not count against the upfront context budget. See `mcp.md`.
- Validate input inside `execute()`.
- Keep outputs predictable.
- Put reusable logic in helpers, not in manifest text.

### action parameter pattern

```ts
ctx.tools.register({
  name: 'my_tool_post',
  title: 'Post',
  description: `Manage posts.
action:
  list    — list all posts
  create  — create a new post (requires title)
  delete  — delete a post (requires slug)`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create', 'delete'] },
      title:  { type: 'string' },
      slug:   { type: 'string' },
    },
    required: ['action'],
  },
  risk: 'medium',
  async execute(input, exec) {
    switch (input.action) {
      case 'list':   /* ... */
      case 'create': /* ... */
      case 'delete': /* ... */
    }
  },
});
```

## 9. Common mistakes

- Registering a short or generic name such as `init`, `build`, or `status` instead of `<mini_tool_name>_<function_name>`
- Registering too many tools — group related operations under one tool with `action` instead
- Not listing available `action` values in the tool description — the model cannot discover them
- Using uppercase letters, hyphens, localized text, or any format other than lowercase `snake_case`
- Description too vague
- Input schema too loose
- Returning raw blobs instead of useful text
- Leaking sensitive data into the returned result
- Forgetting to push the disposable to `ctx.subscriptions`
