#!/usr/bin/env node
/**
 * @finch.app/minitools — install Finch extensions to the correct location.
 *
 * Zero npm dependencies. npm sources are installed by downloading the registry
 * dist.tarball (.tgz) directly, so third-party install scripts never run.
 */
import {
  existsSync, mkdirSync, readdirSync, cpSync, rmSync,
  readFileSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const LOCK_FILE = '.plugins-lock.json';
const SUPPORTED_MANIFEST_VERSION = 1;
const EXTENSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const KNOWN_EXTENSION_TYPES = new Set(['official', 'community', 'local']);
const LEGACY_NPM_PACKAGE_RENAMES = new Map([
  ['@finch.app/mcp-bridge', '@finch.app/mcp-client'],
]);

function normalizeInstallSource(source) {
  if (source?.type !== 'npm' || typeof source.package !== 'string') return source;
  const nextPackage = LEGACY_NPM_PACKAGE_RENAMES.get(source.package);
  return nextPackage ? { ...source, package: nextPackage } : source;
}

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
// Extensions only ever install to the personal (default) or global tier —
// there is intentionally no project/--cwd scope. (Skills still support a
// project tier via the separate @finch.app/skills CLI; that's unrelated.)
function targetDir(opts) {
  return opts.global ? globalPluginsDir() : personalPluginsDir();
}
function pluginsStatePath() {
  return join(finchRuntimeHome(), 'extensions.json');
}
function miniToolCacheDir() {
  return join(finchRuntimeHome(), 'cache', 'minitools');
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

function localizedValue(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return value.default ?? value['en-US'] ?? value['zh-CN'] ?? fallback;
  }
  return fallback;
}

function isLocalizedString(value) {
  if (value == null) return true;
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([locale, text]) => (
    typeof locale === 'string' && typeof text === 'string'
  ));
}

function validateStringField(value, field, diagnostics, { required = false, localized = false } = {}) {
  if (value == null) {
    if (required) diagnostics.fatal.push(`${field} 缺失`);
    return;
  }
  const ok = localized ? isLocalizedString(value) : typeof value === 'string';
  if (!ok) diagnostics.fatal.push(`${field} 必须是${localized ? '字符串或本地化字符串对象' : '字符串'}`);
}

function validateStringArray(value, field, diagnostics) {
  if (value == null) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    diagnostics.warning.push(`${field} 应为非空字符串数组`);
  }
}

function validateObject(value, field, diagnostics) {
  if (value == null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.warning.push(`${field} 应为对象`);
    return false;
  }
  return true;
}

function validateContributes(contributes, diagnostics) {
  if (contributes == null) return;
  if (!validateObject(contributes, 'finch.contributes', diagnostics)) return;

  if (contributes.tools != null && typeof contributes.tools !== 'boolean') {
    diagnostics.warning.push('finch.contributes.tools 应为 boolean');
  }
  if (contributes.skills != null && typeof contributes.skills !== 'boolean') {
    diagnostics.warning.push('finch.contributes.skills 应为 boolean');
  }
  if (contributes.composerActions != null) {
    if (!Array.isArray(contributes.composerActions)) {
      diagnostics.fatal.push('finch.contributes.composerActions 必须是数组');
    } else {
      for (const [index, action] of contributes.composerActions.entries()) {
        const prefix = `finch.contributes.composerActions[${index}]`;
        if (!action || typeof action !== 'object' || Array.isArray(action)) {
          diagnostics.fatal.push(`${prefix} 必须是对象`);
          continue;
        }
        if (typeof action.id !== 'string' || !action.id.trim()) {
          diagnostics.fatal.push(`${prefix}.id 缺失或不是字符串`);
        }
        validateStringField(action.icon, `${prefix}.icon`, diagnostics);
        validateStringField(action.tooltip, `${prefix}.tooltip`, diagnostics, { localized: true });
      }
    }
  }
  if (contributes.iconPacks != null) {
    if (!Array.isArray(contributes.iconPacks)) {
      diagnostics.fatal.push('finch.contributes.iconPacks 必须是数组');
    } else {
      for (const [index, pack] of contributes.iconPacks.entries()) {
        const prefix = `finch.contributes.iconPacks[${index}]`;
        if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
          diagnostics.fatal.push(`${prefix} 必须是对象`);
          continue;
        }
        if (typeof pack.id !== 'string' || !pack.id.trim()) diagnostics.fatal.push(`${prefix}.id 缺失或不是字符串`);
        validateStringField(pack.label, `${prefix}.label`, diagnostics, { localized: true });
        validateStringField(pack.description, `${prefix}.description`, diagnostics, { localized: true });
      }
    }
  }
  if (contributes.icons != null && validateObject(contributes.icons, 'finch.contributes.icons', diagnostics)) {
    for (const [iconId, icon] of Object.entries(contributes.icons)) {
      if (!icon || typeof icon !== 'object' || Array.isArray(icon)) {
        diagnostics.fatal.push(`finch.contributes.icons.${iconId} 必须是对象`);
        continue;
      }
      if (typeof icon.svg !== 'string' || !icon.svg.trim()) diagnostics.fatal.push(`finch.contributes.icons.${iconId}.svg 缺失或不是字符串`);
    }
  }
  if (contributes.mcpServers != null && !Array.isArray(contributes.mcpServers)) {
    diagnostics.fatal.push('finch.contributes.mcpServers 必须是数组');
  }
}

function validatePermissions(permissions, diagnostics) {
  if (permissions == null) return;
  if (!validateObject(permissions, 'finch.permissions', diagnostics)) return;
  if (permissions.filesystem != null && !['none', 'read', 'write'].includes(permissions.filesystem)) {
    diagnostics.warning.push('finch.permissions.filesystem 建议使用 none/read/write');
  }
  if (permissions.network != null && typeof permissions.network !== 'boolean') {
    diagnostics.warning.push('finch.permissions.network 应为 boolean');
  }
  if (permissions.shell != null && typeof permissions.shell !== 'boolean') {
    diagnostics.warning.push('finch.permissions.shell 应为 boolean');
  }
}

function validateCapabilitySpec(spec, field, diagnostics) {
  if (spec == null) return;
  if (!validateObject(spec, field, diagnostics)) return;
  validateStringArray(spec.capabilities, `${field}.capabilities`, diagnostics);
}

function validateMiniToolPackage(dir, { lintSource = false } = {}) {
  const diagnostics = { fatal: [], warning: [] };
  const pkg = readPackageJson(dir);
  if (!pkg) {
    diagnostics.fatal.push('缺少 package.json，或 package.json 不是合法 JSON');
    return { diagnostics, info: null };
  }

  const manifest = pkg.finch;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    diagnostics.fatal.push('缺少 package.json#finch，或 finch manifest 不是对象');
    return { diagnostics, info: null };
  }

  const id = String(manifest.id ?? pkg.name ?? '').trim();
  if (!id) {
    diagnostics.fatal.push('package.json#finch 缺少 id');
  } else if (!EXTENSION_ID_RE.test(id) || id === '.' || id === '..') {
    diagnostics.fatal.push(`package.json#finch.id 不合法: ${id}（只能使用字母、数字、点、下划线、短横线，且不能包含路径分隔符）`);
  }

  if (manifest.manifestVersion !== undefined && manifest.manifestVersion !== SUPPORTED_MANIFEST_VERSION) {
    diagnostics.fatal.push(`不支持的 manifestVersion: ${manifest.manifestVersion}（当前 Finch 支持 ${SUPPORTED_MANIFEST_VERSION}）`);
  }

  validateStringField(manifest.name, 'finch.name', diagnostics, { localized: true });
  validateStringField(manifest.displayName, 'finch.displayName', diagnostics, { localized: true });
  validateStringField(manifest.description, 'finch.description', diagnostics, { localized: true });
  validateStringField(manifest.systemPrompt, 'finch.systemPrompt', diagnostics, { localized: true });
  validateStringArray(manifest.categories, 'finch.categories', diagnostics);

  const extensionType = manifest.miniToolType ?? manifest.extensionType;
  if (extensionType != null && (typeof extensionType !== 'string' || !extensionType.trim())) {
    diagnostics.warning.push('finch.miniToolType/extensionType 应为字符串');
  } else if (typeof extensionType === 'string' && !KNOWN_EXTENSION_TYPES.has(extensionType)) {
    diagnostics.warning.push(`未知 extensionType: ${extensionType}（常见值为 official/community/local）`);
  }

  if (manifest.install != null && validateObject(manifest.install, 'finch.install', diagnostics)) {
    const scope = manifest.install.preferredScope;
    if (scope != null && scope !== 'global' && scope !== 'personal') {
      diagnostics.warning.push('finch.install.preferredScope 应为 global 或 personal');
    }
  }

  validatePermissions(manifest.permissions, diagnostics);
  validateCapabilitySpec(manifest.provides, 'finch.provides', diagnostics);
  validateCapabilitySpec(manifest.requires, 'finch.requires', diagnostics);
  validateContributes(manifest.contributes, diagnostics);

  const mainValue = manifest.main ?? pkg.main ?? 'dist/index.js';
  if (typeof mainValue !== 'string' || !mainValue.trim()) {
    diagnostics.fatal.push('入口 main 必须是非空字符串（finch.main 或 package.json#main）');
  }
  const main = typeof mainValue === 'string' && mainValue.trim() ? mainValue.trim() : 'dist/index.js';
  const entry = isAbsolute(main) ? main : join(dir, main);
  if (!existsSync(entry)) diagnostics.fatal.push(`入口文件不存在: ${main}（请先构建小工具）`);

  const recommended = [];
  if (manifest.name == null && manifest.displayName == null) recommended.push('name');
  if (manifest.description == null) recommended.push('description');
  if (manifest.miniToolType == null && manifest.extensionType == null) recommended.push('miniToolType');
  if (recommended.length) diagnostics.warning.push(`manifest 建议补充字段: ${recommended.join(', ')}`);

  if (lintSource) diagnostics.warning.push(...lintExtensionSource(dir));

  const nameField = manifest.name ?? manifest.displayName;
  const displayName = localizedValue(nameField, pkg.name ?? id).trim() || id;
  return {
    diagnostics,
    info: {
      id,
      name: pkg.name ?? id,
      version: pkg.version ?? '0.0.0',
      displayName,
      main,
    },
  };
}

function pluginInfo(dir) {
  const result = validateMiniToolPackage(dir);
  if (!result.info && result.diagnostics.fatal.length > 0) {
    const pkg = readPackageJson(dir);
    return pkg && Object.prototype.hasOwnProperty.call(pkg, 'finch')
      ? { error: result.diagnostics.fatal[0] }
      : null;
  }
  if (result.diagnostics.fatal.length > 0) return { error: result.diagnostics.fatal[0], id: result.info?.id };
  return result.info;
}

function findPluginDirs(root, maxDepth = 4) {
  const found = [];
  const invalid = [];
  const seen = new Set();
  function visit(dir, depth) {
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const info = pluginInfo(dir);
    if (info && !info.error) found.push(dir);
    else if (info?.error) invalid.push({ dir, error: info.error });
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
  found.invalid = invalid;
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
  console.log('  Installed only. Open Finch → Toolcase → Mini Tool to review permissions and enable.');
  return info.id;
}

function isLocalSource(src) {
  return src.startsWith('./') || src.startsWith('../') || src.startsWith('/') || src.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(src);
}
function isZipUrl(src) {
  return /^https?:\/\/.+\.zip(\?.*)?$/i.test(src);
}
function isZipFile(src) {
  return src.toLowerCase().endsWith('.zip');
}
function isTgzUrl(src) {
  return /^https?:\/\/.+\.(?:tgz|tar\.gz)(\?.*)?$/i.test(src);
}
function isTgzFile(src) {
  const lower = src.toLowerCase();
  return lower.endsWith('.tgz') || lower.endsWith('.tar.gz');
}
function expandHome(path) {
  return path.replace(/^~(?=\/|$)/, homedir());
}

/**
 * Download a URL to a local file path using Node's built-in fetch (Node 18+).
 * Falls back to curl/wget if fetch is unavailable.
 */
function downloadWithSystemTool(url, destPath, fetchError) {
  const curlExe = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const curl = spawnSync(curlExe, ['-fL', '--retry', '2', '--connect-timeout', '20', '-o', destPath, url], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  if (curl.status === 0 && !curl.error) return;
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Invoke-WebRequest -Uri $args[0] -OutFile $args[1]', url, destPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    if (ps.status === 0 && !ps.error) return;
    throw new Error(`Download failed: ${fetchError?.message ?? fetchError}\n${curl.stderr || curl.stdout || curl.error?.message || 'curl failed'}\n${ps.stderr || ps.stdout || ps.error?.message || 'powershell failed'}`);
  }
  throw new Error(`Download failed: ${fetchError?.message ?? fetchError}\n${curl.stderr || curl.stdout || curl.error?.message || 'curl failed'}`);
}

async function downloadFile(url, destPath) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(destPath, buf);
  } catch (err) {
    downloadWithSystemTool(url, destPath, err);
  }
}

function communityMiniToolFromUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'community.finchwork.app') return null;
  const parts = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts[0] !== 'download' || parts[1] !== 'minitool' || parts.length < 4) return null;
  const version = parts.at(-1);
  const packageName = parts.slice(2, -1).join('/');
  if (!packageName || !version || version === 'latest') return null;
  return { packageName, version };
}

function safeCacheSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function communityMiniToolCachePath(meta) {
  return join(miniToolCacheDir(), `${safeCacheSegment(meta.packageName)}-${safeCacheSegment(meta.version)}.tgz`);
}

async function downloadFileWithCache(url, destPath) {
  const communityMeta = communityMiniToolFromUrl(url);
  if (!communityMeta) {
    await downloadFile(url, destPath);
    return;
  }

  const cachePath = communityMiniToolCachePath(communityMeta);
  if (existsSync(cachePath)) {
    cpSync(cachePath, destPath);
    console.log(`  Using cached package ${communityMeta.packageName}@${communityMeta.version}`);
    return;
  }

  await downloadFile(url, destPath);
  mkdirSync(miniToolCacheDir(), { recursive: true });
  cpSync(destPath, cachePath);
  console.log(`  Cached package ${communityMeta.packageName}@${communityMeta.version}`);
}

/**
 * Extract a zip archive to destDir using the system `unzip` command (macOS / Linux built-in).
 */
function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', zipPath, destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    if (r.status === 0 && !r.error) return;
    const tar = spawnSync('tar.exe', ['-xf', zipPath, '-C', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    if (tar.status !== 0 || tar.error) {
      throw new Error(`zip extract failed:\n${r.stderr || tar.stderr || r.stdout || tar.stdout || tar.error?.message || 'unknown error'}`);
    }
    return;
  }
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
 * Extract a .tgz/.tar.gz archive using the system tar command. macOS/Linux ship
 * it by default; modern Windows includes bsdtar as tar.exe.
 */
function extractTgz(tgzPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const tarExe = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const r = spawnSync(tarExe, ['-xzf', tgzPath, '-C', destDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  if (r.error) {
    throw new Error(`No "tar" command found on this machine: ${r.error.message}`);
  }
  if (r.status !== 0) throw new Error(`tar extract failed:\n${r.stderr || r.stdout || `exit code ${r.status}`}`);
}

function parseNpmSpec(spec) {
  const trimmed = String(spec ?? '').trim();
  if (!trimmed) throw new Error('missing npm package name');
  if (trimmed.startsWith('@')) {
    const versionSep = trimmed.indexOf('@', 1);
    return versionSep > 0
      ? { name: trimmed.slice(0, versionSep), version: trimmed.slice(versionSep + 1) || 'latest' }
      : { name: trimmed, version: 'latest' };
  }
  const versionSep = trimmed.lastIndexOf('@');
  return versionSep > 0
    ? { name: trimmed.slice(0, versionSep), version: trimmed.slice(versionSep + 1) || 'latest' }
    : { name: trimmed, version: 'latest' };
}

let registryOverride = null;

function configuredRegistryUrl() {
  return (registryOverride || process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
}

function npmMetadataUrl(packageName, version) {
  return `${configuredRegistryUrl()}/${encodeURIComponent(packageName)}/${encodeURIComponent(version || 'latest')}`;
}

function officialMiniToolDownloadUrl(packageName, version) {
  return `https://community.finchwork.app/download/minitool/${packageName}/${encodeURIComponent(version)}`;
}

async function resolveNpmTarball(spec) {
  const { name, version } = parseNpmSpec(spec);
  if (version && version !== 'latest') {
    return {
      package: name,
      version,
      tarball: officialMiniToolDownloadUrl(name, version),
    };
  }

  const url = npmMetadataUrl(name, version);
  let meta;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    meta = await res.json();
  } catch (err) {
    throw new Error(`npm metadata fetch failed: ${err instanceof Error ? err.message : String(err)} — ${url}`);
  }
  const resolvedVersion = String(meta.version ?? version);
  const tarball = meta?.dist?.tarball;
  if (typeof tarball !== 'string' || !tarball) {
    throw new Error(`No dist.tarball found for ${name}@${version}`);
  }
  return {
    package: name,
    version: resolvedVersion,
    tarball: officialMiniToolDownloadUrl(name, resolvedVersion),
  };
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
      await downloadFileWithCache(src, zipPath);
    } else {
      // Local zip — copy to tmp so we have a consistent path
      const abs = resolve(expandHome(src));
      if (!existsSync(abs)) throw new Error(`file not found: ${abs}`);
      cpSync(abs, zipPath);
    }
    // console.log('  Extracting …');
    extractZip(zipPath, extractDir);
    const found = findPluginDirs(extractDir, 5);
    if (found.length === 0) {
      if (found.invalid?.length) throw new Error(`Invalid Finch extension inside the zip archive: ${found.invalid[0].error}`);
      throw new Error('No Finch extension found inside the zip archive.');
    }
    const lockSource = isUrl
      ? { type: 'zip', url: src }
      : { type: 'zip', localPath: resolve(expandHome(src)) };
    for (const dir of found) installExtensionDir(dir, dest, lockSource);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function installFromTgz(src, dest, { isUrl, lockSource }) {
  const tmp = join(tmpdir(), `finch-ext-${randomUUID()}`);
  const tgzPath = join(tmp, 'extension.tgz');
  const extractDir = join(tmp, 'extracted');
  mkdirSync(tmp, { recursive: true });
  try {
    if (isUrl) {
      console.log(`  Downloading ${src} …`);
      await downloadFileWithCache(src, tgzPath);
    } else {
      const abs = resolve(expandHome(src));
      if (!existsSync(abs)) throw new Error(`file not found: ${abs}`);
      cpSync(abs, tgzPath);
    }
    // console.log('  Extracting …');
    extractTgz(tgzPath, extractDir);
    const found = findPluginDirs(extractDir, 5);
    if (found.length === 0) {
      if (found.invalid?.length) throw new Error(`Invalid Finch extension inside the tgz archive: ${found.invalid[0].error}`);
      throw new Error('No Finch extension found inside the tgz archive.');
    }
    const source = lockSource ?? (isUrl
      ? { type: 'tgz', url: src }
      : { type: 'tgz', localPath: resolve(expandHome(src)) });
    for (const dir of found) installExtensionDir(dir, dest, source);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function cmdAdd(src, opts) {
  const dest = targetDir(opts);

  // --- archive URL (e.g. https://github.com/.../archive/main.zip or npm tarball .tgz) ---
  if (isZipUrl(src)) {
    await installFromZip(src, dest, true);
    return;
  }
  if (isTgzUrl(src)) {
    await installFromTgz(src, dest, { isUrl: true });
    return;
  }

  // --- local path ---
  if (isLocalSource(src)) {
    const abs = resolve(expandHome(src));
    if (!existsSync(abs)) throw new Error(`path not found: ${abs}`);

    // Local archive file
    if (isZipFile(src)) {
      await installFromZip(src, dest, false);
      return;
    }
    if (isTgzFile(src)) {
      await installFromTgz(src, dest, { isUrl: false });
      return;
    }

    // Local directory
    const direct = pluginInfo(abs);
    if (direct && !direct.error) {
      installExtensionDir(abs, dest, { type: 'local', localPath: abs });
      return;
    }
    const found = findPluginDirs(abs, 3);
    if (found.length === 0) {
      if (found.invalid?.length) throw new Error(`Invalid Finch extension in the given directory: ${found.invalid[0].error}`);
      throw new Error('No Finch extension found in the given directory.');
    }
    for (const dir of found) installExtensionDir(dir, dest, { type: 'local', localPath: dir });
    return;
  }

  // --- npm package: fetch registry metadata, download dist.tarball, then extract locally. ---
  const resolved = await resolveNpmTarball(src);
  await installFromTgz(resolved.tarball, dest, {
    isUrl: true,
    lockSource: { type: 'npm', package: resolved.package, version: resolved.version },
  });
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
  const pluginState = normalizePluginState(readJson(pluginsStatePath(), {}));
  for (const p of plugins) {
    const status = pluginState[p.info.id]?.enabled ? 'enabled' : 'disabled';
    console.log(`${p.info.id}\t${p.info.version}\t${status}\t${p.info.displayName}\t${p.path}`);
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
  const { diagnostics, info } = validateMiniToolPackage(abs, { lintSource: true });

  if (info) {
    console.log(`Finch mini tool: ${info.displayName}`);
    console.log(`  id:      ${info.id || '(missing)'}`);
    console.log(`  version: ${info.version}`);
    console.log(`  main:    ${info.main}`);
  } else {
    console.log(`Finch mini tool: ${abs}`);
  }

  const pkg = readPackageJson(abs);
  const manifest = pkg?.finch ?? {};
  if (manifest.permissions && typeof manifest.permissions === 'object') {
    const p = manifest.permissions;
    const decl = [
      p.filesystem && p.filesystem !== 'none' ? `filesystem=${p.filesystem}` : null,
      p.network ? 'network' : null,
      p.shell ? 'shell' : null,
    ].filter(Boolean);
    if (decl.length) console.log(`  permissions: ${decl.join(', ')}（启用时会向用户展示）`);
  }

  if (diagnostics.fatal.length > 0) {
    console.log(`\n✖ ${diagnostics.fatal.length} fatal issue(s):`);
    for (const issue of diagnostics.fatal) console.log(`  - ${issue}`);
  }
  if (diagnostics.warning.length > 0) {
    console.log(`\n⚠ ${diagnostics.warning.length} warning(s):`);
    for (const issue of diagnostics.warning) console.log(`  - ${issue}`);
  }
  if (diagnostics.fatal.length === 0 && diagnostics.warning.length === 0) {
    console.log('✓ No issues found.');
  }
  if (diagnostics.fatal.length > 0) {
    throw new Error('mini tool package validation failed');
  }
}

async function cmdUpdate(id, opts) {
  const dir = targetDir(opts);
  const target = join(dir, id);
  if (!existsSync(target)) throw new Error(`extension not found: ${id}`);
  let source = normalizeInstallSource(readLock(dir)[id]);
  if (!source) {
    // No install record — this happens for bundled first-party extensions that
    // were deployed by copying (e.g. the MCP bridge), not via `add`. Fall back to
    // the installed package.json's npm name so they can still be updated from the
    // registry. recordInstall below then writes a proper lock entry.
    const pkg = readPackageJson(target);
    const pkgName = typeof pkg?.name === 'string' ? pkg.name.trim() : '';
    if (pkgName) {
      source = normalizeInstallSource({ type: 'npm', package: pkgName });
    } else {
      throw new Error(`no install record for "${id}"; reinstall it with \`add\` to enable updates.`);
    }
  }

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

  // zip/tgz source: re-download / re-extract from the recorded URL or local path.
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
  if (source.type === 'tgz') {
    if (source.url) {
      await installFromTgz(source.url, dir, { isUrl: true, lockSource: source });
    } else if (source.localPath) {
      await installFromTgz(source.localPath, dir, { isUrl: false, lockSource: source });
    } else {
      throw new Error(`tgz install record for "${id}" has no url or localPath; reinstall with \`add\`.`);
    }
    return;
  }

  // npm source: reinstall the latest published version by downloading dist.tarball directly.
  const resolved = await resolveNpmTarball(source.package ?? id);
  await installFromTgz(resolved.tarball, dir, {
    isUrl: true,
    lockSource: { type: 'npm', package: resolved.package, version: resolved.version },
  });
}

function parseArgs(argv) {
  const args = [...argv];
  const cmd = args.shift();
  const opts = { global: false, registry: null };
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--global' || a === '-g') opts.global = true;
    else if (a === '--registry') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--registry requires a URL');
      opts.registry = value;
      i += 1;
    } else if (a === '--cwd') {
      // Removed: extensions no longer support project/--cwd scope. Consume any
      // following path argument so old invocations fail loudly instead of
      // silently being parsed as the install source.
      throw new Error('--cwd is no longer supported for extensions — install to the personal (default) or --global tier only.');
    } else rest.push(a);
  }
  return { cmd, rest, opts };
}

function help() {
  console.log(`npx @finch.app/minitools\n\nUsage:\n  add <npm-package|local-path|url.zip|url.tgz> [--global] [--registry <url>]\n  update <id> [--global] [--registry <url>]\n  list [--global]\n  remove <id> [--global]\n  enable <id>\n  disable <id>\n  where\n  doctor [path]\n\nInstall locations:\n  default     workspace.json#finchHomeDir/.finch/extensions/  (personal — default)\n  --global   ~/.finch/extensions/                              (global)\n\nRegistry:\n  --registry <url> overrides npm registry for npm package metadata/tarball downloads.\n  If omitted, npm_config_registry is used, then https://registry.npmjs.org.\n\nThere is no project/--cwd scope — extensions only install to personal or global.\n`);
}

(async () => {
  try {
    const { cmd, rest, opts } = parseArgs(process.argv.slice(2));
    registryOverride = opts.registry;
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
