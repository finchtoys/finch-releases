import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLI_PACKAGE, resolveCli } from './cli-path.js';

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/;
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${CLI_PACKAGE}/latest`;

export type CliVersionStatus =
  | { state: 'checking' }
  | { state: 'missing' }
  | { state: 'current'; installed: string }
  | { state: 'outdated'; installed: string; latest: string }
  | { state: 'error'; message: string };

/** Read the installed CLI version by running `agently-cli --version`. Returns undefined if the CLI is missing. */
export async function getInstalledVersion(): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(resolveCli(), ['--version'], {
      timeout: 10_000,
      windowsHide: true,
    });
    const match = VERSION_PATTERN.exec(stdout || stderr || '');
    return match?.[1];
  } catch (error) {
    const code = (error as { code?: string | number } | undefined)?.code;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Look up the latest published version of the CLI package on the npm registry. */
export async function getLatestVersion(): Promise<string | undefined> {
  const response = await fetch(NPM_REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const data = (await response.json()) as { version?: string };
  return data.version;
}

/** Compare two dotted-numeric semver strings. Returns >0 if `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(/[-+]/)[0].split('.').map(Number);
  const partsB = b.split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Check installed vs. latest CLI version. Never throws — errors are folded into the returned status. */
export async function checkCliVersion(): Promise<CliVersionStatus> {
  let installed: string | undefined;
  try {
    installed = await getInstalledVersion();
  } catch (error) {
    return { state: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  if (!installed) return { state: 'missing' };

  try {
    const latest = await getLatestVersion();
    if (latest && compareVersions(latest, installed) > 0) return { state: 'outdated', installed, latest };
    return { state: 'current', installed };
  } catch {
    // Registry lookup failed (offline, rate limited, etc.) — still report the installed version.
    return { state: 'current', installed };
  }
}

/** Install or upgrade the CLI to the latest version via `npm install -g`. */
export async function updateCli(): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['install', '-g', CLI_PACKAGE], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, output: (stdout || stderr || '').trim() };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    return { ok: false, output: String(detail.stderr || detail.stdout || detail.message || error).trim() };
  }
}
