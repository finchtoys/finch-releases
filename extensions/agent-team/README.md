# Agent Team

Agent Team is an event-driven Finch mini tool for coordinating multiple models and roles across one or more Spaces.

## Highlights

The top bar counts only Planner, Worker, and Reviewer Sessions created by this mini tool. It never reflects Finch-global session activity, so your own conversations are not included.

- Generate projects, roles, workflows, task dependencies, and acceptance criteria with a commander model.
- Discover one dynamic collaboration tool through ToolSearch instead of exchanging large JSON payloads in final responses.
- Assign a model, reasoning effort, Space, and concurrency limit to every role; unavailable models block explicitly instead of silently falling back.
- Fan out dependency-ready tasks into background Sessions.
- Render live `assistant.delta` output while durable Turn events drive project state.
- Persist plans, file outputs, worker reports, and review decisions through Artifacts and Collaboration, with bounded rework attempts.
- Recover missed events after a reload through per-Session cursors.
- Collect permission, question, and form waits in one Human Inbox.
- Keep destructive approvals human-only and navigate to the original Session.
- Customize workflows, drag task cards, cancel an exact Turn, and retry blocked work.

## Use

1. Open **Agent Team** from the Finch sidebar.
2. Choose **Create with AI** and describe the project.
3. Select the commander model, reasoning effort, Spaces, permission mode, and concurrency.
4. Review the generated draft and customize its workflow.
5. Start the team. Ready tasks are dispatched in parallel.
6. Handle blocked interactions in the Human Inbox.
7. Review progress, reports, and run history from the board.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run doctor
```

The host runtime is emitted to `dist/backend/`; the React App View is emitted to `dist/appview/`.

The UI uses Finch `--finch-*` theme tokens, shadcn-style components, Radix Dialog, and Lucide icons. It follows Finch light, dark, and custom skins automatically.

## Data storage

Project state is stored in `ctx.storagePath/agent-team.sqlite`, the private directory Finch assigns to the mini tool. SQLite runs in WAL mode with a five-second busy timeout and `BEGIN IMMEDIATE` transactions, preventing concurrent writers from corrupting state or silently overwriting a newer snapshot.

Projects, tasks, runs, waits, activities, and Session cursors use separate tables. On the first upgraded launch, legacy `ctx.storage` state is migrated automatically and removed only after the SQLite transaction commits.

## Permissions

| Permission | Purpose |
|---|---|
| `sessions` | Create owned Sessions, send work, observe events, and read waits |
| `sessionInteractions` | Relay a real user's response to an existing wait card |
| `artifacts` | Snapshot plans, worker reports, and submitted files |
| `collaboration` | Create scopes, documents, tasks, and handoffs |
| `filesystem: read` | Snapshot only files explicitly submitted from the active worker's current directory |

The mini tool requests no network or shell permission. Worker actions remain governed by Finch Session permissions.
