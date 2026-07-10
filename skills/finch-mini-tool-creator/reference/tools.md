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

- `toolCallId`
- `sessionId`
- `spaceId`
- `cwd`
- `token`
- `logger`
- `storage`
- `secrets`
- `ui`

Treat `exec` as per-call state, not a long-lived cache.

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

- One tool = one job.
- Prefer small, composable tools over a giant catch-all tool.
- Validate input inside `execute()`.
- Keep outputs predictable.
- Put reusable logic in helpers, not in manifest text.

## 9. Common mistakes

- Registering a short or generic name such as `init`, `build`, or `status` instead of `<mini_tool_name>_<function_name>`
- Using uppercase letters, hyphens, localized text, or any format other than lowercase `snake_case`
- Description too vague
- Input schema too loose
- Returning raw blobs instead of useful text
- Leaking sensitive data into the returned result
- Forgetting to push the disposable to `ctx.subscriptions`
