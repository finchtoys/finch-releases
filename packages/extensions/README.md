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

# Install globally (~/.finch/plugins/)
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
| *(default)* | `<cwd>/.finch/plugins/<id>/` | Project / Space session |
| `--global` | `~/.finch/plugins/<id>/` | All Finch sessions |

Set `FINCH_HOME` to override the global Finch data directory.

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
