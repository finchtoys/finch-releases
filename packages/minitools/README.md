# @finchtoys/minitools

CLI shim for installing Finch mini tools to the correct location.

## Usage

```bash
# Install from npm
npx @finchtoys/minitools add @scope/finch-mini-tool-example

# Install a local mini tool directory
npx @finchtoys/minitools add ./my-tool

# Install from a zip file (local or URL)
npx @finchtoys/minitools add ./my-tool.zip
npx @finchtoys/minitools add https://github.com/user/repo/archive/refs/heads/main.zip

# Install globally (~/.finch/extensions/)
# Default installs go to the personal Finch workspace extension directory.
npx @finchtoys/minitools add @finchtoys/mcp-client --global

# List installed mini tools (id, version, enabled/disabled, name, path)
npx @finchtoys/minitools list
npx @finchtoys/minitools list --global

# Remove a mini tool
npx @finchtoys/minitools remove mcp-client

# Show install paths
npx @finchtoys/minitools where

# Validate a mini tool package
npx @finchtoys/minitools doctor ./my-tool
```

## Install locations

| Flag | Path | Scope |
|---|---|---|
| *(default)* | `<workspace.json#finchHomeDir>/.finch/extensions/<id>/` | Personal Finch workspace |
| `--global` | `~/.finch/extensions/<id>/` | All Finch sessions |

The default workspace path is read from `~/.finch/workspace.json#finchHomeDir`. There is no project/`--cwd` scope for mini tools; use the personal default or `--global`.

## Registry and downloads

Pinned npm specs such as `@scope/tool@1.2.3` skip npm registry metadata and download directly from `https://community.finchwork.app/download/minitool/<package>/<version>`. Unpinned specs such as `@scope/tool` or `@scope/tool@latest` still use npm registry metadata to resolve the concrete version first; `--registry <url>` only affects that metadata lookup, not the final package download.

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
    "name": "My Tool",
    "main": "dist/index.js",
    "activationEvents": ["onStartup"]
  }
}
```

`doctor` reports fatal issues and warnings. `add` / `update` block packages with fatal validation issues such as a missing `package.json#finch`, invalid `id`, unsupported `manifestVersion`, malformed contribution declarations, or a missing entry file.

Downloads served by `https://community.finchwork.app/download/minitool/<package>/<version>` are cached under `~/.finch/cache/minitools/` by package and version, so reinstalling or updating the same version avoids another network download.

`add` installs the mini tool but does not enable or grant permissions. Open Finch → Toolcase → Tools to review permissions and enable it.
