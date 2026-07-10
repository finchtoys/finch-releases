import type * as finch from 'finch';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findBlogRoot, loadConfig, saveConfig } from './config.js';
import { buildSite, collectPosts, makeFrontmatter, slugify } from './build.js';
import { previewServer, openInBrowser } from './server.js';
import { initBlog, THEMES } from './scaffold.js';
import { preparePublish, doPublish } from './publish.js';
import { gitStatusSummary, isGitRepo } from './git.js';
import { ICON_PACK_ID, PJBLOG_ICONS, icon } from './icons.js';

function text(t: string): finch.ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function errorText(t: string): finch.ToolResult {
  return { content: [{ type: 'text', text: t }], isError: true };
}

interface RegisteredBlog {
  root: string;
  title: string;
  initializedAt: string;
  lastUsedAt: string;
}

const BLOG_REGISTRY_KEY = 'blogs';

function requireRoot(dir: string | undefined, cwd: string | undefined): string {
  const root = findBlogRoot(dir ?? cwd);
  if (!root) {
    throw new Error(
      'No blog workspace found (blog.config.json not located from cwd). Use pjblog_init to create one, or pass the blog directory via the "dir" parameter.',
    );
  }
  return root;
}

export function activate(ctx: finch.MiniToolContext) {
  const extensionPath = ctx.extension.extensionPath;
  const themesSource = path.join(extensionPath, 'themes');
  const t = (key: string, values?: finch.TranslationValues) => ctx.i18n.t(key, values);

  async function listRegisteredBlogs(): Promise<RegisteredBlog[]> {
    const stored = await ctx.storage.get<RegisteredBlog[]>(BLOG_REGISTRY_KEY);
    const blogs = Array.isArray(stored) ? stored : [];
    const valid: RegisteredBlog[] = [];
    for (const blog of blogs) {
      if (!blog || typeof blog.root !== 'string' || !fs.existsSync(path.join(blog.root, 'blog.config.json'))) continue;
      try {
        const config = loadConfig(blog.root);
        valid.push({ ...blog, title: config.title || blog.title || path.basename(blog.root) });
      } catch {
        // A malformed config is not a usable PJBlog workspace.
      }
    }
    valid.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    if (JSON.stringify(valid) !== JSON.stringify(blogs)) await ctx.storage.set(BLOG_REGISTRY_KEY, valid);
    return valid;
  }

  async function rememberBlog(root: string, lastUsedAt = new Date().toISOString()): Promise<void> {
    const blogs = await listRegisteredBlogs();
    const config = loadConfig(root);
    const previous = blogs.find((blog) => blog.root === root);
    const entry: RegisteredBlog = {
      root,
      title: config.title || path.basename(root),
      initializedAt: previous?.initializedAt ?? lastUsedAt,
      lastUsedAt,
    };
    await ctx.storage.set(BLOG_REGISTRY_KEY, [entry, ...blogs.filter((blog) => blog.root !== root)]);
  }

  async function forgetBlog(root: string): Promise<boolean> {
    const blogs = await listRegisteredBlogs();
    const next = blogs.filter((blog) => blog.root !== root);
    if (next.length === blogs.length) return false;
    await ctx.storage.set(BLOG_REGISTRY_KEY, next);
    return true;
  }

  // Runtime icon pack — the app's built-in icon set may not include these names.
  ctx.subscriptions.push(ctx.icons.register(ICON_PACK_ID, PJBLOG_ICONS));

  // ── pjblog_init ────────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'pjblog_init',
      title: 'Init Blog',
      description:
        'Initialize a new PJBlog blog workspace. Opens a form for the user to fill in blog title, author, description, theme and target directory, then scaffolds posts/pages/themes directories, a welcome post, GitHub Pages workflow, and runs git init. Call when the user wants to create a new blog. After success, suggest binding the directory as a Finch Space.',
      inputSchema: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Suggested target directory (absolute or relative to cwd). Prefilled in the form; the user can change it.' },
        },
      },
      defaultEnabled: true,
      risk: 'medium',
      async execute(input, exec) {
        const suggested = input.dir
          ? path.resolve(exec.cwd ?? '.', String(input.dir))
          : path.join(exec.cwd ?? '.', 'my-blog');
        const form = await exec.ui.requestForm({
          title: t('form.init.title'),
          description: t('form.init.desc'),
          submitLabel: t('form.init.submit'),
          fields: [
            { key: 'title', label: t('form.init.blogTitle'), type: 'text', required: true, default: 'My Blog', width: '2/3' },
            { key: 'author', label: t('form.init.author'), type: 'text', width: '1/3' },
            { key: 'description', label: t('form.init.description'), type: 'text' },
            {
              key: 'theme',
              label: t('form.init.theme'),
              type: 'select',
              default: 'plain',
              width: '1/2',
              options: [
                { value: 'plain', label: t('theme.plain') },
                { value: 'nocturne', label: t('theme.nocturne') },
                { value: 'journal', label: t('theme.journal') },
                { value: 'pjblog-classic', label: t('theme.pjblog-classic') },
              ],
            },
            {
              key: 'language',
              label: t('form.init.language'),
              type: 'select',
              default: 'zh-CN',
              width: '1/2',
              options: [
                { value: 'zh-CN', label: '中文' },
                { value: 'en-US', label: 'English' },
              ],
            },
            { key: 'dir', label: t('form.init.dir'), type: 'text', required: true, default: suggested },
          ],
        });
        if (!form.submitted) return text(`User did not submit the init form (${form.reason}). Do not retry unless asked.`);
        const v = form.values;
        const result = await initBlog(
          {
            dir: path.resolve(exec.cwd ?? '.', String(v.dir)),
            title: String(v.title ?? ''),
            author: String(v.author ?? ''),
            description: String(v.description ?? ''),
            theme: String(v.theme ?? 'plain'),
            language: String(v.language ?? 'zh-CN'),
          },
          themesSource,
        );
        await rememberBlog(result.root);
        return text(
          [
            `Blog initialized at: ${result.root}`,
            `Theme: ${result.theme}. Git initialized: ${result.gitInitialized}.`,
            `Structure: posts/ pages/ assets/ themes/ blog.config.json AGENTS.md + GitHub Pages workflow.`,
            ``,
            `Next steps to suggest to the user:`,
            `1. Bind this directory as a Finch Space (AppCall createSpace with path=${result.root}) so future writing sessions stay scoped.`,
            `2. Start live preview with pjblog_preview action=start.`,
            `3. Configure a git remote for one-click publishing (git remote add origin <url>).`,
          ].join('\n'),
        );
      },
    }),
  );

  // ── pjblog_new_post ────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'pjblog_new_post',
      title: 'New Post',
      description:
        'Create a new markdown post file in the blog workspace with proper frontmatter (title/date/tags/summary/draft). Returns the file path — then write or edit the content with normal file tools. Call when the user wants to write a new blog post or diary entry.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Post title.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
          summary: { type: 'string', description: 'Optional one-line summary.' },
          draft: { type: 'boolean', description: 'Create as draft (default true — drafts show in preview but are excluded from publish).' },
          slug: { type: 'string', description: 'Optional url slug; derived from title when omitted.' },
          dir: { type: 'string', description: 'Blog directory when cwd is not inside the blog.' },
        },
        required: ['title'],
      },
      defaultEnabled: true,
      risk: 'medium',
      callDisplay: { inline: { fields: [{ path: 'title', format: 'truncate', maxLength: 30 }] } },
      async execute(input, exec) {
        const root = requireRoot(input.dir as string | undefined, exec.cwd);
        const today = new Date().toISOString().slice(0, 10);
        const year = today.slice(0, 4);
        const slug = slugify(String(input.slug ?? input.title));
        const dir = path.join(root, 'posts', year);
        fs.mkdirSync(dir, { recursive: true });
        let file = path.join(dir, `${today}-${slug}.md`);
        let n = 2;
        while (fs.existsSync(file)) file = path.join(dir, `${today}-${slug}-${n++}.md`);
        const fm = makeFrontmatter({
          title: String(input.title),
          date: today,
          tags: (input.tags as string[] | undefined) ?? [],
          summary: input.summary as string | undefined,
          draft: input.draft !== false,
        });
        fs.writeFileSync(file, fm, 'utf8');
        return text(
          `Created post file: ${file}\nFrontmatter is in place (draft=${input.draft !== false}). Now write the content into this file. Live preview will refresh automatically if running.`,
        );
      },
    }),
  );

  // ── pjblog_build ───────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'pjblog_build',
      title: 'Build Blog',
      description:
        'Generate the static site into public/ (home, post pages, archive, tag pages, standalone pages, RSS, sitemap, 404). Call when the user wants to (re)build the blog output without publishing.',
      inputSchema: {
        type: 'object',
        properties: {
          includeDrafts: { type: 'boolean', description: 'Include draft posts (marked with a draft badge). Default false.' },
          dir: { type: 'string', description: 'Blog directory when cwd is not inside the blog.' },
        },
      },
      defaultEnabled: true,
      risk: 'medium',
      async execute(input, exec) {
        const root = requireRoot(input.dir as string | undefined, exec.cwd);
        const r = buildSite(root, { includeDrafts: Boolean(input.includeDrafts) });
        return text(
          `Build complete → ${r.outDir}\nTheme: ${r.theme} · Published posts: ${r.postCount} · Drafts: ${r.draftCount} (${input.includeDrafts ? 'included' : 'excluded'}) · Pages: ${r.pageCount}\nExtras: rss.xml, sitemap.xml, 404.html`,
        );
      },
    }),
  );

  // ── pjblog_preview ─────────────────────────────────────────────────────────
  const previewAction = ctx.composerActions.register('pjblog', {
    async getIcon() {
      return icon('notebook-pen');
    },
    async getBadge({ cwd, surface }) {
      // Home is intentionally discoverable: show the button without a badge.
      if (surface === 'home') return undefined;
      const s = previewServer.getStatus();
      if (s.running) return { text: t('badge.previewing'), active: true };
      // Keep the contextual rule for regular sessions: only blog workspaces show it.
      if (!findBlogRoot(cwd)) throw new Error('no blog here');
      return undefined;
    },
    async getMenu({ cwd, surface }) {
      // Home is an onboarding entry, not a generic global blog menu.
      if (surface === 'home') {
        const blogs = await listRegisteredBlogs();
        if (blogs.length === 0) {
          return [
            { id: 'init', label: t('menu.init'), iconName: icon('folder-plus'), group: 'blog', groupLabel: t('menu.groupBlog') },
          ];
        }
        return blogs.map((blog) => ({
          id: `blog:${encodeURIComponent(blog.root)}`,
          label: blog.title,
          iconName: icon('notebook-pen'),
          group: 'blogs',
          groupLabel: t('menu.groupExistingBlogs'),
        }));
      }
      const s = previewServer.getStatus();
      const items: finch.ComposerActionMenuItem[] = [];
      if (s.running) {
        items.push(
          { id: 'status', label: t('menu.running', { url: s.url ?? '' }), disabled: true, group: 'preview', groupLabel: t('menu.groupPreview') },
          { id: 'open', label: t('menu.open'), iconName: icon('external-link'), group: 'preview' },
          { id: 'stop', label: t('menu.stop'), iconName: icon('circle-stop'), group: 'preview' },
        );
      } else {
        items.push({ id: 'start', label: t('menu.start'), iconName: icon('play'), group: 'preview', groupLabel: t('menu.groupPreview') });
      }
      items.push(
        { id: 'write', label: t('menu.write'), iconName: icon('pencil-line'), group: 'blog', groupLabel: t('menu.groupBlog') },
        { id: 'publish', label: t('menu.publish'), iconName: icon('rocket'), group: 'blog' },
        { id: 'init', label: t('menu.init'), iconName: icon('folder-plus'), group: 'blog' },
      );
      return items;
    },
    async execute({ cwd }, itemId, actions) {
      if (itemId.startsWith('blog:')) {
        const root = decodeURIComponent(itemId.slice('blog:'.length));
        const blog = (await listRegisteredBlogs()).find((entry) => entry.root === root);
        if (blog) {
          await rememberBlog(root);
          await actions.composer.fill(t('fill.continue', { title: blog.title, dir: blog.root }));
        }
        return;
      }
      switch (itemId) {
        case 'start': {
          const root = findBlogRoot(cwd);
          if (!root) {
            await actions.composer.fill(t('fill.init'));
            return;
          }
          const s = await previewServer.start(root, ctx.logger);
          previewAction.notifyUpdate();
          if (s.url) openInBrowser(s.url, process.platform);
          ctx.ui.showToast({ title: t('toast.started'), description: s.url, variant: 'success' });
          break;
        }
        case 'stop': {
          await previewServer.stop();
          previewAction.notifyUpdate();
          ctx.ui.showToast({ title: t('toast.stopped'), variant: 'info' });
          break;
        }
        case 'open': {
          const s = previewServer.getStatus();
          if (s.url) openInBrowser(s.url, process.platform);
          break;
        }
        case 'write':
          await actions.composer.fill(t('fill.write'));
          break;
        case 'publish':
          await actions.composer.fill(t('fill.publish'));
          break;
        case 'init':
          await actions.composer.fill(t('fill.init'));
          break;
      }
    },
  });
  ctx.subscriptions.push(previewAction);
  ctx.subscriptions.push({ dispose: () => void previewServer.stop() });
  previewServer.onStatusChange = () => previewAction.notifyUpdate();

  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'pjblog_preview',
      title: 'Preview Blog',
      description:
        'Manage the live preview server: action=start builds (drafts included) and serves the site with file watching + auto browser reload; stop shuts it down; open opens the preview URL in the default browser; status reports current state. While running, any change to posts/pages/themes/assets rebuilds and refreshes the browser automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'open', 'status'], description: 'What to do. Default: start.' },
          dir: { type: 'string', description: 'Blog directory when cwd is not inside the blog.' },
        },
      },
      defaultEnabled: true,
      risk: 'low',
      callDisplay: { inline: { fields: [{ path: 'action' }] } },
      async execute(input, exec) {
        const action = String(input.action ?? 'start');
        if (action === 'status') {
          const s = previewServer.getStatus();
          return text(s.running ? `Preview running at ${s.url} (root: ${s.root}, last build: ${s.lastBuildAt}${s.lastBuildError ? `, last build error: ${s.lastBuildError}` : ''})` : 'Preview server is not running.');
        }
        if (action === 'stop') {
          await previewServer.stop();
          previewAction.notifyUpdate();
          return text('Preview server stopped.');
        }
        if (action === 'open') {
          const s = previewServer.getStatus();
          if (!s.running || !s.url) return errorText('Preview server is not running. Start it first with action=start.');
          openInBrowser(s.url, process.platform);
          return text(`Opened ${s.url} in the default browser.`);
        }
        // start
        const root = requireRoot(input.dir as string | undefined, exec.cwd);
        const s = await previewServer.start(root, exec.logger);
        previewAction.notifyUpdate();
        if (s.url) openInBrowser(s.url, process.platform);
        return text(
          `Preview server running at ${s.url} (opened in browser).\nDrafts are visible with a badge. Edits to posts/pages/themes/assets rebuild automatically and live-reload the browser${s.lastBuildError ? `\n⚠ Last build error: ${s.lastBuildError}` : ''}`,
        );
      },
    }),
  );

  // ── pjblog_publish ─────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'pjblog_publish',
      title: 'Publish Blog',
      description:
        'Publish the blog: rebuild (drafts excluded) then git commit + push to the configured remote (GitHub Pages deploys automatically via the bundled workflow). TWO-PHASE: first call WITHOUT confirm to get a change summary — show it to the user and STOP; only after the user explicitly confirms, call again with confirm=true and a commit message.',
      inputSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'Must be true to actually commit and push. Omit on the first call to preview changes.' },
          message: { type: 'string', description: 'Git commit message (required when confirm=true). Write a concise summary of the content changes.' },
          dir: { type: 'string', description: 'Blog directory when cwd is not inside the blog.' },
        },
      },
      defaultEnabled: true,
      risk: 'high',
      async execute(input, exec) {
        const root = requireRoot(input.dir as string | undefined, exec.cwd);
        if (!input.confirm) {
          const p = await preparePublish(root);
          const changes = p.changes.length ? p.changes.slice(0, 40).join('\n') : '(no uncommitted changes)';
          return text(
            [
              `Publish preview (NOT yet published):`,
              `Blog: ${root}`,
              `Branch: ${p.branch} · Remote: ${p.remote ?? 'NOT CONFIGURED'} · Mode: ${p.mode}`,
              `Published posts after build: ${p.postCount}`,
              `Pending changes (${p.changes.length}):`,
              changes,
              ``,
              `Show this summary to the user and wait for explicit confirmation. Then call pjblog_publish again with confirm=true and a commit message.${p.remote ? '' : '\n⚠ No git remote configured — ask the user for the repository URL first (git remote add origin <url>).'}`,
            ].join('\n'),
          );
        }
        const message = String(input.message ?? '').trim() || `blog: publish ${new Date().toISOString().slice(0, 10)}`;
        const r = await doPublish(root, message);
        return text(`Publish ${r.pushed ? 'complete ✅' : 'partial'} — committed: ${r.committed}, pushed: ${r.pushed}\nCommit: "${r.commitMessage}"\n${r.detail}`);
      },
    }),
  );

  // ── pjblog_theme ───────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'pjblog_theme',
      title: 'Blog Theme',
      description:
        'List available themes (action=list) or switch the active theme (action=use with theme id). Themes live in the blog\'s themes/ directory and can also be customized by editing their HTML/CSS directly.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'use'], description: 'Default: list.' },
          theme: { type: 'string', description: 'Theme id for action=use (plain | nocturne | journal | pjblog-classic, or any custom directory under themes/).' },
          dir: { type: 'string', description: 'Blog directory when cwd is not inside the blog.' },
        },
      },
      defaultEnabled: true,
      risk: 'medium',
      callDisplay: { inline: { mode: 'join', fields: [{ path: 'action' }, { path: 'theme' }] } },
      async execute(input, exec) {
        const root = requireRoot(input.dir as string | undefined, exec.cwd);
        const config = loadConfig(root);
        const themesDir = path.join(root, 'themes');
        const installed = fs.existsSync(themesDir)
          ? fs.readdirSync(themesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
          : [];
        if (String(input.action ?? 'list') === 'list') {
          const lines = installed.map((id) => {
            let desc = '';
            try {
              const meta = JSON.parse(fs.readFileSync(path.join(themesDir, id, 'theme.json'), 'utf8'));
              desc = `${meta.name ?? id} — ${meta.description ?? ''}`;
            } catch {
              desc = id;
            }
            return `- ${id}${id === config.theme ? ' (current)' : ''}: ${desc}`;
          });
          return text(`Installed themes:\n${lines.join('\n')}\nBuilt-in ids: ${THEMES.join(', ')}`);
        }
        const themeId = String(input.theme ?? '');
        if (!installed.includes(themeId)) return errorText(`Theme "${themeId}" not found under themes/. Installed: ${installed.join(', ')}`);
        config.theme = themeId;
        saveConfig(root, config);
        buildSite(root, { includeDrafts: true });
        return text(`Theme switched to "${themeId}" and site rebuilt. Preview will refresh automatically if running.`);
      },
    }),
  );

  // ── pjblog_status ──────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'pjblog_status',
      title: 'Blog Status',
      description:
        'Report blog workspace overview: post/draft counts, current theme, preview server state, and git status (branch, remote, uncommitted changes). Call when the user asks about the blog state.',
      inputSchema: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Blog directory when cwd is not inside the blog.' },
        },
      },
      defaultEnabled: true,
      risk: 'low',
      async execute(input, exec) {
        const root = requireRoot(input.dir as string | undefined, exec.cwd);
        const config = loadConfig(root);
        const posts = collectPosts(root, true);
        const drafts = posts.filter((p) => p.draft);
        const s = previewServer.getStatus();
        const lines = [
          `Blog: ${config.title} (${root})`,
          `Theme: ${config.theme} · Language: ${config.language}`,
          `Posts: ${posts.length - drafts.length} published, ${drafts.length} drafts`,
          `Preview: ${s.running ? `running at ${s.url}` : 'stopped'}`,
        ];
        if (await isGitRepo(root)) {
          const g = await gitStatusSummary(root);
          lines.push(`Git: branch ${g.branch}, remote ${g.remote ?? 'not configured'}, ${g.changes.length} uncommitted change(s)`);
        } else {
          lines.push('Git: not a repository');
        }
        if (drafts.length) lines.push(`Draft titles: ${drafts.map((d) => d.title).join(' / ')}`);
        return text(lines.join('\n'));
      },
    }),
  );

  // ── pjblog_manage ──────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'pjblog_manage',
      title: 'Manage My Blogs',
      description:
        'Manage the PJBlog "My Blogs" list without creating a new blog. action=list shows registered blog workspaces; action=bind adds an existing directory containing blog.config.json; action=unbind removes a directory from this list only. It never deletes blog files or Finch Spaces.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'bind', 'unbind'], description: 'list registered blogs; bind an existing blog; or unbind it from the My Blogs list.' },
          dir: { type: 'string', description: 'Existing blog directory for bind/unbind. Required unless action=list.' },
        },
      },
      defaultEnabled: true,
      risk: 'low',
      callDisplay: { inline: { mode: 'join', fields: [{ path: 'action' }, { path: 'dir' }] } },
      async execute(input, exec) {
        const action = String(input.action ?? 'list');
        if (action === 'list') {
          const blogs = await listRegisteredBlogs();
          if (blogs.length === 0) return text('My Blogs is empty. Use action=bind with an existing PJBlog directory, or use pjblog_init to create one.');
          return text(`My Blogs (${blogs.length}):\n${blogs.map((blog) => `- ${blog.title}\n  ${blog.root}\n  Last used: ${blog.lastUsedAt}`).join('\n')}`);
        }
        const dir = input.dir ? path.resolve(exec.cwd ?? '.', String(input.dir)) : '';
        if (!dir) return errorText('The "dir" parameter is required for bind and unbind.');
        const root = findBlogRoot(dir) ?? dir;
        if (action === 'bind') {
          if (!fs.existsSync(path.join(root, 'blog.config.json'))) {
            return errorText(`No PJBlog workspace found at ${dir}. Expected blog.config.json; this action does not initialize a new blog.`);
          }
          await rememberBlog(root);
          return text(`Added to My Blogs: ${loadConfig(root).title} (${root}).`);
        }
        if (action === 'unbind') {
          const removed = await forgetBlog(root);
          return text(removed ? `Removed ${root} from My Blogs. Blog files and Finch Spaces were not changed.` : `${root} is not in My Blogs.`);
        }
        return errorText(`Unknown action "${action}". Use list, bind, or unbind.`);
      },
    }),
  );

  ctx.logger.info('PJBlog For Finch activated');
}

export function deactivate() {
  void previewServer.stop();
}
