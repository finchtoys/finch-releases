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

/** Scan root (3 levels deep) for directories containing SKILL.md. */
function scanForSkills(root) {
  const found = [];
  const seen = new Set();
  function tryDir(dir) {
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (existsSync(join(dir, "SKILL.md"))) found.push(dir);
  }
  tryDir(root);
  let top = [];
  try { top = readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const e of top) {
    if (!e.isDirectory()) continue;
    const child = join(root, e.name);
    tryDir(child);
    try {
      for (const sub of readdirSync(child, { withFileTypes: true })) {
        if (sub.isDirectory()) tryDir(join(child, sub.name));
      }
    } catch { /* ignore */ }
  }
  return found;
}

function listInstalledSkills(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => ({ dir: e.name, name: readSkillName(join(dir, e.name)) ?? e.name }));
}

// ── Source parser ─────────────────────────────────────────────────────────────

function parseSource(src) {
  if (src.startsWith("./") || src.startsWith("../") || src.startsWith("/") || src.startsWith("~")) {
    return { type: "local", path: src };
  }
  if (src.startsWith("git@") || src.startsWith("git://")) {
    return { type: "git", url: src };
  }
  // GitHub tree URL: https://github.com/owner/repo/tree/branch/path
  const treeGH = src.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (treeGH) {
    return { type: "git-subpath", url: `https://github.com/${treeGH[1]}`, branch: treeGH[2], subpath: treeGH[3].replace(/\/$/, "") };
  }
  // GitLab tree URL: https://gitlab.com/org/repo/-/tree/branch/path
  const treeGL = src.match(/^https?:\/\/gitlab\.com\/([^/]+\/[^/]+?)\/-\/tree\/([^/]+)\/(.+)$/);
  if (treeGL) {
    return { type: "git-subpath", url: `https://gitlab.com/${treeGL[1]}`, branch: treeGL[2], subpath: treeGL[3].replace(/\/$/, "") };
  }
  // Full GitHub / GitLab repo URL
  if (/^https?:\/\/(github|gitlab)\.com\/[^/]+\/[^/]+?(\.git)?\/?$/.test(src)) {
    return { type: "git", url: src.replace(/\.git\/?$/, "") };
  }
  if (src.startsWith("http://") || src.startsWith("https://")) {
    return { type: "git", url: src };
  }
  // GitHub shorthand: owner/repo
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(src)) {
    return { type: "git", url: `https://github.com/${src}` };
  }
  return { type: "local", path: src };
}

// ── Git helpers ───────────────────────────────────────────────────────────────

/**
 * Look for an executable on PATH (via `which`/`where`), falling back to a
 * handful of common install locations that don't always make it onto the
 * PATH inherited by a GUI-launched app (Homebrew, Xcode Command Line Tools,
 * Windows installer). Returns the resolved path, or null if not found.
 */
function findExecutable(name) {
  const finder = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(finder, [name], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" });
  if (found.status === 0) {
    const first = found.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) return first;
  }
  const candidateDirs = process.platform === "win32"
    ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd")]
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  const exeName = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of candidateDirs) {
    const candidate = join(dir, exeName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const GIT_INSTALL_HINT = process.platform === "darwin"
  ? 'Install Git by running "xcode-select --install", or download it from https://git-scm.com/downloads.'
  : "Install Git from https://git-scm.com/downloads, then try again.";

function gitClone(url, dest, { branch, depth = 1 } = {}) {
  const gitPath = findExecutable("git");
  if (!gitPath) {
    console.error(`  No "git" executable found on this machine. ${GIT_INSTALL_HINT}`);
    return false;
  }
  const args = ["clone", `--depth=${depth}`];
  if (branch) args.push("--branch", branch);
  args.push(url, dest);
  const r = spawnSync(gitPath, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
  if (r.error) {
    console.error(`  Failed to run git (${gitPath}): ${r.error.message}`);
    return false;
  }
  if (r.status !== 0) {
    console.error(`  git clone failed:\n  ${(r.stderr || r.stdout || `exit code ${r.status}`).trim()}`);
    return false;
  }
  return true;
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

function installAll(skillDirs, destRoot, lockSource) {
  let count = 0;
  for (const dir of skillDirs) {
    // For multi-install, subpath is per-skill
    const src = lockSource ? { ...lockSource, subpath: relative(lockSource._cloneRoot ?? "", dir) } : undefined;
    if (installSkillDir(dir, destRoot, { lockSource: src })) count++;
  }
  return count;
}

// ── Command: add ─────────────────────────────────────────────────────────────

async function cmdAdd(src, { opts, skillFilter }) {
  const parsed = parseSource(src);
  const dest = targetDir(opts);
  const tmp = join(tmpdir(), `finch-skill-${randomUUID()}`);

  try {
    // ── Local ──────────────────────────────────────────────────────────────
    if (parsed.type === "local") {
      const abs = resolve(parsed.path.replace(/^~/, homedir()));
      if (!existsSync(abs)) { console.error(`Error: path not found: ${abs}`); process.exit(1); }

      if (existsSync(join(abs, "SKILL.md"))) {
        installSkillDir(abs, dest, { lockSource: { type: "local", localPath: abs } });
        console.log("\nTip: Open Finch → Toolcase to see your new skill.");
        return;
      }
      const found = scanForSkills(abs);
      if (found.length === 0) { console.error("No SKILL.md found in the given directory."); process.exit(1); }
      for (const p of found) installSkillDir(p, dest, { lockSource: { type: "local", localPath: p } });
      console.log("\nTip: Open Finch → Toolcase to see your new skills.");
      return;
    }

    // ── git-subpath (tree URL) ─────────────────────────────────────────────
    if (parsed.type === "git-subpath") {
      console.log(`Cloning ${parsed.url} (branch: ${parsed.branch})…`);
      if (!gitClone(parsed.url, tmp, { branch: parsed.branch })) process.exit(1);

      const subAbs = join(tmp, parsed.subpath);
      if (!existsSync(subAbs)) { console.error(`  Path "${parsed.subpath}" not found in repo.`); process.exit(1); }

      const lockBase = { type: "git-subpath", url: parsed.url, branch: parsed.branch };

      if (existsSync(join(subAbs, "SKILL.md"))) {
        installSkillDir(subAbs, dest, { lockSource: { ...lockBase, subpath: parsed.subpath } });
        console.log("\nTip: Open Finch → Toolcase to see your new skill.");
        return;
      }
      const found = scanForSkills(subAbs);
      if (found.length === 0) { console.error(`No SKILL.md found under "${parsed.subpath}".`); process.exit(1); }
      for (const p of found) {
        installSkillDir(p, dest, { lockSource: { ...lockBase, subpath: join(parsed.subpath, basename(p)) } });
      }
      console.log("\nTip: Open Finch → Toolcase to see your new skills.");
      return;
    }

    // ── git (repo root) ────────────────────────────────────────────────────
    console.log(`Cloning ${parsed.url}…`);
    if (!gitClone(parsed.url, tmp)) process.exit(1);

    const found = scanForSkills(tmp);
    if (found.length === 0) { console.error("No skills (SKILL.md) found in this repository."); process.exit(1); }

    if (skillFilter) {
      const match = found.find((p) => {
        const dir = basename(p); const name = readSkillName(p) ?? dir;
        return dir === skillFilter || name === skillFilter;
      });
      if (!match) {
        console.error(`Skill "${skillFilter}" not found. Available:`);
        for (const p of found) console.error(`  • ${readSkillName(p) ?? basename(p)}`);
        process.exit(1);
      }
      const subpath = relative(tmp, match);
      installSkillDir(match, dest, { lockSource: { type: "git-subpath", url: parsed.url, subpath } });
      console.log("\nTip: Open Finch → Toolcase to see your new skill.");
      return;
    }

    if (found.length === 1) {
      const subpath = relative(tmp, found[0]);
      installSkillDir(found[0], dest, { lockSource: { type: "git-subpath", url: parsed.url, subpath } });
      console.log("\nTip: Open Finch → Toolcase to see your new skill.");
      return;
    }

    console.log(`\nFound ${found.length} skill(s) — installing all:\n`);
    for (const p of found) {
      const subpath = relative(tmp, p);
      installSkillDir(p, dest, { lockSource: { type: "git-subpath", url: parsed.url, subpath } });
    }
    console.log("\nTip: Open Finch → Toolcase to see your new skills.");

  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Command: update ───────────────────────────────────────────────────────────

/** Re-install a skill from its recorded lock entry. Returns true on success. */
async function reinstallFromLock(dirName, entry, destRoot) {
  const tmp = join(tmpdir(), `finch-skill-${randomUUID()}`);
  const name = readSkillName(join(destRoot, dirName)) ?? dirName;

  try {
    if (entry.type === "local") {
      const abs = entry.localPath;
      if (!existsSync(join(abs, "SKILL.md"))) {
        console.error(`  ✗ "${name}": local path no longer exists (${abs})`);
        return false;
      }
      installSkillDir(abs, destRoot, { lockSource: entry, verb: "Updated" });
      return true;
    }

    // git or git-subpath — both stored as git-subpath now
    const { url, branch, subpath } = entry;
    console.log(`  Cloning ${url}${branch ? ` (${branch})` : ""}…`);
    if (!gitClone(url, tmp, { branch })) return false;

    const skillAbs = subpath ? join(tmp, subpath) : null;
    if (skillAbs && existsSync(join(skillAbs, "SKILL.md"))) {
      installSkillDir(skillAbs, destRoot, { lockSource: entry, verb: "Updated" });
      return true;
    }

    // Subpath might have moved — scan and match by dirName
    const found = scanForSkills(tmp);
    const match = found.find((p) => basename(p) === dirName);
    if (!match) {
      console.error(`  ✗ "${name}": skill directory "${dirName}" not found in repo anymore.`);
      return false;
    }
    installSkillDir(match, destRoot, { lockSource: { ...entry, subpath: relative(tmp, match) }, verb: "Updated" });
    return true;

  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
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
      ? (src.type === "local" ? `local: ${src.localPath}` : src.url)
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
  add owner/repo                                  GitHub shorthand
  add https://github.com/owner/repo               Full repo URL
  add https://github.com/owner/repo/tree/main/skills/my-skill
  add https://gitlab.com/org/repo                 GitLab URL
  add git@github.com:owner/repo.git               SSH URL
  add ./my-local-skill                            Local path

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
