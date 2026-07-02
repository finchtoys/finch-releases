# @finch.app/skills

CLI shim for installing [Finch](https://github.com/puterjam/finch) skills to the correct location — no matter which tool you used to get them.

## Why this exists

Many skill packages are distributed as directories with a `SKILL.md` file. Tools that publish or install them don't always know where Finch expects to find them (`.finch/skills/<name>/`). This shim bridges that gap.

## Usage

```bash
# GitHub shorthand
npx @finch.app/skills add owner/repo

# Full GitHub URL
npx @finch.app/skills add https://github.com/owner/repo

# Direct path to a skill inside a repo
npx @finch.app/skills add https://github.com/owner/repo/tree/main/skills/my-skill

# GitLab URL
npx @finch.app/skills add https://gitlab.com/org/repo

# SSH git URL
npx @finch.app/skills add git@github.com:owner/repo.git

# Local path
npx @finch.app/skills add ./my-local-skill

# Install to the current project
npx @finch.app/skills add owner/repo --cwd

# Install to a specific project path
npx @finch.app/skills add owner/repo --cwd /path/to/project

# Install globally (~/.finch/skills/)
npx @finch.app/skills add owner/repo --global

# Pick one skill by name when a repo has several
npx @finch.app/skills add owner/repo --skill my-skill

# List
npx @finch.app/skills list [--global]

# Remove one skill
npx @finch.app/skills remove my-skill [--global]

# Remove multiple skills at once
npx @finch.app/skills remove frontend-design web-design-guidelines

# 'rm' is an alias for remove
npx @finch.app/skills rm my-skill

# Show install paths
npx @finch.app/skills where
```

## Install locations

| Flag | Path | Scope |
|---|---|---|
| *(default)* | `<workspace.json#finchHomeDir>/.finch/skills/<name>/` | Current Finch workspace |
| `--cwd` | `<process.cwd()>/.finch/skills/<name>/` | Current project |
| `--cwd path` | `<path>/.finch/skills/<name>/` | Specific project |
| `--global` | `~/.finch/skills/<name>/` | All Finch sessions |

- **Default (no flag):** reads `~/.finch/workspace.json#finchHomeDir` and installs under that workspace home.
- **`--cwd`:** installs under the current working directory. Finch picks it up automatically when a session or Space is opened in that directory.
- **`--cwd path`:** installs under the specified project directory.
- **`--global`:** installs under `~/.finch/skills/`, available across every session regardless of directory.

## What is a skill?

A skill is a directory containing a `SKILL.md` file with YAML frontmatter:

```
---
name: my-skill
description: Does something useful
---

# Instructions for the AI agent...
```

After installing, open Finch → Toolcase to see and enable your new skill.

## Requirements

- Node.js 18+
- Finch desktop app

## License

MIT
