# Publishing a Mini Tool

This document covers offline `.fapp` installers, npm release, and community listing. `.fapp` is optional: use §3.1 only when the user explicitly requests this format or chooses it as the distribution method. A general request to develop, package, share, or publish a mini tool does not require generating a `.fapp`; directory/CLI and npm workflows remain valid. npm publication is not required for `.fapp` distribution.

---

## 1. Before you publish

Run a full pre-publish check:

```bash
npm run typecheck          # no TypeScript errors
npx @finchtoys/minitools doctor .   # manifest is valid
npm run build              # dist/ is up to date
```

Make sure the `version` field in `package.json` follows semver and is bumped before every release.

---

## 2. Extension ID — derived from the npm package name, not `finch.id`

**You do not need to hand-pick a `finch.id`.** When `add`/`update` (or the Toolcase "install extension" file picker) installs your package, Finch derives the actual runtime extension id from `package.json#name`, ignoring `finch.id` whenever a package name is present:

- Unscoped name passes through unchanged: `finch-my-tool` → id `finch-my-tool`.
- Scoped name joins scope and name with `@`, not `-`: `@yourscope/finch-my-tool` → id `yourscope@finch-my-tool`.

Why: npm already guarantees package names are globally unique, so this is collision-free without every author independently agreeing on a short id — two unrelated tools both picking `id: "helper"` used to silently collide. The `@` join (instead of `-`) also matters for spoof-resistance: npm only allows `@` as the very first character of a scoped package name, so no *unscoped* package can ever be published with a literal `@` in it — an id like `yourscope@finch-my-tool` can only ever have come from the scoped package `@yourscope/finch-my-tool`, never from an unrelated unscoped package trying to impersonate it.

Practical implications:

- `finch.id` in the manifest is now effectively optional/cosmetic for anything published to npm — omit it, or set it to match your package name locally for readability; it no longer determines the installed id.
- `finch.id` is still the actual id for the small set of **officially bundled** extensions (`mcp`, `git-branch`, …), which are deployed by direct copy and never go through this derivation. That path is Finch-internal — not something a community mini tool author needs to replicate.
- Renaming your npm package's `name` field after the first release **does** change the id future installs get (it's the whole identifier, not a legacy freeform string) — treat `name` as the thing you must keep stable, not `finch.id`.
- Already-installed extensions from before this policy existed keep whatever id they were installed with; this only governs new installs and reinstalls going forward.
- `update <id>` always updates in place — it never re-derives or moves an existing install to a different id mid-update, even if your package name changes.
- An install can't silently take over an id that already belongs to a different npm package; the CLI rejects a mismatched-package overwrite with an explicit error.

---

## 3. What to include in the npm package

Only ship what Finch needs at runtime. **Do not publish source files.**

Recommended approach — use `.npmignore` (or `files` in `package.json`) to keep the tarball small:

### Option A — `files` allowlist (preferred)

```json
{
  "files": [
    "dist/",
    "finch.json",
    "i18n/",
    "skills/",
    "icons/",
    "icon.png",
    "README.md",
    "package.json"
  ]
}
```

Anything not listed is excluded automatically.

### Option B — `.npmignore` blocklist

```
src/
tsconfig.json
*.ts
.eslintrc*
.prettierrc*
tests/
```

### What each directory contains

| Path | Include? | Reason |
|---|---|---|
| `dist/` | ✅ required | compiled runtime entry |
| `finch.json` | ✅ required if used | standalone manifest (recommended for new mini tools) |
| `i18n/` | ✅ if used | locale override files |
| `skills/` | ✅ if bundled | SKILL.md assets |
| `icons/` | ✅ if bundled | SVG icon packs |
| `icon.png` | ✅ | shown in Finch Toolcase |
| `README.md` | ✅ | displayed on npm and community |
| `src/` | ❌ skip | TypeScript source, not needed at runtime |
| `tsconfig.json` | ❌ skip | build config only |
| `tests/` | ❌ skip | test code |
| `.env*` | ❌ never | secrets must never be published |

---

### 3.1 Offline installer: `.fapp`

A `.fapp` is a **standard ZIP with a `.fapp` suffix**, not an npm `.tgz`, executable, or new manifest format. Use stored or deflate compression and UTF-8 filenames. Ordinary `.zip` and legacy `.fmp` files are not accepted by this install entry. There is no dedicated CLI `pack` command; do not invent one or pass `.fapp` to CLI `add` as if it were a supported source.

Prepare a clean staging directory containing only runtime files:

```text
staging/
├── package.json          # stable npm-style name + finch manifest, or separate finch.json
├── finch.json            # only if using a standalone manifest
├── dist/                 # compiled entry and packaged UI
├── i18n/                 # if used
├── skills/               # if used
├── icons/                # if used
├── icon.png
└── node_modules/         # only if external runtime dependencies remain
```

- Put `package.json` **at the ZIP root**, not under `staging/`, `package/`, or another parent folder. `package.json#name` determines the installed identity (§2); it need not be published to npm. Include `package.json#finch` or `finch.json`, and make sure the declared runtime entry exists inside the package.
- Build first. Include every compiled entry, local HTML/JS/CSS, image/audio/icon, locale file, and bundled Skill referenced at runtime. Do not simply rename a source ZIP or npm tarball.
- The installer **does not run npm, install scripts, or fetch missing dependencies**. Prefer bundling runtime JS dependencies; otherwise include the complete production dependency tree as real files. Omit dev dependencies and `node_modules/.bin` symlinks; do not copy a pnpm/workspace symlink tree. Native binaries must match the recipient platform/runtime; `.fapp` does not make them cross-platform.
- Exclude `.git`, `.env*`, credentials, personal data, source/build-only files, and runtime markers (`.enabled`, `.finch-id`, `.bundled`). Symlinks and special files are rejected; resolve dependencies deliberately into the clean staging tree instead of blindly archiving links.
- Limits: ZIP ≤128 MiB, ≤10,000 entries, each uncompressed file ≤32 MiB, total uncompressed size ≤256 MiB. No encryption, multipart ZIP, or ZIP64. Avoid absolute/parent paths, Windows reserved names, and case-only collisions.

Example with Python 3, run from the directory containing the prepared `staging/` (the output is outside it):

```python
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path('staging')
output = Path('my-mini-tool-0.1.0.fapp')
assert (root / 'package.json').is_file(), 'package.json must be at the root'
files = sorted(root.rglob('*'))
for path in files:
    if path.is_symlink() or not (path.is_file() or path.is_dir()):
        raise ValueError(f'Unsupported link or special file: {path}')
with ZipFile(output, 'w', compression=ZIP_DEFLATED, allowZip64=False) as archive:
    for path in files:
        if path.is_file():
            archive.write(path, path.relative_to(root).as_posix())
```

This example packages an already curated staging tree; it is not a substitute for the content/size checks above or Finch's authoritative validation. Inspect the ZIP listing and verify the manifest, entry, resources, dependencies, and absence of secrets before delivery.

**Install and verify:** the user can double-click the `.fapp` with an installed Finch version that registers the file association, or drag it into Finch's **main window** (including source Dev, which does not register OS associations). It opens an install confirmation; cancellation installs nothing. After confirmation, a new install or replacement goes to the **personal** tier, stays **disabled**, and receives **no permissions**. The user must explicitly review permissions and enable it in Toolcase. A matching global install is shadowed by the personal copy; a development symlink target cannot be overwritten. This is local unsigned code — package names and author fields do not authenticate the publisher.

When the user explicitly requests or chooses `.fapp`, deliver that package with its install instructions. Otherwise, keep the requested delivery method; do not add a mandatory `.fapp` packaging step. Do not auto-confirm installation or enable the package to test it without user authorization. Community listing still follows §6's npm requirements.

---

## 4. Publish to npm

```bash
# First time — log in to npm
npm login

# Publish (public scope required for scoped packages)
npm publish --access public
```

After publishing, users can install your mini tool with:

```bash
npx @finchtoys/minitools add <your-package-name>
```

For example:

```bash
npx @finchtoys/minitools add @yourscope/finch-my-tool
```

### Version updates

```bash
npm version patch   # or minor / major
npm publish --access public
```

Users update with:

```bash
npx @finchtoys/minitools update <id>
```

`<id>` is the derived id described in §2 (e.g. `yourscope@finch-my-tool`), which is what shows up in `npx @finchtoys/minitools list`.

---

## 5. Recommended package.json shape

```json
{
  "name": "@yourscope/finch-my-tool",
  "version": "0.1.0",
  "description": "A short description shown on npm",
  "main": "dist/index.js",
  "files": [
    "dist/",
    "i18n/",
    "skills/",
    "icons/",
    "icon.png",
    "README.md"
  ],
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build"
  },
  "devDependencies": {
    "@finchtoys/minitool-api": "latest",
    "typescript": "^5.0.0"
  },
  "finch": {
    "manifestVersion": 1,
    "name": "My Tool",
    "main": "dist/index.js",
    "activationEvents": ["onStartup"],
    "contributes": {
      "tools": true
    }
  }
}
```

Key points:

- `prepublishOnly` runs the build automatically before every `npm publish`.
- `devDependencies` only — `@finchtoys/minitool-api` is types-only and is injected by the Finch runtime; it must **not** be in `dependencies`.
- `name` is what actually determines the installed id (see §2) — keep it stable across releases. `finch.id` is optional now; keep it in sync with `name` for readability if you set it at all, but it has no effect on published-package installs.

---

## 6. List on the official community

To have your mini tool appear in the Finch community catalog:

1. Make sure it is already published to npm and installable via `npx @finchtoys/minitools add <package>`.
2. Include an `icon.png` at the package root. It is required for community listing, must be a PNG between **128×128** and **300×300** pixels (inclusive), and must be included in the published npm tarball.
3. Ask Finch to submit the request through `AppCall action=feedback` with `feedbackCategory: "minitool"`. Finch opens the official GitHub Issue form with the `minitool` label prefilled; review and submit it in GitHub.
4. Include in the issue body:
   - npm package name (this is what determines the installed id — see §2)
   - Short description (one sentence, shown in the catalog)
   - Confirmation that the package includes a compliant `icon.png` (PNG, 128×128–300×300 px)
   - Screenshot or demo GIF (optional but recommended)
   - Whether the mini tool requires any API keys or permissions

The Finch team will review and merge the entry into the community index. Once listed, users can discover and install it directly from Finch Toolcase without knowing the package name.

---

## 7. Maintenance after publishing

- **Bug fix** → bump patch version, `npm publish`, users update with CLI.
- **New capability** → bump minor version, update README, re-submit if the catalog description needs updating.
- **Breaking change** → bump major version, document migration steps in README.
- **Deprecation** → mark the package as deprecated on npm (`npm deprecate`) and notify users via the GitHub issue you used for the original submission.
- **Renaming the npm package** → treat this like a breaking change: it changes the id new installs/reinstalls get (§2). Existing users who already installed under the old id are unaffected until they explicitly reinstall.

---

## 8. Checklist

```
[ ] npm login verified
[ ] dist/ is up to date (npm run build)
[ ] .npmignore or files field excludes src/ and config files
[ ] no secrets or .env files in the package
[ ] package.json#name is final — this determines the installed id (§2), not finch.id
[ ] prepublishOnly script runs the build
[ ] README explains what the tool does and any required setup
[ ] `icon.png` is at the package root and included in the npm tarball
[ ] `icon.png` is PNG and between 128×128 and 300×300 pixels (inclusive) for community listing
[ ] npm publish --access public succeeded
[ ] test install: npx @finchtoys/minitools add <package>
[ ] (optional) open issue on finch-releases for community listing
```
