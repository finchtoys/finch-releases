/**
 * @finch/plugin-git-branch
 *
 * Composer toolbar button that shows the current Git branch and lets the user
 * switch branches via a dropdown menu.
 *
 * Bundled with Finch and auto-installed to ~/.finch/plugins/ on startup.
 */
import type * as finch from 'finch';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function activate(ctx: finch.ExtensionContext): void {
  ctx.subscriptions.push(
    ctx.composerActions.register('git-branch', {
      /**
       * Returns the current branch name as the button badge.
       * Throwing signals "not applicable here" → button is hidden.
       */
      async getBadge({ cwd }: finch.ComposerActionContext): Promise<string | undefined> {
        if (!cwd) throw new Error('no cwd');
        if (!existsSync(join(cwd, '.git'))) throw new Error('not a git repo');

        const { stdout } = await execFileAsync(
          'git',
          ['-C', cwd, 'branch', '--show-current'],
          { timeout: 3000 },
        );
        return stdout.trim() || undefined;
      },

      /** Lists local branches; marks the current one. */
      async getMenu({ cwd }: finch.ComposerActionContext): Promise<finch.ComposerActionMenuItem[]> {
        if (!cwd) return [];
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['-C', cwd, 'branch'],
            { timeout: 5000 },
          );
          const items: finch.ComposerActionMenuItem[] = [];
          for (const line of stdout.split('\n').filter(Boolean)) {
            const current = line.startsWith('* ');
            const name = line.replace(/^\*?\s+/, '').trim();
            if (name) items.push({ id: name, label: name, current });
          }
          return items;
        } catch {
          return [{ id: '__error__', label: 'Failed to list branches', disabled: true }];
        }
      },

      /** Checks out the selected branch. */
      async execute({ cwd }: finch.ComposerActionContext, itemId: string): Promise<void> {
        if (!cwd || !itemId || itemId === '__error__') return;
        await execFileAsync('git', ['-C', cwd, 'checkout', itemId], {
          timeout: 10_000,
        });
      },
    }),
  );
}

export function deactivate(): void {}
