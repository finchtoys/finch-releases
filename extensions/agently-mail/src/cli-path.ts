import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CLI_NAME = 'agently-cli';
export const CLI_PACKAGE = '@tencent-qqmail/agently-cli';

/**
 * Resolve the local `agently-cli` executable.
 * Checked in order: explicit env override, the Finch executable's own
 * directory, common global-install locations, then any nvm-managed
 * Node versions, finally falling back to bare `PATH` lookup.
 */
export function resolveCli(): string {
  const explicit = process.env.AGENTLY_CLI_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = [
    join(dirname(process.execPath), CLI_NAME),
    `/usr/local/bin/${CLI_NAME}`,
    `/opt/homebrew/bin/${CLI_NAME}`,
  ];
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
  try {
    for (const version of readdirSync(nvmRoot).sort().reverse()) {
      candidates.push(join(nvmRoot, version, 'bin', CLI_NAME));
    }
  } catch {
    // nvm is optional; fall back to PATH below.
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? CLI_NAME;
}

/**
 * Resolve the local `npm` executable. Finch mini tools run in a spawned
 * Node process whose `PATH` usually lacks Homebrew/nvm entries (no login
 * shell was sourced), so a bare `npm` lookup often fails with ENOENT even
 * though npm is installed. Search the same directory as the current Node
 * binary, common global-install locations, then nvm-managed versions,
 * before falling back to a bare `PATH` lookup.
 */
export function resolveNpm(): string {
  const explicit = process.env.AGENTLY_NPM_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = [
    join(dirname(process.execPath), 'npm'),
    '/usr/local/bin/npm',
    '/opt/homebrew/bin/npm',
  ];
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
  try {
    for (const version of readdirSync(nvmRoot).sort().reverse()) {
      candidates.push(join(nvmRoot, version, 'bin', 'npm'));
    }
  } catch {
    // nvm is optional; fall back to PATH below.
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? 'npm';
}

/** Extra PATH entries to append when spawning npm, so npm's own child processes
 * (e.g. node-gyp, install scripts) can find `node` even under a minimal PATH. */
export function extendedPathEnv(): string {
  const extras = [
    dirname(process.execPath),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  const current = process.env.PATH ?? '';
  const merged = [...extras, current].filter(Boolean).join(':');
  return merged;
}
