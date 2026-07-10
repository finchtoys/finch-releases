import { loadConfig } from './config.js';
import { buildSite } from './build.js';
import { git, isGitRepo, gitStatusSummary } from './git.js';

export interface PublishPreview {
  root: string;
  branch: string;
  remote: string | undefined;
  changes: string[];
  postCount: number;
  mode: string;
}

/** Build the site (no drafts) and summarize what would be committed/pushed. */
export async function preparePublish(root: string): Promise<PublishPreview> {
  const config = loadConfig(root);
  const result = buildSite(root, { includeDrafts: false });
  if (!(await isGitRepo(root))) {
    const init = await git(root, ['init', '-b', 'main']);
    if (!init.ok) throw new Error(`git init failed: ${init.stderr}`);
  }
  const status = await gitStatusSummary(root);
  return {
    root,
    branch: status.branch,
    remote: status.remote,
    changes: status.changes,
    postCount: result.postCount,
    mode: config.publish.mode,
  };
}

export interface PublishResult {
  committed: boolean;
  pushed: boolean;
  commitMessage: string;
  detail: string;
}

/** Commit everything and push to the configured remote. */
export async function doPublish(root: string, commitMessage: string): Promise<PublishResult> {
  const config = loadConfig(root);
  // rebuild without drafts right before publishing
  buildSite(root, { includeDrafts: false });

  await git(root, ['add', '-A']);
  const commit = await git(root, ['commit', '-m', commitMessage]);
  const committed = commit.ok;
  const nothingToCommit = !commit.ok && /nothing to commit/i.test(commit.stdout + commit.stderr);
  if (!committed && !nothingToCommit) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }

  if (config.publish.mode === 'none') {
    return { committed, pushed: false, commitMessage, detail: 'publish.mode=none — build + commit only, no push.' };
  }

  const remote = config.publish.remote || 'origin';
  const branch = config.publish.branch || 'main';
  const remoteCheck = await git(root, ['remote', 'get-url', remote]);
  if (!remoteCheck.ok) {
    return {
      committed,
      pushed: false,
      commitMessage,
      detail: `Remote "${remote}" is not configured. Ask the user for the repository URL, then run: git remote add ${remote} <url> && git push -u ${remote} ${branch}`,
    };
  }

  const push = await git(root, ['push', '-u', remote, branch]);
  if (!push.ok) throw new Error(`git push failed: ${push.stderr || push.stdout}`);
  return {
    committed,
    pushed: true,
    commitMessage,
    detail: `Pushed to ${remoteCheck.stdout} (${branch}). GitHub Pages workflow will deploy public/ automatically if enabled.`,
  };
}
