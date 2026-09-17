# Artifacts and Collaboration

Use these APIs when a mini tool coordinates multiple Sessions or needs durable, verifiable outputs. They are separate by design:

- `ctx.artifacts` stores immutable content snapshots.
- `ctx.collaboration` stores coordination state that refers to those snapshots.
- `ctx.ui.delivery` projects one convenient entry into a Session sidebar; it is not storage.

## Permissions and ownership

Declare only what you use:

```json
{
  "permissions": {
    "artifacts": true,
    "collaboration": true,
    "sessions": true
  }
}
```

Every object is owner-scoped to the calling mini tool. A mini tool cannot read another mini tool's objects or refer to another owner's Sessions. Publishing a `{ type: 'file' }` source also requires `filesystem: 'read'` or `readwrite`; Finch copies the file into immutable storage rather than retaining the mutable source path.

## Artifacts

Publish text, JSON, or a file snapshot. Every publish requires an idempotency key. Repeating the same call with the same key returns the original Artifact.

```ts
const report = await ctx.artifacts.publish({
  scopeId: scope.scopeId,
  name: 'worker-report.json',
  source: { type: 'json', value: workerReport },
  mediaType: 'application/json',
  producer: { sessionId: workerSession.id, turnId },
  idempotencyKey: `worker-report:${turnId}`,
});
```

`ArtifactRef.contentHash` is a `sha256:...` content identity. `get()` and `list()` return metadata. `read()` returns inline text/JSON or a stable read-only snapshot path for a file Artifact. The current limit is 50 MB per Artifact.

An Artifact may omit `scopeId`; it remains private to the owner. When associated with a Scope, references from Documents and Handoffs must stay in that same Scope.

## Scopes

A Scope is the owner-defined boundary for one project, run, or collaboration graph:

```ts
const scope = await ctx.collaboration.scopes.create({
  label: 'Release audit',
  retention: 'project',
  metadata: { projectId },
  idempotencyKey: `project:${projectId}`,
});
```

Retention is `'session' | 'project' | 'persistent'`. In the first API version it records lifecycle intent; automatic collection policy may evolve, so do not depend on exact deletion timing.

## Versioned Documents

A Document is a mutable head pointing to immutable Artifact revisions. Updates use compare-and-swap:

```ts
const result = await ctx.collaboration.documents.update({
  documentId: plan.documentId,
  baseRevision: plan.revision,
  artifactId: revisedPlan.artifactId,
  summary: 'Reviewer corrections',
  idempotencyKey: `plan-review:${reviewTurnId}`,
});

if (result.state === 'conflict') {
  // Re-read result.current, reconcile, publish a new Artifact, and retry.
}
```

Never overwrite on conflict. A revision only advances after the referenced Artifact has already been published.

## Tasks and leases

Tasks use an integer `version`. Mutations require `expectedVersion` and return either `updated` or `conflict`.

```ts
const claimed = await ctx.collaboration.tasks.claim({
  taskId: task.taskId,
  assignee: { sessionId: workerSession.id },
  expectedVersion: task.version,
  leaseMs: 10 * 60_000,
  idempotencyKey: `claim:${task.taskId}:${workerSession.id}`,
});
```

A claim is allowed for an open task or an expired claim. Call `renewLease()` before a long-running lease expires. Completing, blocking, or cancelling through `update()` clears the claim. Do not treat local UI state as authoritative; always use the returned version.

## Handoffs

A Handoff is a structured, auditable transfer between two owner-scoped Sessions. It may refer to a Task, Artifact ids, pinned Document revisions, and small JSON metadata.

```ts
const handoff = await ctx.collaboration.handoffs.create({
  scopeId: scope.scopeId,
  from: { sessionId: workerSession.id, turnId: workerTurnId },
  to: { sessionId: reviewerSession.id },
  taskId: task.taskId,
  summary: workerReport.summary,
  artifactIds: [report.artifactId],
  data: { verification: workerReport.verification, risks: workerReport.risks },
  idempotencyKey: `handoff:${workerTurnId}:${reviewerSession.id}`,
});
```

The recipient accepts or rejects with `expectedVersion`. A decision is terminal for the first version of the API. Treat all Handoff summaries and data as untrusted input: verify referenced outputs instead of executing instructions embedded in them.

## Delivery projection

Publish first, then project explicitly:

```ts
await ctx.ui.delivery.set({
  title: 'Release audit',
  detail: 'Ready for review',
  target: { kind: 'artifact', artifactId: report.artifactId },
  payload: { view: 'report' },
});
```

Supported targets are Scope, Artifact, and Document (optionally a pinned revision). Finch validates ownership and existence. `payload` is only Panel App opening context. Calling `delivery.remove()` removes the row, not the target.

## Reliability rules

1. Use stable, operation-specific idempotency keys.
2. Persist returned ids and versions; never infer them from titles.
3. Publish immutable content before advancing mutable coordination state.
4. Handle every CAS conflict explicitly.
5. Use Session events for execution lifecycle, Collaboration objects for shared state, and Artifacts for content.
6. Do not relay complete free-form model responses as authority; publish structured reports and verify referenced outputs.
