import type * as finch from 'finch';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type RepoFile = {
  path: string; basename: string; dirname: string; status: string; staged: boolean; add: number; del: number;
};
type GraphCommit = {
  hash: string; parents: string[]; shortHash: string; subject: string; author: string; date: string;
};
type Repo = {
  path: string; name: string; branch: string; dirty: boolean; ahead: number; behind: number;
  staged: number; unstaged: number; untracked: number; files: RepoFile[]; graph: GraphCommit[];
};

// AppPanel is available in the current Finch runtime; API package v0.2.x lacks its type declaration.
type RuntimePanel = {
  postMessage(message: unknown): Promise<void>;
  updateToolbarItem(id: string, item: { label?: string; icon?: string }): Promise<void>;
  onDidReceiveMessage(listener: (message: unknown) => unknown): finch.Disposable;
};
type RuntimePanelUi = {
  onDidOpenPanel(listener: (panel: RuntimePanel) => unknown): finch.Disposable;
  openFilePreview(path: string): Promise<void>;
};
function panelUi(ctx: finch.MiniToolContext): RuntimePanelUi {
  return ctx.ui as unknown as RuntimePanelUi;
}

async function runGit(cwd: string, args: string[], timeout = 15_000, trimOutput = true): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout, maxBuffer: 10 * 1024 * 1024 });
  return trimOutput ? stdout.trim() : stdout;
}

async function isRepository(path: string): Promise<boolean> {
  try { return (await runGit(path, ['rev-parse', '--is-inside-work-tree'])) === 'true'; } catch { return false; }
}

function parseStatus(output: string): RepoFile[] {
  const files: RepoFile[] = [];
  const records = output.split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const index = record[0] ?? ' ';
    const worktree = record[1] ?? ' ';
    const path = record.slice(3);
    // In porcelain -z rename/copy records, the next NUL item is the old path.
    if (index === 'R' || index === 'C') i += 1;
    files.push({
      path, basename: basename(path), dirname: dirname(path) === '.' ? '' : dirname(path),
      status: index === '?' ? '?' : (index !== ' ' ? index : worktree),
      staged: index !== ' ' && index !== '?', add: 0, del: 0,
    });
  }
  return files;
}

function parseGraph(output: string): GraphCommit[] {
  return output.split('\x1e').filter(Boolean).map((record) => {
    // `format:` inserts a newline between records; remove it before matching hashes to parents.
    const [hash = '', parents = '', shortHash = '', subject = '', author = '', date = ''] = record.trimStart().split('\x1f');
    return { hash, parents: parents ? parents.split(' ') : [], shortHash, subject, author, date };
  }).filter((commit) => Boolean(commit.hash));
}

async function inspectRepo(path: string): Promise<Repo> {
  const [branch, statusRaw, upstream, graph] = await Promise.all([
    runGit(path, ['branch', '--show-current']).catch(() => 'HEAD'),
    // Porcelain records begin with meaningful spaces; never trim this output.
    runGit(path, ['status', '--porcelain=v1', '-z'], 15_000, false).catch(() => ''),
    runGit(path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => ''),
    runGit(path, ['log', '--topo-order', '--date=short', '--pretty=format:%H%x1f%P%x1f%h%x1f%s%x1f%an%x1f%ad%x1e', '-n', '120'], 15_000, false).catch(() => ''),
  ]);
  const files = parseStatus(statusRaw);
  const stats = await runGit(path, ['diff', '--numstat', 'HEAD']).catch(() => '');
  for (const line of stats.split('\n').filter(Boolean)) {
    const [add, del, file] = line.split('\t');
    const item = files.find((entry) => entry.path === file);
    if (item) { item.add = Number(add) || 0; item.del = Number(del) || 0; }
  }
  let ahead = 0; let behind = 0;
  if (upstream) {
    const counts = await runGit(path, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).catch(() => '0\t0');
    [ahead, behind] = counts.split('\t').map((value) => Number(value) || 0);
  }
  return {
    path, name: basename(path), branch: branch || 'HEAD', dirty: files.length > 0, ahead, behind,
    staged: files.filter((file) => file.staged).length,
    unstaged: files.filter((file) => !file.staged && file.status !== '?').length,
    untracked: files.filter((file) => file.status === '?').length,
    files, graph: parseGraph(graph),
  };
}

async function discoverRepos(cwd: string): Promise<Repo[]> {
  if (!await isRepository(cwd)) return [];
  const root = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  const paths = [root];
  const submodules = await runGit(root, ['config', '--file', '.gitmodules', '--get-regexp', 'path']).catch(() => '');
  for (const line of submodules.split('\n').filter(Boolean)) {
    const submodulePath = line.replace(/^\S+\s+/, '').trim();
    const absolute = resolve(root, submodulePath);
    if (existsSync(absolute) && await isRepository(absolute)) paths.push(absolute);
  }
  return Promise.all(paths.map(inspectRepo));
}

function toolbarTitle(path: string | undefined): string {
  if (!path) return 'Source Control';
  const home = homedir();
  const fromHome = relative(home, path);
  if (!fromHome) return '~';
  if (!fromHome.startsWith('..') && !isAbsolute(fromHome)) return `~/${fromHome.replace(/\\/g, '/')}`;
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 6 ? `…/${parts.slice(-6).join('/')}` : normalized;
}

function allowedRepo(repos: Repo[], repoPath: unknown): string | undefined {
  if (typeof repoPath !== 'string') return undefined;
  return repos.find((repo) => repo.path === repoPath)?.path;
}

function allowedFile(repoPath: string, filePath: unknown): string | undefined {
  if (typeof filePath !== 'string') return undefined;
  const absolute = resolve(repoPath, filePath);
  return relative(repoPath, absolute).startsWith('..') ? undefined : absolute;
}

export function activateScmPanel(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(panelUi(ctx).onDidOpenPanel((panel) => {
    const assistantInfo = ctx.app.getInfo();
    let cwd = '';
    let repos: Repo[] = [];
    const refresh = async (force = true) => {
      // Polling only checks whether the active Space changed; unchanged workspaces never repaint.
      const nextCwd = ctx.workspace.directoryPath ?? ctx.workspace.projectPath ?? cwd;
      const workspaceChanged = nextCwd !== cwd;
      if (!nextCwd || (!force && !workspaceChanged)) return;
      cwd = nextCwd;
      await panel.postMessage({ type: 'loading', loading: true });
      try {
        repos = await discoverRepos(cwd);
        await panel.updateToolbarItem('scm-title', {
          label: toolbarTitle(repos[0]?.path),
          icon: 'ext:git-branch/git-branch',
        });
        await panel.postMessage({ type: 'status', repos });
      } finally {
        await panel.postMessage({ type: 'loading', loading: false });
      }
    };
    const toast = async (title: string, variant: 'success' | 'error' | 'info' = 'success') => {
      await panel.postMessage({ type: 'toast', title, variant, position: 'TC' });
    };
    ctx.subscriptions.push(panel.onDidReceiveMessage(async (raw) => {
      const message = raw as Record<string, unknown>;
      try {
        if (message.type === 'init') {
          cwd = typeof message.cwd === 'string' ? message.cwd : '';
          const { assistantName } = await assistantInfo;
          await panel.postMessage({ type: 'config', assistantName });
          await refresh();
          return;
        }
        if (message.type === 'refresh') { await refresh(); return; }
        if (message.type === 'syncWorkspace') { await refresh(false); return; }
        const repoPath = allowedRepo(repos, message.repoPath);
        if (!repoPath) return;
        if (message.type === 'stage') await runGit(repoPath, ['add', '--', String(message.filePath)]);
        if (message.type === 'unstage') await runGit(repoPath, ['restore', '--staged', '--', String(message.filePath)]);
        if (message.type === 'stageAll') await runGit(repoPath, ['add', '-A']);
        if (message.type === 'unstageAll') await runGit(repoPath, ['restore', '--staged', '.']);
        if (message.type === 'pull') { await runGit(repoPath, ['pull', '--ff-only'], 60_000); await toast('Pulled latest changes'); }
        if (message.type === 'push') { await runGit(repoPath, ['push'], 60_000); await toast('Pushed to remote'); }
        if (message.type === 'fetch') { await runGit(repoPath, ['fetch', '--prune'], 60_000); await toast('Fetched remote updates'); }
        if (message.type === 'commit') {
          const text = typeof message.message === 'string' ? message.message.trim() : '';
          if (!text) throw new Error('Commit message is required');
          await runGit(repoPath, ['commit', '-m', text]);
          await toast('Committed changes');
        }
        if (message.type === 'discard') {
          const file = allowedFile(repoPath, message.filePath);
          if (!file) throw new Error('Invalid file path');
          if (message.status === '?') await runGit(repoPath, ['clean', '-f', '--', String(message.filePath)]);
          else await runGit(repoPath, ['restore', '--source=HEAD', '--staged', '--worktree', '--', String(message.filePath)]);
          await toast('Discarded changes');
        }
        if (message.type === 'openFile') {
          const file = allowedFile(repoPath, message.filePath);
          if (file && existsSync(file)) await panelUi(ctx).openFilePreview(realpathSync(file));
          return;
        }
        await refresh();
      } catch (error) {
        await toast(error instanceof Error ? error.message : 'Git operation failed', 'error');
        await refresh();
      }
    }));
  }));
}
