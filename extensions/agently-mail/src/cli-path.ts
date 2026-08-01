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
