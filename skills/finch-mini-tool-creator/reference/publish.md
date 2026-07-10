# Publishing a Mini Tool

This document covers everything from packaging to npm release to community listing.

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

## 2. What to include in the npm package

Only ship what Finch needs at runtime. **Do not publish source files.**

Recommended approach — use `.npmignore` (or `files` in `package.json`) to keep the tarball small:

### Option A — `files` allowlist (preferred)

```json
{
  "files": [
    "dist/",
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

## 3. Publish to npm

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

---

## 4. Recommended package.json shape

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
    "id": "my-tool",
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
- `name` and `finch.id` serve different purposes: `name` is the npm package identifier, `finch.id` is the stable in-app identifier. Keep `finch.id` stable after the first release.

---

## 5. List on the official community

To have your mini tool appear in the Finch community catalog:

1. Make sure it is already published to npm and installable via `npx @finchtoys/minitools add <package>`.
2. Include an `icon.png` at the package root. It is required for community listing, must be a PNG between **128×128** and **300×300** pixels (inclusive), and must be included in the published npm tarball.
3. Open an issue on the Finch releases repository:

   **https://github.com/finchtoys/finch-releases/issues**

4. Create a new issue with the label **小工具发布申请**.
5. Include in the issue body:
   - npm package name
   - `finch.id`
   - Short description (one sentence, shown in the catalog)
   - Confirmation that the package includes a compliant `icon.png` (PNG, 128×128–300×300 px)
   - Screenshot or demo GIF (optional but recommended)
   - Whether the mini tool requires any API keys or permissions

The Finch team will review and merge the entry into the community index. Once listed, users can discover and install it directly from Finch Toolcase without knowing the package name.

---

## 6. Maintenance after publishing

- **Bug fix** → bump patch version, `npm publish`, users update with CLI.
- **New capability** → bump minor version, update README, re-submit if the catalog description needs updating.
- **Breaking change** → bump major version, document migration steps in README.
- **Deprecation** → mark the package as deprecated on npm (`npm deprecate`) and notify users via the GitHub issue you used for the original submission.

---

## 7. Checklist

```
[ ] npm login verified
[ ] dist/ is up to date (npm run build)
[ ] .npmignore or files field excludes src/ and config files
[ ] no secrets or .env files in the package
[ ] finch.id is stable and matches the install directory name
[ ] prepublishOnly script runs the build
[ ] README explains what the tool does and any required setup
[ ] `icon.png` is at the package root and included in the npm tarball
[ ] `icon.png` is PNG and between 128×128 and 300×300 pixels (inclusive) for community listing
[ ] npm publish --access public succeeded
[ ] test install: npx @finchtoys/minitools add <package>
[ ] (optional) open issue on finch-releases for community listing
```
