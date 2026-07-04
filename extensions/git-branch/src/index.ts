/**
 * @finch/plugin-git-branch v2
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

/**
 * Build a structured message for the ModalDialog showing uncommitted changes.
 * Format: warning line, blank, each file with +/- counts, blank, total.
 */
async function buildDiffMessage(cwd: string): Promise<string> {
  // Per-file numstat: "additions\tdeletions\tfilename"
  const numstat = await git(cwd, ['diff', '--numstat']).catch(() => '');
  // For untracked / new files
  const status = await git(cwd, ['status', '--porcelain']).catch(() => '');
  // Overall stat for total summary
  const diffStat = await git(cwd, ['diff', '--stat']).catch(() => '');

  const lines: string[] = [];
  lines.push('! 当前分支有未提交的更改，请先提交再切换');
  lines.push('');

  // Parse numstat for tracked changes
  const numstatFiles = new Map<string, { add: number; del: number }>();
  if (numstat) {
    for (const line of numstat.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [add, del, ...nameParts] = parts;
      numstatFiles.set(nameParts.join('\t'), {
        add: parseInt(add || '0'),
        del: parseInt(del || '0'),
      });
    }
  }

  // Parse status to find all changed files (including untracked)
  const statusFiles = new Map<string, string>();
  let totalAdd = 0;
  let totalDel = 0;
  if (status) {
    for (const line of status.split('\n').filter(Boolean)) {
      const state = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (!file) continue;

      if (state === '??') {
        statusFiles.set(file, 'new');
      } else if (state.startsWith('R')) {
        // Renamed: "R100 old → new"
        const parts = file.split('\t');
        statusFiles.set(parts[parts.length - 1], 'renamed');
      } else {
        statusFiles.set(file, state.trim() || 'M');
      }
    }
  }

  // Merge: show all status files with numstat info where available
  for (const [file, st] of statusFiles) {
    const ns = numstatFiles.get(file);
    if (ns) {
      lines.push(`${file}   +${ns.add}  -${ns.del}`);
      totalAdd += ns.add;
      totalDel += ns.del;
    } else if (st === 'new') {
      lines.push(`${file}   (new file)`);
      // Untracked files count as additions in stat
      totalAdd += 1;
    } else {
      lines.push(`${file}`);
    }
  }

  // Also show any numstat-only files (e.g. modified that status shows differently)
  for (const [file, ns] of numstatFiles) {
    if (!statusFiles.has(file)) {
      lines.push(`${file}   +${ns.add}  -${ns.del}`);
      totalAdd += ns.add;
      totalDel += ns.del;
    }
  }

  lines.push('');
  lines.push(`> 总计: ${statusFiles.size + (numstatFiles.size - statusFiles.size)} 个文件，+${totalAdd} -${totalDel}`);
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

  ctx.subscriptions.push(
    ctx.composerActions.register('git-branch', {
      async getBadge({ cwd }): Promise<string | undefined> {
        if (!cwd || !isGitRepo(cwd)) throw new Error('not a git repo');
        const branch = await git(cwd, ['branch', '--show-current']);
        return branch || undefined;
      },

      async getMenu({ cwd }): Promise<finch.ComposerActionMenuItem[]> {
        if (!cwd) return [];

        try {
          const currentBranch = await git(cwd, ['branch', '--show-current']);
          if (!currentBranch) return [];

          // List all local branches
          const raw = await git(cwd, ['branch']);
          const allBranches = raw
            .split('\n')
            .filter(Boolean)
            .map((l) => l.replace(/^\*?\s+/, '').trim())
            .filter(Boolean);

          // Pin main / master (exclude current)
          const pinned = ['main', 'master'].filter(
            (b) => b !== currentBranch && allBranches.includes(b),
          );
          const otherBranches = allBranches.filter(
            (b) => b !== currentBranch && !pinned.includes(b),
          );

          // Change info for current branch (staged + unstaged + untracked)
          const changedFiles = await getChangedFileCount(cwd);
          const currentDesc = changedFiles > 0 ? `${changedFiles} 个改动` : undefined;

          // Ahead-behind for pinned branches (others are in submenu)
          const pinnedDiffs = new Map<string, string>();
          await Promise.all(
            pinned.map(async (b) => {
              const d = await getAheadBehind(cwd, b);
              const desc = renderAheadBehindDesc(d);
              if (desc) pinnedDiffs.set(b, desc);
            }),
          );

          // Build menu items
          const items: finch.ComposerActionMenuItem[] = [];

          // 1. Current branch — pinned top
          items.push({
            id: currentBranch,
            label: currentBranch,
            current: true,
            description: currentDesc,
            iconName: 'git-branch',
          });

          // 2. main / master
          for (const b of pinned) {
            items.push({
              id: b,
              label: b,
              description: pinnedDiffs.get(b) || undefined,
              iconName: 'git-branch',
            });
          }

          // 3. "More branches" submenu — only when there are extra branches
          if (otherBranches.length > 0) {
            // Separator before submenu only when it exists
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
              (b) => ({
                id: b,
                label: b,
                description: otherDiffs.get(b) || undefined,
                iconName: 'git-branch',
              }),
            );

            items.push({
              id: '__submenu__',
              label: '更多分支',
              description: `${otherBranches.length}`,
              iconName: 'git-commit-horizontal',
              children,
            });
          }

          // 4. Single separator before create button
          items.push({ id: '__sep__', label: '', separator: true });

          // 5. Create branch
          items.push({
            id: '__create_branch__',
            label: '创建并检出分支...',
            iconName: 'ext:git-branch/plus',
          });

          return items;
        } catch (err) {
          ctx.logger.error('getMenu failed', err);
          return [{ id: '__error__', label: '获取分支失败', disabled: true }];
        }
      },

      async execute({ cwd }, itemId: string): Promise<void> {
        if (!cwd || !itemId) return;

        // ── Create branch ──────────────────────────────────────────────
        if (itemId === '__create_branch__') {
          await ctx.storage.set('pendingCreateBranch', true);
          ctx.ui.showMessage('请在聊天中输入分支名称，我来帮您创建并切换', 'info');
          return;
        }

        // Skip control items
        if (itemId.startsWith('__')) return;

        // ── Branch switch ──────────────────────────────────────────────
        try {
          // 1) Check for uncommitted changes
          const status = await git(cwd, ['status', '--porcelain']);
          if (status) {
            // Build detailed diff info for the ModalDialog
            const message = await buildDiffMessage(cwd);

            const result = await ctx.ui.showModalDialog({
              title: '未提交的更改',
              description: `切换到 ${itemId} 前需要先处理未提交的文件`,
              message,
              actions: [
                { id: 'cancel', label: '取消' },
                { id: 'commit', label: '提交并切换' },
              ],
            });

            // User cancelled or dismissed
            if (result.action === 'dismissed' || result.action === 'cancel') {
              return;
            }

            // 2) Stage all and commit
            await git(cwd, ['add', '-A']);
            await git(cwd, [
              'commit', '-m',
              `checkpoint: before switching to ${itemId}`,
            ]);
          }

          // 3) Switch branch
          await git(cwd, ['checkout', itemId], 10_000);
        } catch (err) {
          ctx.logger.error('checkout failed', err);
          ctx.ui.showMessage('切换分支失败，请检查工作区状态后重试', 'error');
        }
      },
    }),
  );

  // ── Agent tool: create branch with form dialog ─────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'create_git_branch',
      title: 'Create Git Branch',
      description:
        'Create and switch to a new Git branch. ' +
        'Opens a form to collect the branch name. ' +
        'Call when the user wants to create a new branch or says a branch name after clicking "创建并检出分支...".',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      risk: 'medium',
      async execute(_input, exec) {
        await exec.storage.delete('pendingCreateBranch').catch(() => {});

        const result = await exec.ui.requestForm({
          title: '创建 Git 分支',
          description: '输入新分支的名称',
          submitLabel: '创建并检出',
          fields: [
            {
              key: 'branchName',
              label: '分支名称',
              type: 'text',
              required: true,
              placeholder: 'feature/my-feature',
            },
          ],
          timeoutMs: 120_000,
        });

        if (!result.submitted) {
          return { content: [{ type: 'text', text: '已取消创建分支' }] };
        }

        const branchName = result.values.branchName as string;
        if (!branchName || !/^[a-zA-Z0-9_./-]+$/.test(branchName)) {
          return {
            content: [
              {
                type: 'text',
                text: `分支名称 "${branchName}" 不合法，请使用字母、数字、下划线、斜杠和连字符`,
              },
            ],
            isError: true,
          };
        }

        const cwd = exec.cwd;
        if (!cwd) {
          return { content: [{ type: 'text', text: '没有工作目录' }], isError: true };
        }

        // Auto-commit uncommitted changes before creating branch
        const status = await git(cwd, ['status', '--porcelain']).catch(() => '');
        if (status) {
          await git(cwd, ['add', '-A']);
          await git(cwd, [
            'commit', '-m',
            `checkpoint: before creating branch ${branchName}`,
          ]);
        }

        await git(cwd, ['checkout', '-b', branchName], 10_000);

        let msg = `✅ 已创建并切换到分支 \`${branchName}\``;
        if (status) {
          msg += '\n\n已自动提交当前工作区的更改作为 checkpoint。';
        }

        return {
          content: [{ type: 'text', text: msg }],
        };
      },
    }),
  );

  ctx.logger.info('git-branch v2 activated');
}

export function deactivate(): void {}
