## Git Source Control for Finch

Git Source Control is a mini tool for [Finch](https://finchwork.app/) — a desktop AI agent you can download at [finchwork.app](https://finchwork.app/). 

![Git Branch](https://raw.githubusercontent.com/finchtoys/finch-releases/refs/heads/main/extensions/git-branch/shot.png)

It adds both a compact Git branch widget to chat and a Source Control Panel app.

## What it does

- Shows which branch you're currently on, right in the top bar of your chat.
- Puts main branches like `main` and `master` at the top.
- Puts other branches inside a grouped menu, showing up to 6 at a time.
- Before switching branches, it checks if you have unsaved changes and shows you what's been modified.
- Highlights added and deleted lines in green and red.
- If you have unsaved changes, it can save a checkpoint commit first, then switch.
- After switching, it tells you which commit was saved and which branch you're now on.
- You can also ask the Agent to create a new branch for you.
- Opens a 12px monospace **Source Control** panel with repository, changes, and commit graph lists.
- Detects the current repository and its `.gitmodules` submodules, showing branch, dirty `*`, and ahead/behind status.
- Supports Fetch, Pull (fast-forward only), Push, staging, unstaging, discarding a file, opening a file preview, and committing staged changes.

## How to use

1. Open a Finch chat inside a Git project folder.
2. Open **Source Control** from the right Panel launcher.
3. Select the main repository or a detected submodule. A `*` beside the branch means it has local changes.
4. Stage files, write a message, then click **Commit**. Use Fetch / Pull / Push to synchronize.
5. Use the chat Git branch button to switch or create a branch; it protects you from switching with uncommitted changes.

The first version intentionally leaves out force-push, rebase, reset, cherry-pick, and history rewriting. They are powerful but too easy to misuse in a lightweight daily UI.

## Permissions

This tool needs shell permission to run local `git` commands and read-only filesystem permission to inspect repository metadata and changed files. No network access needed.

## Development

```bash
npm install
npm run build
```

Install or update locally:

```bash
npx @finchtoys/minitools update git-branch
```
