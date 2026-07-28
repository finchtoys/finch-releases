# Capabilities

This document covers cross-mini-tool capabilities.

## 1. What a capability is

A capability is a named interface provided by one mini tool and consumed by another.
It lets tools collaborate without importing each other directly.

## 2. Manifest gating

Providers must declare what they provide.
Consumers must declare what they require.

```json
{
  "finch": {
    "provides": { "capabilities": ["mcp.client"] },
    "requires": { "capabilities": ["mcp.client"] }
  }
}
```

## 3. Provide

```ts
ctx.capabilities.provide('mcp.client', {
  async listServers() { return []; },
  async callTool(server, name, args) { return null; }
});
```

Rules:

- only provide names declared in the manifest
- keep the API async on the consumer side
- use `options.version` when you expect interface evolution

## 4. Get

```ts
const mcp = ctx.capabilities.get('mcp.client');
```

Before calling, check whether the provider exists:

```ts
if (!ctx.capabilities.has('mcp.client')) return;
```

## 5. Versioning

Use capability versioning when the API may evolve. Pass a `version` option when you `provide()`:

```ts
ctx.capabilities.provide('my.feature', {
  async listItems() { return []; },
}, { version: '1.2.0' });
```

Consumers can read the version and adapt behavior accordingly:

```ts
if (ctx.capabilities.has('my.feature')) {
  const version = await ctx.capabilities.getVersion('my.feature');
  // branch on version if needed
}
```

Keep method names stable and bump the version only when the interface changes.

## 6. Design rules

- prefer a small capability surface
- keep method names stable
- do not use capabilities for one-off local helpers
- use them when the other mini tool really is a dependency
