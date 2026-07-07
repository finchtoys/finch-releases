# Git Branch

Git Branch is a mini tool for [Finch](https://finchwork.app/) — a desktop AI agent you can download at [finchwork.app](https://finchwork.app/). 

It puts a handy Git branch widget right inside your chat dialog.

## What it does

- Shows which branch you're currently on, right in the top bar of your chat.
- Puts main branches like `main` and `master` at the top.
- Puts other branches inside a grouped menu, showing up to 6 at a time.
- Before switching branches, it checks if you have unsaved changes and shows you what's been modified.
- Highlights added and deleted lines in green and red.
- If you have unsaved changes, it can save a checkpoint commit first, then switch.
- After switching, it tells you which commit was saved and which branch you're now on.
- You can also ask the Agent to create a new branch for you.

## How to use

1. Open a Finch chat inside a Git project folder.
2. Click the Git branch button on the top bar of the chat.
3. Pick a branch to switch to.
4. If there are unsaved changes, the dialog asks: save a checkpoint first, or cancel.
5. Click **Create and checkout branch...** to let the Agent help you name a new branch.

## Permissions

This tool needs shell permission because it runs `git` commands locally. No network access needed.

## Development

```bash
npm install
npm run build
```

Install or update locally:

```bash
npx @finch.app/minitools update git-branch
```
