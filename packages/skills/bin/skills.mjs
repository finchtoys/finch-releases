#!/usr/bin/env node
/**
 * @finch.app/skills — CLI shim that installs Finch skills to the correct location.
 *
 * Zero npm dependencies — only Node built-ins.
 */

import {
  existsSync, mkdirSync, readdirSync, cpSync, rmSync,
  readFileSync, writeFileSync,
} from "node:fs";
import { join, resolve, basename, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

// ── Install directories ───────────────────────────────────────────────────────

function finchRuntimeHome() {
  return process.env.FINCH_RUNTIME_HOME ?? join(homedir(), ".finch");
}

function expandHomePath(path) {
  return path.replace(/^~(?=\/|$)/, homedir());
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return fallback; }
}

function configuredAgentHome() {
  const state = readJson(join(finchRuntimeHome(), "workspace.json"), {});
  const configured = typeof state.finchHomeDir === "string" && state.finchHomeDir.trim()
    ? state.finchHomeDir.trim()
    : join(homedir(), "finchnest");
  return resolve(expandHomePath(configured));
}

function globalSkillsDir() {
  return join(homedir(), ".finch", "skills");
}

function personalSkillsDir() {
  return join(configuredAgentHome(), ".finch", "skills");
}

function projectSkillsDir(cwd = process.cwd()) {
  return join(resolve(expandHomePath(cwd)), ".finch", "skills");
}

function targetDir(opts) {
  if (opts.global) return globalSkillsDir();
  if (opts.cwd !== undefined) return projectSkillsDir(opts.cwd || process.cwd());
  return personalSkillsDir();
}

// ── Lock file ─────────────────────────────────────────────────────────────────
//
// Stored at <skillsDir>/.skills-lock.json
// Records the install source for each skill so `update` can re-fetch it.
//
// Entry shape:
//   { type, url?, branch?, subpath?, localPath?, installedAt }

const LOCK_FILE = ".skills-lock.json";

function lockPath(skillsDir) { return join(skillsDir, LOCK_FILE); }

function readLock(skillsDir) {
  try { return JSON.parse(readFileSync(lockPath(skillsDir), "utf-8")); } catch { return {}; }
}

function writeLock(skillsDir, data) {
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(lockPath(skillsDir), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function recordInstall(skillsDir, dirName, source) {
  const lock = readLock(skillsDir);
  lock[dirName] = { ...source, installedAt: new Date().toISOString() };
  writeLock(skillsDir, lock);
}

function deleteRecord(skillsDir, dirName) {
  const lock = readLock(skillsDir);
  delete lock[dirName];
  writeLock(skillsDir, lock);
}

// ── SKILL.md helpers ──────────────────────────────────────────────────────────

function readSkillName(skillDir) {
  const md = join(skillDir, "SKILL.md");
  if (!existsSync(md)) return null;
  try {
    const content = readFileSync(md, "utf-8");
    const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (m) {
      const line = m[1].split("\n").find((l) => l.startsWith("name:"));
      if (line) return line.slice("name:".length).trim().replace(/^['"]|['"]$/g, "");
    }
  } catch { /* ignore */ }
  return basename(skillDir);
}

/** Scan root recursively for directories containing SKILL.md. */
function scanForSkills(root, maxDepth = 5) {
  const found = [];
  const seen = new Set();
  function visit(dir, depth) {
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (existsSync(join(dir, "SKILL.md"))) {
      found.push(dir);
      return;
    }
    if (depth <= 0) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".cache") continue;
      visit(join(dir, e.name), depth - 1);
    }
  }
  visit(root, maxDepth);
  return found;
}

function listInstalledSkills(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => ({ dir: e.name, name: readSkillName(join(dir, e.name)) ?? e.name }));
}

// ── Source parser / archives ─────────────────────────────────────────────────

function isLocalSource(src) {
  return src.startsWith("./") || src.startsWith("../") || src.startsWith("/") || src.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(src);
}
function isZipUrl(src) { return /^https?:\/\/.+\.zip(\?.*)?$/i.test(src); }
function isTgzUrl(src) { return /^https?:\/\/.+\.(?:tgz|tar\.gz)(\?.*)?$/i.test(src); }
function isZipFile(src) { return src.toLowerCase().endsWith(".zip"); }
function isTgzFile(src) {
  const lower = src.toLowerCase();
  return lower.endsWith(".tgz") || lower.endsWith(".tar.gz");
}
function stripGitSuffix(value) { return value.replace(/\.git\/?$/, "").replace(/\/+$/, ""); }
function repoName(repo) { return repo.split("/").pop()?.replace(/\.git$/, "") ?? "repo"; }

function officialSkillDownloadUrl(repo) {
  const normalized = stripGitSuffix(repo);
  return `https://community.finchwork.app/download/skill/${normalized}`;
}

function githubArchiveUrl(repo, branch) {
  return branch
    ? `https://codeload.github.com/${repo}/zip/refs/heads/${branch}`
    : `https://codeload.github.com/${repo}/zip/HEAD`;
}

function gitlabArchiveUrl(repo, branch) {
  const name = repoName(repo);
  return branch
    ? `https://gitlab.com/${repo}/-/archive/${branch}/${name}-${branch}.zip`
    : `https://gitlab.com/${repo}/-/archive/HEAD/${name}-HEAD.zip`;
}

function parseSource(src) {
  if (isLocalSource(src)) return { type: "local", path: src };
  if (isZipUrl(src)) return { type: "archive", archive: "zip", url: src };
  if (isTgzUrl(src)) return { type: "archive", archive: "tgz", url: src };

  // GitHub tree URL: https://github.com/owner/repo/tree/branch/path
  const treeGH = src.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (treeGH) {
    return { type: "archive", archive: "zip", url: githubArchiveUrl(stripGitSuffix(treeGH[1]), treeGH[2]), subpath: treeGH[3].replace(/\/$/, "") };
  }
  // GitLab tree URL: https://gitlab.com/org/repo/-/tree/branch/path
  const treeGL = src.match(/^https?:\/\/gitlab\.com\/([^/]+\/[^/]+?)\/-\/tree\/([^/]+)\/(.+)$/);
  if (treeGL) {
    return { type: "archive", archive: "zip", url: gitlabArchiveUrl(stripGitSuffix(treeGL[1]), treeGL[2]), subpath: treeGL[3].replace(/\/$/, "") };
  }
  // Full GitHub / GitLab repo URL: download archive instead of requiring git.
  const repoGH = src.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (repoGH) return { type: "archive", archive: "zip", url: githubArchiveUrl(stripGitSuffix(repoGH[1])) };
  const repoGL = src.match(/^https?:\/\/gitlab\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (repoGL) return { type: "archive", archive: "zip", url: gitlabArchiveUrl(stripGitSuffix(repoGL[1])) };

  if (src.startsWith("git@") || src.startsWith("git://")) {
    throw new Error("SSH/git protocol sources require Git and are no longer supported by this installer. Use an https GitHub/GitLab URL or a .zip/.tgz archive URL instead.");
  }
  if (src.startsWith("http://") || src.startsWith("https://")) {
    throw new Error("Unsupported URL. Use a GitHub/GitLab repository URL, a /tree/... URL, or a direct .zip/.tgz archive URL.");
  }
  // Finch community shorthand: owner/repo. Use the official Cloudflare download proxy by default.
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(src)) {
    return { type: "archive", archive: "zip", url: officialSkillDownloadUrl(src) };
  }
  return { type: "local", path: src };
}

function createCliError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  err.detail = detail;
  return err;
}

function classifyDownloadError(url, statusOrError, detail) {
  const raw = `${statusOrError ?? ""}\n${detail ?? ""}`;
  const isGithub = /(^|\.)github\.com|codeload\.github\.com/i.test(url);
  if (/\b429\b|Too Many Requests/i.test(raw)) {
    return createCliError(
      "DOWNLOAD_RATE_LIMITED",
      isGithub
        ? "GitHub 下载暂时被限流了，请稍后重试；如果反复失败，建议使用打包好的 ZIP/TGZ 下载源。"
        : "下载源暂时限流了，请稍后重试。",
      `HTTP 429 while downloading ${url}`,
    );
  }
  if (/timeout|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ENOTFOUND|ECONNRESET|network/i.test(raw)) {
    return createCliError(
      "DOWNLOAD_NETWORK_ERROR",
      "下载失败，请检查网络或代理设置后重试。",
      `Download failed for ${url}: ${raw.trim()}`,
    );
  }
  return createCliError(
    "DOWNLOAD_FAILED",
    "下载失败，请稍后重试或换用 ZIP/TGZ 下载源。",
    `Download failed for ${url}: ${raw.trim()}`,
  );
}

function downloadWithSystemTool(url, destPath, fetchError) {
  const curlExe = process.platform === "win32" ? "curl.exe" : "curl";
  const curl = spawnSync(curlExe, ["-fL", "--retry", "2", "--connect-timeout", "20", "-o", destPath, url], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (curl.status === 0 && !curl.error) return;
  if (process.platform === "win32") {
    const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Invoke-WebRequest -Uri $args[0] -OutFile $args[1]", url, destPath], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (ps.status === 0 && !ps.error) return;
    throw classifyDownloadError(url, fetchError?.message ?? fetchError, `${curl.stderr || curl.stdout || curl.error?.message || "curl failed"}\n${ps.stderr || ps.stdout || ps.error?.message || "powershell failed"}`);
  }
  throw classifyDownloadError(url, fetchError?.message ?? fetchError, curl.stderr || curl.stdout || curl.error?.message || "curl failed");
}

async function downloadFile(url, destPath) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw classifyDownloadError(url, `${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(destPath, buf);
  } catch (err) {
    if (err?.code === "DOWNLOAD_RATE_LIMITED") throw err;
    downloadWithSystemTool(url, destPath, err);
  }
}

function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", zipPath, destDir], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
    if (r.status === 0 && !r.error) return;
    const tar = spawnSync("tar.exe", ["-xf", zipPath, "-C", destDir], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
    if (tar.status !== 0 || tar.error) throw new Error(`zip extract failed:\n${r.stderr || tar.stderr || r.stdout || tar.stdout || tar.error?.message || "unknown error"}`);
    return;
  }
  const r = spawnSync("unzip", ["-q", "-o", zipPath, "-d", destDir], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
  if (r.error) throw new Error(`No "unzip" command found on this machine: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`unzip failed:\n${r.stderr || r.stdout || `exit code ${r.status}`}`);
}

function extractTgz(tgzPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const tarExe = process.platform === "win32" ? "tar.exe" : "tar";
  const r = spawnSync(tarExe, ["-xzf", tgzPath, "-C", destDir], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
  if (r.error) throw new Error(`No "tar" command found on this machine: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`tar extract failed:\n${r.stderr || r.stdout || `exit code ${r.status}`}`);
}

// ── Install core ──────────────────────────────────────────────────────────────

/**
 * Copy a skill directory into destRoot and optionally record its source in the lock.
 * Returns the installed dirName, or null on failure.
 */
function installSkillDir(srcAbs, destRoot, { lockSource, verb = "Added" } = {}) {
  if (!existsSync(join(srcAbs, "SKILL.md"))) {
    console.error(`  Error: no SKILL.md in ${srcAbs}`);
    return null;
  }
  const dirName = basename(srcAbs);
  mkdirSync(destRoot, { recursive: true });
  cpSync(srcAbs, join(destRoot, dirName), { recursive: true, force: true });
  const name = readSkillName(srcAbs) ?? dirName;
  console.log(`✓ ${verb} "${name}" → ${join(destRoot, dirName)}`);
  if (lockSource) recordInstall(destRoot, dirName, lockSource);
  return dirName;
}

function archiveSubpathRoot(extractDir, subpath) {
  if (!subpath) return extractDir;
  const direct = join(extractDir, subpath);
  if (existsSync(direct)) return direct;
  let entries = [];
  try { entries = readdirSync(extractDir, { withFileTypes: true }); } catch { return direct; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(extractDir, entry.name, subpath);
    if (existsSync(candidate)) return candidate;
  }
  return direct;
}

async function extractArchiveSource(source, extractDir) {
  const archivePath = join(extractDir, source.archive === "tgz" ? "source.tgz" : "source.zip");
  const outDir = join(extractDir, "out");
  mkdirSync(extractDir, { recursive: true });
  if (source.url) {
    console.log(`Downloading ${source.url} …`);
    await downloadFile(source.url, archivePath);
  } else if (source.localPath) {
    if (!existsSync(source.localPath)) throw new Error(`file not found: ${source.localPath}`);
    cpSync(source.localPath, archivePath);
  } else {
    throw new Error("archive source missing url/localPath");
  }
  console.log("Extracting …");
  if (source.archive === "tgz") extractTgz(archivePath, outDir);
  else extractZip(archivePath, outDir);
  return outDir;
}

function installFoundSkills(found, dest, lockBase, skillFilter, extractRoot, verb = "Added") {
  if (found.length === 0) throw new Error("No SKILL.md found in the archive.");
  let selected = found;
  if (skillFilter) {
    const match = found.find((p) => {
      const dir = basename(p);
      const name = readSkillName(p) ?? dir;
      return dir === skillFilter || name === skillFilter;
    });
    if (!match) {
      console.error(`Skill "${skillFilter}" not found. Available:`);
      for (const p of found) console.error(`  • ${readSkillName(p) ?? basename(p)}`);
      process.exit(1);
    }
    selected = [match];
  } else if (found.length > 1) {
    console.log(`\nFound ${found.length} skill(s) — installing all:\n`);
  }

  for (const p of selected) {
    installSkillDir(p, dest, {
      verb,
      lockSource: { ...lockBase, subpath: relative(extractRoot, p) },
    });
  }
}

async function installArchive(source, dest, { skillFilter, verb = "Added", dirNameHint } = {}) {
  const tmp = join(tmpdir(), `finch-skill-${randomUUID()}`);
  try {
    const extractRoot = await extractArchiveSource(source, tmp);
    const root = archiveSubpathRoot(extractRoot, source.subpath);
    if (!existsSync(root)) throw new Error(`Path "${source.subpath}" not found in archive.`);
    const found = existsSync(join(root, "SKILL.md")) ? [root] : scanForSkills(root);
    if (dirNameHint && !skillFilter) {
      const match = found.find((p) => basename(p) === dirNameHint) ?? found[0];
      installSkillDir(match, dest, { verb, lockSource: { ...source, subpath: relative(extractRoot, match) } });
      return;
    }
    installFoundSkills(found, dest, source, skillFilter, extractRoot, verb);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Command: add ─────────────────────────────────────────────────────────────

async function cmdAdd(src, { opts, skillFilter }) {
  const parsed = parseSource(src);
  const dest = targetDir(opts);

  if (parsed.type === "local") {
    const abs = resolve(expandHomePath(parsed.path));
    if (!existsSync(abs)) { console.error(`Error: path not found: ${abs}`); process.exit(1); }

    if (isZipFile(abs) || isTgzFile(abs)) {
      await installArchive({ type: "archive", archive: isTgzFile(abs) ? "tgz" : "zip", localPath: abs }, dest, { skillFilter });
      console.log("\nTip: Open Finch → Toolcase to see your new skill(s).");
      return;
    }

    if (existsSync(join(abs, "SKILL.md"))) {
      installSkillDir(abs, dest, { lockSource: { type: "local", localPath: abs } });
      console.log("\nTip: Open Finch → Toolcase to see your new skill.");
      return;
    }
    const found = scanForSkills(abs);
    if (found.length === 0) { console.error("No SKILL.md found in the given directory."); process.exit(1); }
    installFoundSkills(found, dest, { type: "local", localPath: abs }, skillFilter, abs);
    console.log("\nTip: Open Finch → Toolcase to see your new skills.");
    return;
  }

  await installArchive(parsed, dest, { skillFilter });
  console.log("\nTip: Open Finch → Toolcase to see your new skill(s).");
}

// ── Command: update ───────────────────────────────────────────────────────────

function normalizeLockSource(entry) {
  if (entry.type === "archive") return entry;
  if (entry.type === "zip") return { type: "archive", archive: "zip", url: entry.url, localPath: entry.localPath, subpath: entry.subpath };
  if (entry.type === "tgz") return { type: "archive", archive: "tgz", url: entry.url, localPath: entry.localPath, subpath: entry.subpath };
  if (entry.type === "git-subpath" || entry.type === "git") {
    const parsed = parseSource(entry.url);
    if (parsed.type !== "archive") throw new Error(`cannot convert legacy git source: ${entry.url}`);
    return { ...parsed, subpath: entry.subpath ?? parsed.subpath };
  }
  return entry;
}

/** Re-install a skill from its recorded lock entry. Returns true on success. */
async function reinstallFromLock(dirName, entry, destRoot) {
  const name = readSkillName(join(destRoot, dirName)) ?? dirName;

  try {
    const source = normalizeLockSource(entry);
    if (source.type === "local") {
      const base = source.localPath;
      const abs = source.subpath ? join(base, source.subpath) : base;
      if (!abs || !existsSync(join(abs, "SKILL.md"))) {
        console.error(`  ✗ "${name}": local path no longer exists (${abs})`);
        return false;
      }
      installSkillDir(abs, destRoot, { lockSource: source, verb: "Updated" });
      return true;
    }

    if (source.type === "archive") {
      await installArchive(source, destRoot, { verb: "Updated", dirNameHint: dirName });
      return true;
    }

    console.error(`  ✗ "${name}": unsupported install source (${source.type ?? "unknown"})`);
    return false;
  } catch (err) {
    console.error(`  ✗ "${name}": ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Ask user a question on stdin; returns the trimmed answer. */
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function cmdUpdate(names, opts) {
  const personalDir = personalSkillsDir();
  const projectDir = projectSkillsDir(opts.cwd || process.cwd());
  const globalDir  = globalSkillsDir();
  const requestedScope = opts.global ? "global" : opts.cwd !== undefined ? "project" : "personal";

  // ── Named update (specific skills) ────────────────────────────────────────
  if (names.length > 0) {
    const dir = targetDir(opts);
    const lock = readLock(dir);
    let anyFailed = false;

    for (const name of names) {
      // Match by name or dir slug
      const installed = listInstalledSkills(dir);
      const skill = installed.find((s) => s.name === name || s.dir === name);
      if (!skill) {
        console.error(`✗ Skill "${name}" not found in ${dir}`);
        anyFailed = true; continue;
      }
      const entry = lock[skill.dir];
      if (!entry) {
        console.error(`✗ "${skill.name}": no install source recorded (was it installed manually?)`);
        anyFailed = true; continue;
      }
      console.log(`\nUpdating "${skill.name}"…`);
      const ok = await reinstallFromLock(skill.dir, entry, dir);
      if (!ok) anyFailed = true;
    }

    if (anyFailed) process.exit(1);
    console.log("\nTip: Open Finch → Toolcase to reload skills.");
    return;
  }

  // ── No names: determine scope ──────────────────────────────────────────────
  const personalLock = readLock(personalDir);
  const projectLock = readLock(projectDir);
  const globalLock  = readLock(globalDir);

  const personalUpdatable = listInstalledSkills(personalDir).filter((s) => personalLock[s.dir]);
  const projectUpdatable = listInstalledSkills(projectDir).filter((s) => projectLock[s.dir]);
  const globalUpdatable  = listInstalledSkills(globalDir).filter((s) => globalLock[s.dir]);

  const entries = [
    { scope: "personal", dir: personalDir, lock: personalLock, list: personalUpdatable },
    { scope: "project", dir: projectDir, lock: projectLock, list: projectUpdatable },
    { scope: "global", dir: globalDir, lock: globalLock, list: globalUpdatable },
  ].filter((entry) => entry.list.length > 0);

  if (entries.length === 0) {
    console.log("Nothing to update — no tracked skills found.");
    console.log("(Skills installed without @finch.app/skills can't be auto-updated.)");
    return;
  }

  let selected = entries.filter((entry) => entry.scope === requestedScope);
  if (selected.length === 0 && requestedScope === "personal" && entries.length === 1) selected = entries;
  if (selected.length === 0 && requestedScope !== "personal") {
    console.log(`Nothing to update in ${requestedScope} skills.`);
    return;
  }
  if (requestedScope === "personal" && entries.length > 1) {
    console.log("\nSkills available to update:");
    entries.forEach((entry, index) => {
      console.log(`  [${index + 1}] ${entry.scope} (${entry.dir}):\n    ${entry.list.map((s) => s.name).join(", ")}`);
    });
    console.log(`  [${entries.length + 1}] All`);
    const answer = await prompt(`Choose scope [1-${entries.length + 1}, q] > `);
    if (answer === "q" || answer === "Q") { console.log("Cancelled."); return; }
    if (answer === String(entries.length + 1)) selected = entries;
    else selected = [entries[Math.max(0, Math.min(entries.length - 1, Number(answer || "1") - 1))]];
  }

  let anyFailed = false;

  for (const entry of selected) {
    const { scope, dir, lock, list } = entry;
    console.log(`\nUpdating ${scope} skills in ${dir}…`);

    for (const skill of list) {
      console.log(`\n  › ${skill.name}`);
      const ok = await reinstallFromLock(skill.dir, lock[skill.dir], dir);
      if (!ok) anyFailed = true;
    }
  }

  if (anyFailed) process.exit(1);
  console.log("\nAll done. Open Finch → Toolcase to reload skills.");
}

// ── Command: list ─────────────────────────────────────────────────────────────

function cmdList(opts) {
  const dir = targetDir(opts);
  const skills = listInstalledSkills(dir);
  const lock = readLock(dir);
  if (skills.length === 0) { console.log(`No skills installed in ${dir}`); return; }
  console.log(`Skills in ${dir}:\n`);
  for (const s of skills) {
    const src = lock[s.dir];
    const srcHint = src
      ? (src.type === "local"
        ? `local: ${src.localPath}${src.subpath ? `/${src.subpath}` : ""}`
        : src.url ?? src.localPath ?? `${src.type}:${src.subpath ?? ""}`)
      : "no source recorded";
    console.log(`  • ${s.name !== s.dir ? `${s.name} (${s.dir})` : s.name}  — ${srcHint}`);
  }
}

// ── Command: remove ───────────────────────────────────────────────────────────

function cmdRemove(names, opts) {
  const dir = targetDir(opts);
  const scope = opts.global ? "global" : opts.cwd !== undefined ? "cwd" : "personal";
  const skills = listInstalledSkills(dir);
  let anyFailed = false;
  for (const name of names) {
    const match = skills.find((s) => s.name === name || s.dir === name);
    if (!match) { console.error(`✗ "${name}" not found in ${dir}`); anyFailed = true; continue; }
    rmSync(join(dir, match.dir), { recursive: true, force: true });
    deleteRecord(dir, match.dir);
    console.log(`✓ Removed "${match.name}"`);
  }
  if (anyFailed) {
    console.error(`\nRun "list --${scope}" to see installed skills.`);
    process.exit(1);
  }
}

// ── Command: where ────────────────────────────────────────────────────────────

function cmdWhere() {
  console.log("Personal skills:", personalSkillsDir());
  console.log("Project  skills:", projectSkillsDir());
  console.log("Global   skills:", globalSkillsDir());
}

// ── Usage ─────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
npx @finch.app/skills — Install Finch skills from anywhere

Usage:
  add owner/repo                                  GitHub shorthand (downloads archive)
  add https://github.com/owner/repo               Full repo URL (downloads archive)
  add https://github.com/owner/repo/tree/main/skills/my-skill
  add https://gitlab.com/org/repo                 GitLab URL (downloads archive)
  add https://example.com/skills.zip              ZIP archive URL
  add https://example.com/skills.tgz              TGZ archive URL
  add ./my-local-skill                            Local path
  add ./skills.zip                                Local ZIP/TGZ archive

  update                              Update all (interactive scope)
  update my-skill                    Update one skill
  update skill-a skill-b             Update several skills

  list [--global|--cwd [path]]              List installed skills + sources
  remove <name...> [--global|--cwd [path]]  Remove one or more skills
  rm my-skill                        Alias for remove
  where                              Show install directories

Flags:
  --global        Operate on ~/.finch/skills/
  --cwd [path]    Operate on process.cwd()/.finch/skills/ or path/.finch/skills/
  --skill <name>  Pick one skill by name when a repo contains several

Default location:
  workspace.json#finchHomeDir/.finch/skills/
`.trim());
}

// ── Entry point ───────────────────────────────────────────────────────────────

function printCliError(err) {
  const payload = {
    code: err?.code || "SKILL_INSTALL_FAILED",
    message: err instanceof Error ? err.message : String(err),
    detail: err?.detail,
  };
  console.error(`FINCH_CLI_ERROR_JSON:${JSON.stringify(payload)}`);
  console.error(`Error: ${payload.message}`);
  if (payload.detail && process.env.FINCH_CLI_DEBUG === "1") console.error(payload.detail);
}

async function main() {
  const args = process.argv.slice(2);
  const opts = { global: false, cwd: undefined };
  let skillFlag = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--global") opts.global = true;
    else if (a === "--cwd") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        opts.cwd = next;
        i += 1;
      } else {
        opts.cwd = "";
      }
    } else if (a === "--skill") {
      skillFlag = args[i + 1] ?? null;
      i += 1;
    } else positional.push(a);
  }
  const [command, ...rest] = positional;

  switch (command) {
    case "add":
    case "install": {
      const src = rest[0];
      if (!src) { console.error("Error: missing <source>"); printUsage(); process.exit(1); }
      await cmdAdd(src, { opts, skillFilter: skillFlag });
      break;
    }
    case "update":
      await cmdUpdate(rest, opts);
      break;
    case "list":
      cmdList(opts);
      break;
    case "remove":
    case "rm": {
      if (rest.length === 0) { console.error("Error: missing <skill-name>"); printUsage(); process.exit(1); }
      cmdRemove(rest, opts);
      break;
    }
    case "where":
      cmdWhere();
      break;
    default:
      printUsage();
      if (command) process.exit(1);
  }
}

main().catch((err) => {
  printCliError(err);
  process.exit(1);
});
