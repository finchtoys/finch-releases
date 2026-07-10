import { execFile } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).ok;
}

export async function gitStatusSummary(cwd: string): Promise<{ changes: string[]; branch: string; remote: string | undefined }> {
  const status = await git(cwd, ['status', '--porcelain']);
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const remote = await git(cwd, ['remote', 'get-url', 'origin']);
  return {
    changes: status.stdout ? status.stdout.split('\n').filter(Boolean) : [],
    branch: branch.ok ? branch.stdout : '(none)',
    remote: remote.ok ? remote.stdout : undefined,
  };
}
