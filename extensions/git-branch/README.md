# Git Branch

A Finch extension for managing Git branches directly from the Composer toolbar.

## Features

- Show the current Git branch as a Composer toolbar badge.
- List common branches such as `main` and `master` at the top.
- Put additional branches in a grouped submenu with a limited visible count.
- Preview uncommitted file changes before switching branches.
- Highlight added and deleted line counts in the confirmation dialog.
- Commit current workspace changes as a checkpoint before switching branches.
- Show a toast after a checkpoint commit and successful branch switch.
- Create and checkout a new branch through the Finch agent tool.
- Follow Finch app language via runtime i18n.

## Usage

1. Open a Finch session inside a Git repository.
2. Click the Git Branch action in the Composer toolbar.
3. Select a branch to switch to.
4. If the workspace has uncommitted changes, confirm whether to create a checkpoint commit before switching.
5. Use **Create and checkout branch...** to start the branch creation flow.

## Permissions

This extension requires shell permission because it runs local `git` commands. It does not require network access.

## Development

```bash
npm install
npm run build
```

Install or update locally with the Finch extensions CLI:

```bash
npx @finch.app/extensions update git-branch
```
