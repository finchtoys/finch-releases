/**
 * @finch.app/ext-git-branch v0.2.1
 *
 * Composer toolbar button for Git branch management:
 * - Branch switch with uncommitted-changes guard (ModalDialog)
 * - Change previews (worktree diff / ahead-behind)
 * - Submenu for all branches (hover to open, scrollable)
 * - Create branch via companion tool with form dialog
 * - External i18n
 */
import type * as finch from 'finch';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CURRENT_BRANCH_KEY = 'currentBranch';

// Tracks the most-recently-seen cwd so the background poller can use it.
let activeCwd: string | undefined;

function readIconSvg(name: string): string {
  return readFileSync(new URL(`../icons/${name}.svg`, import.meta.url), 'utf-8');
}

// ── Git helpers ──────────────────────────────────────────────────────────────

async function git(cwd: string, args: string[], timeout = 5000): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

function isGitRepo(cwd: string): boolean {
  return Boolean(cwd) && existsSync(join(cwd, '.git'));
}

/** Get ahead/behind commit counts between HEAD and another branch. */
async function getAheadBehind(
  cwd: string,
  branch: string,
): Promise<{ ahead: number; behind: number }> {
  try {
    const out = await git(cwd, [
      'rev-list', '--left-right', '--count',
      `HEAD...${branch}`,
    ]);
    const [ahead, behind] = out.split('\t').map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

/** Count all changed files (staged + unstaged + untracked) via `git status --porcelain`. */
async function getChangedFileCount(cwd: string): Promise<number> {
  try {
    const out = await git(cwd, ['status', '--porcelain']);
    return out ? out.split('\n').filter(Boolean).length : 0;
  } catch {
    return 0;
  }
}

function renderAheadBehindDesc(diff: { ahead: number; behind: number }): string {
  if (diff.ahead === 0 && diff.behind === 0) return '';
  const parts: string[] = [];
  if (diff.ahead > 0) parts.push(`↑${diff.ahead}`);
  if (diff.behind > 0) parts.push(`↓${diff.behind}`);
  return parts.join(' ');
}

function normalizeGitPath(path: string): string {
  return path
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"');
}

/**
 * Build a structured message for the ModalDialog showing uncommitted changes.
 * Format: warning line, blank, each file with +/- counts, blank, total.
 */
async function buildDiffMessage(cwd: string, i18n: finch.ExtensionI18n): Promise<string> {
  // Use one primary source of truth for tracked changes. `git diff --numstat HEAD`
  // covers staged + unstaged tracked files, avoiding mismatches/duplicates between
  // `status --porcelain` and `diff --numstat` path parsing.
  const numstat = await git(cwd, ['diff', '--numstat', 'HEAD', '--']).catch(() => '');
  const status = await git(cwd, ['status', '--porcelain']).catch(() => '');

  const lines: string[] = [];
  lines.push(i18n.t('git.branch.diff.title'));
  lines.push('');

  const seen = new Set<string>();
  let totalAdd = 0;
  let totalDel = 0;

  if (numstat) {
    for (const line of numstat.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [addRaw, delRaw, ...nameParts] = parts;
      const file = normalizeGitPath(nameParts.join('\t'));
      if (!file || seen.has(file)) continue;

      const add = parseInt(addRaw || '0', 10) || 0;
      const del = parseInt(delRaw || '0', 10) || 0;
      lines.push(`${file}   {+${add}}\\g  {-${del}}\\r`);
      totalAdd += add;
      totalDel += del;
      seen.add(file);
    }
  }

  // Only append untracked files from status; tracked files are already covered by numstat.
  if (status) {
    for (const line of status.split('\n').filter(Boolean)) {
      const state = line.slice(0, 2);
      if (state !== '??') continue;

      const file = normalizeGitPath(line.slice(3));
      if (!file || seen.has(file)) continue;

      lines.push(`${file}   {${i18n.t('git.branch.diff.new')}}\\g`);
      totalAdd += 1;
      seen.add(file);
    }
  }

  lines.push('');
  lines.push(i18n.t('git.branch.diff.total', {
    files: String(seen.size),
    add: `{+${totalAdd}}\\g`,
    del: `{-${totalDel}}\\r`,
  }));
  return lines.join('\n');
}

// ── Activation ───────────────────────────────────────────────────────────────

export function activate(ctx: finch.ExtensionContext): void {
  ctx.subscriptions.push(
    ctx.icons.register('git-branch', {
      plus: { svg: readIconSvg('plus'), description: 'Create branch' },
      'plus-circle': { svg: readIconSvg('plus-circle'), description: 'Create branch' },
    }),
  );

  const composerAction = ctx.composerActions.register('git-branch', {
      async getBadge({ cwd }): Promise<string | undefined> {
        if (!cwd || !isGitRepo(cwd)) throw new Error('not a git repo');
        // Keep activeCwd up-to-date so the background poller can use it.
        activeCwd = cwd;
        // 工具/菜单分支变更会写入 storage；getBadge 每次同步真实 git 状态。
        // 不删除缓存，避免一次内部查询提前消费，导致入口文案仍停留在旧值。
        const branch = await git(cwd, ['branch', '--show-current']);
        if (branch) {
          await ctx.storage.set(CURRENT_BRANCH_KEY, branch);
          return branch;
        }
        return await ctx.storage.get<string>(CURRENT_BRANCH_KEY);
      },

      async getMenu({ cwd }): Promise<finch.ComposerActionMenuItem[]> {
        if (!cwd) return [];

        try {
          const currentBranch = await git(cwd, ['branch', '--show-current']);
          if (!currentBranch) return [];

          const raw = await git(cwd, ['branch']);
          const allBranches = raw
            .split('\n')
            .filter(Boolean)
            .map((l) => l.replace(/^\*?\s+/, '').trim())
            .filter(Boolean);

          const pinned = ['main', 'master'].filter(
            (b) => b !== currentBranch && allBranches.includes(b),
          );
          const otherBranches = allBranches.filter(
            (b) => b !== currentBranch && !pinned.includes(b),
          );

          const changedFiles = await getChangedFileCount(cwd);
          const currentDesc = changedFiles > 0
            ? ctx.i18n.t('git.branch.changes', { count: String(changedFiles) })
            : undefined;

          const pinnedDiffs = new Map<string, string>();
          await Promise.all(
            pinned.map(async (b) => {
              const d = await getAheadBehind(cwd, b);
              const desc = renderAheadBehindDesc(d);
              if (desc) pinnedDiffs.set(b, desc);
            }),
          );

          const items: finch.ComposerActionMenuItem[] = [];

          items.push({
            id: currentBranch,
            label: currentBranch,
            current: true,
            description: currentDesc,
            iconName: 'git-branch',
          });

          for (const b of pinned) {
            items.push({
              id: b,
              label: b,
              description: pinnedDiffs.get(b) || undefined,
              iconName: 'git-branch',
            });
          }

          if (otherBranches.length > 0) {
            items.push({ id: '__sep1__', label: '', separator: true });

            const otherDiffs = new Map<string, string>();
            await Promise.all(
              otherBranches.map(async (b) => {
                const d = await getAheadBehind(cwd, b);
                const desc = renderAheadBehindDesc(d);
                if (desc) otherDiffs.set(b, desc);
              }),
            );

            const children: finch.ComposerActionMenuItem[] = otherBranches.map(
              (b, index) => ({
                id: b,
                label: b,
                description: otherDiffs.get(b) || undefined,
                iconName: 'git-branch',
                group: 'branches',
                groupLabel: index === 0 ? ctx.i18n.t('git.branch.more.group') : undefined,
                groupMaxVisible: index === 0 ? 6 : undefined,
              }),
            );

            items.push({
              id: '__submenu__',
              label: ctx.i18n.t('git.branch.more'),
              description: `${otherBranches.length}`,
              iconName: 'git-commit-horizontal',
              children,
            });
          }

          items.push({ id: '__sep__', label: '', separator: true });

          items.push({
            id: '__create_branch__',
            label: ctx.i18n.t('git.branch.create'),
            iconName: 'ext:git-branch/plus',
          });

          return items;
        } catch (err) {
          ctx.logger.error('getMenu failed', err);
          return [{ id: '__error__', label: ctx.i18n.t('git.branch.fetch.error'), disabled: true }];
        }
      },

      async execute({ cwd }, itemId: string, actions: finch.ComposerActionActions): Promise<void> {
        if (!cwd || !itemId) return;

        // ── Create branch: 直接填入 Prompt ────────────────────────────
        if (itemId === '__create_branch__') {
          await actions.fillComposer(ctx.i18n.t('git.branch.create.prompt'));
          return;
        }

        if (itemId.startsWith('__')) return;

        // ── Branch switch ──────────────────────────────────────────────
        try {
          const fromBranch = await git(cwd, ['branch', '--show-current']).catch(() => '');
          const status = await git(cwd, ['status', '--porcelain']);
          let checkpointCommit: string | undefined;

          if (status) {
            const message = await buildDiffMessage(cwd, ctx.i18n);

            const result = await ctx.ui.showModalDialog({
              title: ctx.i18n.t('git.branch.switch.title'),
              description: ctx.i18n.t('git.branch.switch.desc', { branch: itemId }),
              message,
              actions: [
                { id: 'cancel', label: ctx.i18n.t('git.branch.switch.cancel'), variant: 'secondary' },
                { id: 'commit', label: ctx.i18n.t('git.branch.switch.commit'), variant: 'primary' },
              ],
            });

            if (result.action === 'dismissed' || result.action === 'cancel') {
              return;
            }

            await git(cwd, ['add', '-A']);
            await git(cwd, [
              'commit', '-m',
              ctx.i18n.t('git.branch.switch.commit.msg', { branch: itemId }),
            ]);
            checkpointCommit = await git(cwd, ['rev-parse', '--short', 'HEAD']).catch(() => undefined);
          }

          await git(cwd, ['checkout', itemId], 10_000);
          await ctx.storage.set(CURRENT_BRANCH_KEY, itemId);

          if (checkpointCommit) {
            await ctx.ui.showToast({
              title: ctx.i18n.t('git.branch.switch.toast.title'),
              description: ctx.i18n.t('git.branch.switch.toast.desc', {
                from: fromBranch || 'HEAD',
                to: itemId,
                commit: checkpointCommit,
              }),
              variant: 'success',
              position: 'TC',
            });
          }
        } catch (err) {
          ctx.logger.error('checkout failed', err);
          ctx.ui.showMessage(ctx.i18n.t('git.branch.switch.fail'), 'error');
        }
      },
    });

  // ── Agent tool: create branch with form dialog ─────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'create_git_branch',
      title: ctx.i18n.t('tool.create.title'),
      description: ctx.i18n.t('tool.create.desc'),
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      risk: 'medium',
      async execute(_input, exec) {
        await exec.storage.delete('pendingCreateBranch').catch(() => {});

        const result = await exec.ui.requestForm({
          title: ctx.i18n.t('git.branch.create.title'),
          description: ctx.i18n.t('git.branch.create.desc'),
          submitLabel: ctx.i18n.t('git.branch.create.submit'),
          fields: [
            {
              key: 'branchName',
              label: ctx.i18n.t('git.branch.create.field'),
              type: 'text',
              required: true,
              placeholder: ctx.i18n.t('git.branch.create.ph'),
            },
          ],
          timeoutMs: 120_000,
        });

        if (!result.submitted) {
          return { content: [{ type: 'text', text: ctx.i18n.t('git.branch.create.cancelled') }] };
        }

        const branchName = result.values.branchName as string;
        if (!branchName || !/^[a-zA-Z0-9_./-]+$/.test(branchName)) {
          return {
            content: [
              { type: 'text', text: ctx.i18n.t('git.branch.create.invalid', { name: branchName }) },
            ],
            isError: true,
          };
        }

        const cwd = exec.cwd;
        if (!cwd) {
          return { content: [{ type: 'text', text: ctx.i18n.t('git.branch.create.nocwd') }], isError: true };
        }

        const status = await git(cwd, ['status', '--porcelain']).catch(() => '');
        if (status) {
          await git(cwd, ['add', '-A']);
          await git(cwd, [
            'commit', '-m',
            `checkpoint: before creating branch ${branchName}`,
          ]);
        }

        await git(cwd, ['checkout', '-b', branchName], 10_000);
        await ctx.storage.set(CURRENT_BRANCH_KEY, branchName);

        let msg = ctx.i18n.t('git.branch.create.success', { name: branchName });
        if (status) {
          msg += ctx.i18n.t('git.branch.create.checkpoint');
        }

        return {
          content: [{ type: 'text', text: msg }],
        };
      },
    }),
  );

  ctx.subscriptions.push(composerAction);

  // ── Background poller: notify badge refresh when branch changes externally ──
  // Reads .git/HEAD directly (no process spawn) every 3 s.
  // Calls composerAction.notifyUpdate() when branch differs, which triggers
  // a getBadge re-fetch and updates the toolbar badge immediately.
  let lastPolledBranch: string | undefined;
  const pollInterval = setInterval(() => {
    const cwd = activeCwd;
    if (!cwd || !isGitRepo(cwd)) return;
    try {
      const head = readFileSync(join(cwd, '.git/HEAD'), 'utf-8').trim();
      const match = head.match(/^ref: refs\/heads\/(.+)$/);
      const branch = match?.[1];
      if (!branch) return;
      if (branch !== lastPolledBranch) {
        lastPolledBranch = branch;
        composerAction.notifyUpdate();
      }
    } catch {
      // ignore transient errors (detached HEAD, missing .git/HEAD, etc.)
    }
  }, 3000);

  ctx.subscriptions.push({ dispose: () => clearInterval(pollInterval) });

  ctx.logger.info('git-branch v2 activated');
}

export function deactivate(): void {}
