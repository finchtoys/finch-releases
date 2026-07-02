# @finch.app/extensions

CLI shim for installing Finch extensions to the correct location.

## Usage

```bash
# Install from npm
npx @finch.app/extensions add @scope/finch-extension-example

# Install a local extension directory
npx @finch.app/extensions add ./my-extension

# Install from a zip file (local or URL)
npx @finch.app/extensions add ./my-extension.zip
npx @finch.app/extensions add https://github.com/user/repo/archive/refs/heads/main.zip

# Install to the current project
npx @finch.app/extensions add @finch/extension-mcp --cwd

# Install to a specific project path
npx @finch.app/extensions add @finch/extension-mcp --cwd /path/to/project

# Install globally (~/.finch/extensions/)
npx @finch.app/extensions add @finch/extension-mcp --global

# List installed extensions
npx @finch.app/extensions list
npx @finch.app/extensions list --global

# Remove an extension
npx @finch.app/extensions remove mcp

# Show install paths
npx @finch.app/extensions where

# Validate an extension package
npx @finch.app/extensions doctor ./my-extension
```

## Install locations

| Flag | Path | Scope |
|---|---|---|
| *(default)* | `<workspace.json#finchHomeDir>/.finch/extensions/<id>/` | Current Finch workspace |
| `--cwd` | `<process.cwd()>/.finch/extensions/<id>/` | Current project |
| `--cwd path` | `<path>/.finch/extensions/<id>/` | Specific project |
| `--global` | `~/.finch/extensions/<id>/` | All Finch sessions |

The default workspace path is read from `~/.finch/workspace.json#finchHomeDir`.

## Extension package

A Finch extension is an npm-style package with `package.json#finch`:

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "finch": {
    "manifestVersion": 1,
    "id": "my-extension",
    "displayName": "My Extension",
    "main": "dist/index.js",
    "activationEvents": ["onStartup"]
  }
}
```

`add` installs the extension but does not enable or grant permissions. Open Finch → Toolcase → Extensions to review permissions and enable it.
