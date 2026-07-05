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
async function buildDiffMessage(cwd: string, i18n: finch.ExtensionI18n): Promise<string> {
  const numstat = await git(cwd, ['diff', '--numstat']).catch(() => '');
  const status = await git(cwd, ['status', '--porcelain']).catch(() => '');

  const lines: string[] = [];
  lines.push(i18n.t('git.branch.diff.title'));
  lines.push('');

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
        const parts = file.split('\t');
        statusFiles.set(parts[parts.length - 1], 'renamed');
      } else {
        statusFiles.set(file, state.trim() || 'M');
      }
    }
  }

  for (const [file, st] of statusFiles) {
    const ns = numstatFiles.get(file);
    if (ns) {
      lines.push(`${file}   +${ns.add}  -${ns.del}`);
      totalAdd += ns.add;
      totalDel += ns.del;
    } else if (st === 'new') {
      lines.push(`${file}   ${i18n.t('git.branch.diff.new')}`);
      totalAdd += 1;
    } else {
      lines.push(`${file}`);
    }
  }

  for (const [file, ns] of numstatFiles) {
    if (!statusFiles.has(file)) {
      lines.push(`${file}   +${ns.add}  -${ns.del}`);
      totalAdd += ns.add;
      totalDel += ns.del;
    }
  }

  lines.push('');
  lines.push(i18n.t('git.branch.diff.total', {
    files: String(statusFiles.size + (numstatFiles.size - statusFiles.size)),
    add: String(totalAdd),
    del: String(totalDel),
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
              (b) => ({
                id: b,
                label: b,
                description: otherDiffs.get(b) || undefined,
                iconName: 'git-branch',
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
          const status = await git(cwd, ['status', '--porcelain']);
          if (status) {
            const message = await buildDiffMessage(cwd, ctx.i18n);

            const result = await ctx.ui.showModalDialog({
              title: ctx.i18n.t('git.branch.switch.title'),
              description: ctx.i18n.t('git.branch.switch.desc', { branch: itemId }),
              message,
              actions: [
                { id: 'cancel', label: ctx.i18n.t('git.branch.switch.cancel') },
                { id: 'commit', label: ctx.i18n.t('git.branch.switch.commit') },
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
          }

          await git(cwd, ['checkout', itemId], 10_000);
        } catch (err) {
          ctx.logger.error('checkout failed', err);
          ctx.ui.showMessage(ctx.i18n.t('git.branch.switch.fail'), 'error');
        }
      },
    }),
  );

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

  ctx.logger.info('git-branch v2 activated');
}

export function deactivate(): void {}
