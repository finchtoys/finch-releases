#!/usr/bin/env node
/**
 * @finch.app/extensions — install Finch extensions to the correct location.
 *
 * Zero npm dependencies. npm sources are fetched with `npm install --ignore-scripts`
 * so third-party install scripts never run during CLI install.
 */
import {
  existsSync, mkdirSync, readdirSync, cpSync, rmSync,
  readFileSync, writeFileSync, statSync,
} from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const LOCK_FILE = '.plugins-lock.json';

function finchRuntimeHome() {
  return process.env.FINCH_RUNTIME_HOME ?? join(homedir(), '.finch');
}
function expandHomePath(path) {
  return path.replace(/^~(?=\/|$)/, homedir());
}
function workspaceStatePath() {
  return join(finchRuntimeHome(), 'workspace.json');
}
function configuredAgentHome() {
  const state = readJson(workspaceStatePath(), {});
  const configured = typeof state.finchHomeDir === 'string' && state.finchHomeDir.trim()
    ? state.finchHomeDir.trim()
    : join(homedir(), 'finchnest');
  return resolve(expandHomePath(configured));
}
function globalPluginsDir() {
  return join(homedir(), '.finch', 'extensions');
}
function personalPluginsDir() {
  return join(configuredAgentHome(), '.finch', 'extensions');
}
function projectPluginsDir(cwd = process.cwd()) {
  return join(resolve(expandHomePath(cwd)), '.finch', 'extensions');
}
function targetDir(opts) {
  if (opts.global) return globalPluginsDir();
  if (opts.cwd !== undefined) return projectPluginsDir(opts.cwd || process.cwd());
  return personalPluginsDir();
}
function pluginsStatePath() {
  return join(finchRuntimeHome(), 'extensions.json');
}
function lockPath(dir) {
  return join(dir, LOCK_FILE);
}
function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}
function writeJson(path, data) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
function readLock(dir) {
  return readJson(lockPath(dir), {});
}
function writeLock(dir, lock) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath(dir), JSON.stringify(lock, null, 2) + '\n', 'utf-8');
}
function recordInstall(dir, id, source) {
  const lock = readLock(dir);
  lock[id] = { ...source, installedAt: new Date().toISOString() };
  writeLock(dir, lock);
}
function deleteRecord(dir, id) {
  const lock = readLock(dir);
  delete lock[id];
  writeLock(dir, lock);
}

function readPackageJson(dir) {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return null; }
}

function pluginInfo(dir) {
  const pkg = readPackageJson(dir);
  const manifest = pkg?.finch;
  if (!pkg || !manifest || typeof manifest !== 'object') return null;
  const id = String(manifest.id ?? pkg.name ?? '').trim();
  if (!id) return { error: 'package.json#finch 缺少 id' };
  const main = String(manifest.main ?? pkg.main ?? 'dist/index.js');
  if (!existsSync(join(dir, main))) return { error: `入口文件不存在: ${main}（请先构建插件）`, id };
  // `name` is the current preferred manifest field; `displayName` is kept only
  // for backward compatibility with older extensions.
  const nameField = manifest.name ?? manifest.displayName;
  return {
    id,
    name: pkg.name ?? id,
    version: pkg.version ?? '0.0.0',
    displayName: typeof nameField === 'string'
      ? nameField
      : nameField?.default ?? nameField?.['en-US'] ?? nameField?.['zh-CN'] ?? id,
    main,
  };
}

function findPluginDirs(root, maxDepth = 4) {
  const found = [];
  const seen = new Set();
  function visit(dir, depth) {
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const info = pluginInfo(dir);
    if (info && !info.error) found.push(dir);
    if (depth <= 0) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '.git' || e.name === '.cache') continue;
      visit(join(dir, e.name), depth - 1);
    }
  }
  visit(root, maxDepth);
  return found;
}

function installExtensionDir(srcDir, destRoot, lockSource) {
  const info = pluginInfo(srcDir);
  if (!info) throw new Error(`不是 Finch 扩展: ${srcDir}`);
  if (info.error) throw new Error(info.error);
  mkdirSync(destRoot, { recursive: true });
  const dest = join(destRoot, info.id);
  cpSync(srcDir, dest, { recursive: true, force: true, dereference: false });
  recordInstall(destRoot, info.id, lockSource);
  console.log(`✓ Added "${info.displayName}" (${info.id}) → ${dest}`);
  console.log('  Installed only. Open Finch → Toolcase → Extensions to review permissions and enable.');
  return info.id;
}

/**
 * Look for an executable on PATH (via `which`/`where`), falling back to a
 * handful of common install locations that don't always make it onto the
 * PATH inherited by a GUI-launched app (Homebrew, nvm, Volta, Windows
 * installer). Returns the resolved path, or null if not found anywhere.
 */
function findExecutable(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(finder, [name], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
  if (found.status === 0) {
    const first = found.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) return first;
  }

  const candidateDirs = process.platform === 'win32'
    ? [
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
        join(process.env.APPDATA ?? '', 'npm'),
      ]
    : (() => {
        const dirs = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.volta', 'bin')];
        const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
        try {
          for (const version of readdirSync(nvmRoot)) dirs.push(join(nvmRoot, version, 'bin'));
        } catch { /* nvm not installed */ }
        return dirs;
      })();
  const exeName = process.platform === 'win32' ? `${name}.cmd` : name;
  for (const dir of candidateDirs) {
    const candidate = join(dir, exeName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const NODEJS_INSTALL_HINT = 'Install Node.js (which bundles npm) from https://nodejs.org, then try again.';

function npmInstallToTemp(spec, tmp) {
  const npmPath = findExecutable('npm');
  if (!npmPath) {
    throw new Error(`This extension is an npm package, but no "npm" executable was found on this machine.\n${NODEJS_INSTALL_HINT}`);
  }
  mkdirSync(tmp, { recursive: true });
  const r = spawnSync(npmPath, ['install', '--ignore-scripts', '--omit=dev', '--prefix', tmp, spec], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  if (r.error) {
    throw new Error(`Failed to run npm (${npmPath}): ${r.error.message}\n${NODEJS_INSTALL_HINT}`);
  }
  if (r.status !== 0) {
    throw new Error(`npm install failed:\n${r.stderr || r.stdout || `exit code ${r.status}`}`);
  }
}

function isLocalSource(src) {
  return src.startsWith('./') || src.startsWith('../') || src.startsWith('/') || src.startsWith('~');
}
function isZipUrl(src) {
  return /^https?:\/\/.+\.zip(\?.*)?$/i.test(src);
}
function isZipFile(src) {
  return src.toLowerCase().endsWith('.zip');
}
function expandHome(path) {
  return path.replace(/^~(?=\/|$)/, homedir());
}

/**
 * Download a URL to a local file path using Node's built-in fetch (Node 18+).
 * Falls back to curl/wget if fetch is unavailable.
 */
async function downloadFile(url, destPath) {
  if (typeof fetch === 'function') {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} — ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(destPath, buf);
  } else {
    // Fallback: curl (macOS / Linux always has it)
    const r = spawnSync('curl', ['-fsSL', '-o', destPath, url], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`curl failed:\n${r.stderr || r.stdout}`);
  }
}

/**
 * Extract a zip archive to destDir using the system `unzip` command (macOS / Linux built-in).
 */
function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  if (r.error) {
    throw new Error(`No "unzip" command found on this machine: ${r.error.message}`);
  }
  if (r.status !== 0) throw new Error(`unzip failed:\n${r.stderr || r.stdout || `exit code ${r.status}`}`);
}

/**
 * Install extensions from a zip file (local path or remote URL).
 * The zip may contain one or more extensions at any nesting level.
 */
async function installFromZip(src, dest, isUrl) {
  const tmp = join(tmpdir(), `finch-ext-${randomUUID()}`);
  const zipPath = join(tmp, 'extension.zip');
  const extractDir = join(tmp, 'extracted');
  mkdirSync(tmp, { recursive: true });
  try {
    if (isUrl) {
      console.log(`  Downloading ${src} …`);
      await downloadFile(src, zipPath);
    } else {
      // Local zip — copy to tmp so we have a consistent path
      const abs = resolve(expandHome(src));
      if (!existsSync(abs)) throw new Error(`file not found: ${abs}`);
      cpSync(abs, zipPath);
    }
    console.log('  Extracting …');
    extractZip(zipPath, extractDir);
    const found = findPluginDirs(extractDir, 5);
    if (found.length === 0) throw new Error('No Finch extension found inside the zip archive.');
    const lockSource = isUrl
      ? { type: 'zip', url: src }
      : { type: 'zip', localPath: resolve(expandHome(src)) };
    for (const dir of found) installExtensionDir(dir, dest, lockSource);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function cmdAdd(src, opts) {
  const dest = targetDir(opts);

  // --- zip URL (e.g. https://github.com/.../archive/main.zip) ---
  if (isZipUrl(src)) {
    await installFromZip(src, dest, true);
    return;
  }

  // --- local path ---
  if (isLocalSource(src)) {
    const abs = resolve(expandHome(src));
    if (!existsSync(abs)) throw new Error(`path not found: ${abs}`);

    // Local zip file
    if (isZipFile(src)) {
      await installFromZip(src, dest, false);
      return;
    }

    // Local directory
    const direct = pluginInfo(abs);
    if (direct && !direct.error) {
      installExtensionDir(abs, dest, { type: 'local', localPath: abs });
      return;
    }
    const found = findPluginDirs(abs, 3);
    if (found.length === 0) throw new Error('No Finch extension found in the given directory.');
    for (const dir of found) installExtensionDir(dir, dest, { type: 'local', localPath: dir });
    return;
  }

  // --- npm package ---
  const tmp = join(tmpdir(), `finch-ext-${randomUUID()}`);
  try {
    npmInstallToTemp(src, tmp);
    const found = findPluginDirs(join(tmp, 'node_modules'), 5);
    if (found.length === 0) throw new Error('No package with package.json#finch found in the npm package.');
    // Prefer the top-level package matching the requested spec when possible.
    const first = found[0];
    installExtensionDir(first, dest, { type: 'npm', package: src });
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function listInstalled(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: e.name, path: join(dir, e.name), info: pluginInfo(join(dir, e.name)) }))
    .filter((x) => x.info && !x.info.error);
}

function cmdList(opts) {
  const dir = targetDir(opts);
  const plugins = listInstalled(dir);
  if (plugins.length === 0) {
    console.log(`No extensions installed in ${dir}`);
    return;
  }
  for (const p of plugins) {
    console.log(`${p.info.id}\t${p.info.version}\t${p.info.displayName}\t${p.path}`);
  }
}

function cmdRemove(id, opts) {
  const dir = targetDir(opts);
  const target = join(dir, id);
  if (!existsSync(target)) throw new Error(`extension not found: ${id}`);
  rmSync(target, { recursive: true, force: true });
  deleteRecord(dir, id);
  setEnabled(id, false);
  console.log(`✓ Removed ${id}`);
}

function normalizePluginState(raw) {
  const plugins = {};
  if (raw?.plugins && typeof raw.plugins === 'object') {
    for (const [id, record] of Object.entries(raw.plugins)) {
      if (!record || typeof record !== 'object') continue;
      plugins[id] = { ...record, enabled: record.enabled === true };
    }
  }
  if (Array.isArray(raw?.enabled)) {
    for (const id of raw.enabled) {
      if (typeof id === 'string') plugins[id] = { ...(plugins[id] ?? {}), enabled: true };
    }
  }
  return plugins;
}

function setEnabled(id, enabled) {
  const path = pluginsStatePath();
  const plugins = normalizePluginState(readJson(path, {}));
  plugins[id] = { ...(plugins[id] ?? {}), enabled };
  const enabledIds = Object.entries(plugins)
    .filter(([, record]) => record.enabled)
    .map(([extensionId]) => extensionId)
    .sort();
  writeJson(path, { enabled: enabledIds, plugins });
}

function cmdEnable(id, enabled) {
  setEnabled(id, enabled);
  console.log(`✓ ${enabled ? 'Enabled' : 'Disabled'} ${id}`);
  if (enabled) {
    console.log('  Note: CLI enable does not grant fine-grained permissions yet. Review extension permissions in Finch when available.');
  }
}

function cmdWhere() {
  console.log(`Personal: ${personalPluginsDir()}`);
  console.log(`Project:  ${projectPluginsDir()}`);
  console.log(`Global:   ${globalPluginsDir()}`);
  console.log(`State:    ${pluginsStatePath()}`);
}

/** Collect JS/MJS/TS source files under a plugin dir (excludes node_modules/.git). */
function collectSourceFiles(root, maxDepth = 4) {
  const files = [];
  function visit(dir, depth) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.cache') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) visit(full, depth - 1);
      } else if (/\.(mjs|cjs|js|ts)$/.test(e.name)) {
        files.push(full);
      }
    }
  }
  visit(root, maxDepth);
  return files;
}

/**
 * Static lint of an extension's source for patterns that won't work or break the
 * sandboxing contract. Returns arrays of warning strings.
 */
function lintExtensionSource(root) {
  const warnings = [];
  const files = collectSourceFiles(root);
  for (const file of files) {
    let text = '';
    try { text = readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = file.slice(root.length + 1);

    // Runtime `import ... from 'finch'` fails — `finch` is a types-only module.
    if (/^\s*import\s+(?!type\b)[^;]*\bfrom\s+['"]finch['"]/m.test(text)) {
      warnings.push(`${rel}: 用了运行时 import from 'finch'；应为 \`import type * as finch from 'finch'\`（finch 仅提供类型，运行时通过 activate(ctx) 注入）。`);
    }
    // Legacy API surface that no longer exists.
    if (/\bFinchPluginAPI\b/.test(text)) {
      warnings.push(`${rel}: 引用了已移除的 FinchPluginAPI；请改用 activate(ctx) + ctx.*。`);
    }
    // Importing Electron or Finch internals breaks the host isolation boundary.
    if (/\bfrom\s+['"]electron['"]/.test(text) || /require\(\s*['"]electron['"]\s*\)/.test(text)) {
      warnings.push(`${rel}: 直接 import 'electron'；插件运行在隔离 host 中，无法访问 Electron API。`);
    }
    if (/from\s+['"][^'"]*\/src\/(main|renderer|shared)\//.test(text)) {
      warnings.push(`${rel}: 引用了 Finch 内部源码（src/main|renderer|shared）；只能通过 ctx.* 使用能力。`);
    }
  }
  return warnings;
}

function cmdDoctor(src = '.') {
  const abs = resolve(expandHome(src));
  const info = pluginInfo(abs);
  if (!info) throw new Error('Not a Finch extension package (missing package.json#finch).');
  if (info.error) throw new Error(info.error);
  console.log(`✓ Finch extension: ${info.displayName}`);
  console.log(`  id:      ${info.id}`);
  console.log(`  version: ${info.version}`);
  console.log(`  main:    ${info.main}`);

  const pkg = readPackageJson(abs);
  const manifest = pkg?.finch ?? {};
  // Surface recommended manifest metadata that's missing (non-fatal).
  const recommended = ['name', 'description', 'extensionType'];
  const missing = recommended.filter((k) => manifest[k] == null);
  if (missing.length) console.log(`  hint: manifest 建议补充字段: ${missing.join(', ')}`);
  if (manifest.permissions) {
    const p = manifest.permissions;
    const decl = [
      p.filesystem && p.filesystem !== 'none' ? `filesystem=${p.filesystem}` : null,
      p.network ? 'network' : null,
      p.shell ? 'shell' : null,
    ].filter(Boolean);
    if (decl.length) console.log(`  permissions: ${decl.join(', ')}（启用时会向用户展示）`);
  }

  const warnings = lintExtensionSource(abs);
  if (warnings.length === 0) {
    console.log('✓ No issues found.');
    return;
  }
  console.log(`\n⚠ ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w}`);
}

async function cmdUpdate(id, opts) {
  const dir = targetDir(opts);
  const target = join(dir, id);
  if (!existsSync(target)) throw new Error(`extension not found: ${id}`);
  const source = readLock(dir)[id];
  if (!source) throw new Error(`no install record for "${id}"; reinstall it with \`add\` to enable updates.`);

  if (source.type === 'local') {
    const localPath = source.localPath ? expandHome(source.localPath) : '';
    if (!localPath || !existsSync(localPath)) {
      throw new Error(`local source no longer exists: ${source.localPath ?? '(unknown)'}`);
    }
    const info = pluginInfo(localPath);
    if (!info || info.error) throw new Error(info?.error ?? `not a Finch extension: ${localPath}`);
    cpSync(localPath, target, { recursive: true, force: true, dereference: false });
    recordInstall(dir, id, source);
    console.log(`✓ Updated "${info.displayName}" (${id}) from local path`);
    return;
  }

  // zip source: re-download / re-extract from the recorded URL or local path.
  if (source.type === 'zip') {
    if (source.url) {
      await installFromZip(source.url, dir, true);
    } else if (source.localPath) {
      await installFromZip(source.localPath, dir, false);
    } else {
      throw new Error(`zip install record for "${id}" has no url or localPath; reinstall with \`add\`.`);
    }
    return;
  }

  // npm source: reinstall the latest published version.
  const spec = source.package ?? id;
  const tmp = join(tmpdir(), `finch-ext-${randomUUID()}`);
  try {
    npmInstallToTemp(spec, tmp);
    const found = findPluginDirs(join(tmp, 'node_modules'), 5).filter((d) => pluginInfo(d)?.id === id);
    const fresh = found[0] ?? findPluginDirs(join(tmp, 'node_modules'), 5)[0];
    if (!fresh) throw new Error('No matching Finch extension found in npm package.');
    const info = pluginInfo(fresh);
    rmSync(target, { recursive: true, force: true });
    cpSync(fresh, target, { recursive: true, force: true, dereference: false });
    recordInstall(dir, id, source);
    console.log(`✓ Updated "${info.displayName}" (${id}) → v${info.version}`);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const cmd = args.shift();
  const opts = { global: false, cwd: undefined };
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--global' || a === '-g') opts.global = true;
    else if (a === '--cwd') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        opts.cwd = next;
        i += 1;
      } else {
        opts.cwd = '';
      }
    } else rest.push(a);
  }
  return { cmd, rest, opts };
}

function help() {
  console.log(`npx @finch.app/extensions\n\nUsage:\n  add <npm-package|local-path|url.zip> [--global|--cwd [path]]\n  update <id> [--global|--cwd [path]]\n  list [--global|--cwd [path]]\n  remove <id> [--global|--cwd [path]]\n  enable <id>\n  disable <id>\n  where\n  doctor [path]\n\nInstall locations:\n  default     workspace.json#finchHomeDir/.finch/extensions/\n  --cwd      process.cwd()/.finch/extensions/\n  --cwd path path/.finch/extensions/\n  --global   ~/.finch/extensions/\n`);
}

(async () => {
  try {
    const { cmd, rest, opts } = parseArgs(process.argv.slice(2));
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
    if (cmd === 'add') {
      if (!rest[0]) throw new Error('missing source');
      await cmdAdd(rest[0], opts);
      return;
    }
    if (cmd === 'update' || cmd === 'up') {
      if (!rest[0]) throw new Error('missing plugin id');
      await cmdUpdate(rest[0], opts);
      return;
    }
    if (cmd === 'list' || cmd === 'ls') return cmdList(opts);
    if (cmd === 'remove' || cmd === 'rm') {
      if (!rest[0]) throw new Error('missing plugin id');
      return cmdRemove(rest[0], opts);
    }
    if (cmd === 'enable') {
      if (!rest[0]) throw new Error('missing plugin id');
      return cmdEnable(rest[0], true);
    }
    if (cmd === 'disable') {
      if (!rest[0]) throw new Error('missing plugin id');
      return cmdEnable(rest[0], false);
    }
    if (cmd === 'where') return cmdWhere();
    if (cmd === 'doctor') return cmdDoctor(rest[0] ?? '.');
    throw new Error(`unknown command: ${cmd}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
})();
