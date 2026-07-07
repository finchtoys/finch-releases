# @finch.app/minitools

CLI shim for installing Finch mini tools to the correct location.

## Usage

```bash
# Install from npm
npx @finch.app/minitools add @scope/finch-mini-tool-example

# Install a local mini tool directory
npx @finch.app/minitools add ./my-tool

# Install from a zip file (local or URL)
npx @finch.app/minitools add ./my-tool.zip
npx @finch.app/minitools add https://github.com/user/repo/archive/refs/heads/main.zip

# Install to the current project
npx @finch.app/minitools add @finch.app/mcp-client --cwd

# Install to a specific project path
npx @finch.app/minitools add @finch.app/mcp-client --cwd /path/to/project

# Install globally (~/.finch/extensions/)
npx @finch.app/minitools add @finch.app/mcp-client --global

# List installed mini tools
npx @finch.app/minitools list
npx @finch.app/minitools list --global

# Remove an mini tool
npx @finch.app/minitools remove mcp-client

# Show install paths
npx @finch.app/minitools where

# Validate an mini tool package
npx @finch.app/minitools doctor ./my-tool
```

## Install locations

| Flag | Path | Scope |
|---|---|---|
| *(default)* | `<workspace.json#finchHomeDir>/.finch/extensions/<id>/` | Current Finch workspace |
| `--cwd` | `<process.cwd()>/.finch/extensions/<id>/` | Current project |
| `--cwd path` | `<path>/.finch/extensions/<id>/` | Specific project |
| `--global` | `~/.finch/extensions/<id>/` | All Finch sessions |

The default workspace path is read from `~/.finch/workspace.json#finchHomeDir`.

## Mini tool package

A Finch mini tool is an npm-style package with `package.json#finch`:

```json
{
  "name": "my-tool",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "finch": {
    "manifestVersion": 1,
    "id": "my-tool",
    "displayName": "My Tool",
    "main": "dist/index.js",
    "activationEvents": ["onStartup"]
  }
}
```

`add` installs the mini tool but does not enable or grant permissions. Open Finch → Toolcase → Tools to review permissions and enable it.
