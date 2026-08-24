import type * as finch from 'finch';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type RepoFile = {
  path: string; basename: string; dirname: string; status: string; staged: boolean; add: number; del: number;
  diffLeftPath?: string; diffRightPath?: string;
};
type GraphCommit = {
  hash: string; parents: string[]; shortHash: string; subject: string; author: string; date: string;
};
type Repo = {
  path: string; name: string; branch: string; dirty: boolean; ahead: number; behind: number;
  staged: number; unstaged: number; untracked: number; files: RepoFile[]; graph: GraphCommit[];
};

function repoSignature(repos: Repo[]): string {
  return JSON.stringify(repos.map((repo) => ({
    path: repo.path, branch: repo.branch, dirty: repo.dirty, ahead: repo.ahead, behind: repo.behind,
    staged: repo.staged, unstaged: repo.unstaged, untracked: repo.untracked,
    files: repo.files.map(({ path, status, staged, add, del }) => ({ path, status, staged, add, del })),
    graph: repo.graph.map(({ hash, parents, subject, author, date }) => ({ hash, parents, subject, author, date })),
  })));
}

// AppPanel is available in the current Finch runtime; API package v0.2.x lacks its type declaration.
type RuntimePanel = {
  readonly visible: boolean;
  postMessage(message: unknown): Promise<void>;
  updateToolbarItem(id: string, item: { label?: string; icon?: string }): Promise<void>;
  onDidReceiveMessage(listener: (message: unknown) => unknown): finch.Disposable;
  onDidChangeVisibility(listener: (visible: boolean) => unknown): finch.Disposable;
  onDidDispose(listener: () => unknown): finch.Disposable;
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
  await Promise.all(files.map(async (file) => {
    const absolute = resolve(path, file.path);
    const rightPath = existsSync(absolute) ? realpathSync(absolute) : await createDiffFile('worktree', file.path, '');
    const compareIndex = file.staged;
    file.diffLeftPath = await createDiffFile('base', file.path,
      file.status === '?' ? '' : await fileAtRevision(path, compareIndex ? 'HEAD' : '', file.path));
    file.diffRightPath = compareIndex
      ? await createDiffFile('index', file.path, await fileAtRevision(path, '', file.path))
      : rightPath;
  }));
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

async function createDiffFile(label: string, filePath: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'finch-git-diff-'));
  const output = join(directory, `${label}-${basename(filePath)}`);
  await writeFile(output, content, 'utf8');
  return output;
}

async function fileAtRevision(repoPath: string, revision: string, filePath: string): Promise<string> {
  return runGit(repoPath, ['show', `${revision}:${filePath}`], 15_000, false).catch(() => '');
}

export function activateScmPanel(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(panelUi(ctx).onDidOpenPanel((panel) => {
    let cwd = '';
    let scopeKey = '';
    let generation = 0;
    let repos: Repo[] = [];
    let unavailable = false;
    const active = () => !unavailable && panel.visible;
    const post = async (message: unknown): Promise<boolean> => {
      if (!active()) return false;
      try {
        await panel.postMessage(message);
        return true;
      } catch {
        // The Session may have dropped its viewer between the visibility check and send.
        unavailable = true;
        return false;
      }
    };
    const updateToolbar = async (label: string, icon: string): Promise<void> => {
      if (!active()) return;
      try {
        await panel.updateToolbarItem('scm-title', { label, icon });
      } catch {
        unavailable = true;
      }
    };
    const sendConfig = async () => {
      const { assistantName } = await ctx.app.getInfo();
      await post({ type: 'config', assistantName });
    };
    // Also push config immediately: an already-live Webview may not emit finch:env again
    // after the mini tool backend is reloaded.
    void sendConfig().catch(() => undefined);
    const setScope = async (message: Record<string, unknown>, useCurrentWorkspace = false): Promise<boolean> => {
      const webviewCwd = typeof message.cwd === 'string' ? message.cwd : '';
      // Session switches can retain a live Webview without replaying finch:env.
      // The backend workspace follows the active session and is authoritative for heartbeat refreshes.
      const activeCwd = ctx.workspace.directoryPath ?? ctx.workspace.projectPath ?? '';
      const nextCwd = useCurrentWorkspace && activeCwd ? activeCwd : webviewCwd;
      const nextScopeKey = typeof message.scopeKey === 'string' ? message.scopeKey : (scopeKey || nextCwd);
      if (nextScopeKey === scopeKey && nextCwd === cwd) return false;
      generation += 1;
      scopeKey = nextScopeKey;
      cwd = nextCwd;
      repos = [];
      await post({ type: 'status', repos: [], scopeKey });
      return true;
    };
    const refresh = async (showLoading = true) => {
      const requestGeneration = generation;
      const requestScope = scopeKey;
      const requestCwd = cwd;
      const previousSignature = repoSignature(repos);
      if (!active()) return;
      if (!requestCwd) {
        if (repos.length === 0) return;
        await updateToolbar('Source Control', 'ext:git-branch/git-branch');
        await post({ type: 'status', repos: [], scopeKey: requestScope, cwd: requestCwd });
        return;
      }
      if (showLoading) await post({ type: 'loading', loading: true, scopeKey: requestScope });
      try {
        const nextRepos = await discoverRepos(requestCwd);
        // A newer finch:env/init won while Git was running; never paint stale results.
        if (!active() || requestGeneration !== generation || requestScope !== scopeKey || requestCwd !== cwd) return;
        if (repoSignature(nextRepos) === previousSignature) return;
        repos = nextRepos;
        await updateToolbar(toolbarTitle(repos[0]?.path), 'ext:git-branch/git-branch');
        await post({ type: 'status', repos, scopeKey: requestScope, cwd: requestCwd });
      } finally {
        if (showLoading && active() && requestGeneration === generation && requestScope === scopeKey) {
          await post({ type: 'loading', loading: false, scopeKey: requestScope });
        }
      }
    };
    const toast = async (title: string, variant: 'success' | 'error' | 'info' = 'success') => {
      if (!active()) return;
      try {
        await ctx.ui.showToast({ title, variant, position: 'TC' });
      } catch {
        unavailable = true;
      }
    };
    ctx.subscriptions.push(panel.onDidChangeVisibility((visible) => {
      if (!visible) return;
      unavailable = false;
      void sendConfig().then(() => refresh()).catch(() => undefined);
    }));
    ctx.subscriptions.push(panel.onDidDispose(() => {
      unavailable = true;
      generation += 1;
      repos = [];
    }));
    ctx.subscriptions.push(panel.onDidReceiveMessage((raw) => {
      void (async () => {
      if (!active()) return;
      const message = raw as Record<string, unknown>;
      try {
        if (message.type === 'init') {
          await setScope(message);
          await sendConfig();
          await refresh();
          return;
        }
        if (message.type === 'refresh') {
          await setScope(message, true);
          await refresh(message.silent !== true);
          return;
        }
        if (message.type === 'syncWorkspace') {
          const changed = await setScope(message, true);
          await sendConfig();
          if (changed || repos.length === 0) await refresh();
          return;
        }
        const repoPath = allowedRepo(repos, message.repoPath);
        if (!repoPath) return;
        if (message.type === 'stage') { await runGit(repoPath, ['add', '--', String(message.filePath)]); await toast(ctx.i18n.t('git.scm.stage.success')); }
        if (message.type === 'unstage') { await runGit(repoPath, ['restore', '--staged', '--', String(message.filePath)]); await toast(ctx.i18n.t('git.scm.unstage.success')); }
        if (message.type === 'stageAll') { await runGit(repoPath, ['add', '-A']); await toast(ctx.i18n.t('git.scm.stageAll.success')); }
        if (message.type === 'unstageAll') { await runGit(repoPath, ['restore', '--staged', '.']); await toast(ctx.i18n.t('git.scm.unstageAll.success')); }
        if (message.type === 'pull') { await runGit(repoPath, ['pull', '--ff-only'], 60_000); await toast(ctx.i18n.t('git.scm.pull.success')); }
        if (message.type === 'push') { await runGit(repoPath, ['push'], 60_000); await toast(ctx.i18n.t('git.scm.push.success')); }
        if (message.type === 'fetch') { await runGit(repoPath, ['fetch', '--prune'], 60_000); await toast(ctx.i18n.t('git.scm.fetch.success')); }
        if (message.type === 'requestCommit') {
          const result = await ctx.ui.showModalDialog({
            title: ctx.i18n.t('git.scm.commit.title'),
            actions: [
              { id: 'cancel', label: ctx.i18n.t('git.scm.commit.cancel'), variant: 'secondary' },
              { id: 'commit', label: ctx.i18n.t('git.scm.commit.submit'), variant: 'primary' },
            ],
            fields: [{
              key: 'message', label: ctx.i18n.t('git.scm.commit.field'), type: 'textarea', required: true,
              placeholder: ctx.i18n.t('git.scm.commit.placeholder'),
            }],
          });
          if (result.action !== 'commit') return;
          const text = String(result.values?.message ?? '').trim();
          if (!text) return;
          // 提交由人类在自己的终端手动执行，扩展只生成命令，不再自动 git commit。
          const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          await ctx.ui.showModalDialog({
            title: ctx.i18n.t('git.scm.commit.manual.title'),
            description: ctx.i18n.t('git.scm.commit.manual.desc'),
            message: `\`git add -A\`\n\`git commit -m "${escaped}"\``,
            actions: [
              { id: 'ok', label: ctx.i18n.t('git.scm.commit.manual.ok'), variant: 'primary' },
            ],
          });
        }
        if (message.type === 'discard') {
          const file = allowedFile(repoPath, message.filePath);
          if (!file) throw new Error('Invalid file path');
          if (message.status === '?') await runGit(repoPath, ['clean', '-f', '--', String(message.filePath)]);
          else await runGit(repoPath, ['restore', '--source=HEAD', '--staged', '--worktree', '--', String(message.filePath)]);
          await toast(ctx.i18n.t('git.scm.discard.success'));
        }
        if (message.type === 'openFile') {
          const file = allowedFile(repoPath, message.filePath);
          if (file && existsSync(file)) await panelUi(ctx).openFilePreview(realpathSync(file));
          return;
        }
        if (message.type === 'prepareFileDiff') {
          const file = allowedFile(repoPath, message.filePath);
          const relativePath = file ? relative(repoPath, file).replace(/\\/g, '/') : '';
          const entry = repos.find((repo) => repo.path === repoPath)?.files.find((item) => item.path === relativePath);
          if (!file || !entry || !relativePath) throw new Error('Invalid file path');
          const rightPath = existsSync(file)
            ? realpathSync(file)
            : await createDiffFile('worktree', relativePath, '');
          const compareIndex = entry.staged;
          const leftPath = await createDiffFile('base', relativePath,
            entry.status === '?' ? '' : await fileAtRevision(repoPath, compareIndex ? 'HEAD' : '', relativePath));
          const resolvedRightPath = compareIndex
            ? await createDiffFile('index', relativePath, await fileAtRevision(repoPath, '', relativePath))
            : rightPath;
          await post({ type: 'fileDiff', leftPath, rightPath: resolvedRightPath });
          return;
        }
        await refresh();
      } catch (error) {
        await toast(error instanceof Error ? error.message : 'Git operation failed', 'error');
        if (active()) await refresh();
      }
      })().catch((error) => ctx.logger.error('SCM panel message failed', error));
    }));
  }));
}
