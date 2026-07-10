import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, type BlogConfig } from './config.js';
import { renderMarkdown, markdownToText } from './markdown.js';
import { renderTemplate, escapeHtml, type TemplateData } from './template.js';

// ── Frontmatter ──────────────────────────────────────────────────────────────

export interface PostMeta {
  title: string;
  date: string; // YYYY-MM-DD (or with time)
  tags: string[];
  summary: string;
  draft: boolean;
}

export interface Post extends PostMeta {
  slug: string;
  /** file mtime, used as tie-breaker when dates are equal */
  mtimeMs: number;
  /** site-relative url like posts/2026/hello-world.html */
  relUrl: string;
  sourcePath: string;
  contentHtml: string;
  dateDisplay: string;
  year: string;
}

export function parseFrontmatter(src: string): { meta: Partial<PostMeta>; body: string } {
  const m = src.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'tags') {
      meta.tags = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (key === 'draft') {
      meta.draft = value === 'true';
    } else {
      meta[key] = value;
    }
  }
  return { meta: meta as Partial<PostMeta>, body: src.slice(m[0].length) };
}

export function makeFrontmatter(meta: { title: string; date: string; tags?: string[]; summary?: string; draft?: boolean }): string {
  const lines = ['---', `title: ${meta.title}`, `date: ${meta.date}`];
  if (meta.tags?.length) lines.push(`tags: [${meta.tags.join(', ')}]`);
  if (meta.summary) lines.push(`summary: ${meta.summary}`);
  if (meta.draft) lines.push('draft: true');
  lines.push('---', '', '');
  return lines.join('\n');
}

export function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || 'post';
}

// ── Collect posts ────────────────────────────────────────────────────────────

function walkMd(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkMd(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

export function collectPosts(root: string, includeDrafts: boolean): Post[] {
  const postsDir = path.join(root, 'posts');
  const posts: Post[] = [];
  for (const file of walkMd(postsDir)) {
    const src = fs.readFileSync(file, 'utf8');
    const { meta, body } = parseFrontmatter(src);
    const base = path.basename(file, '.md');
    const stat = fs.statSync(file);
    const fromName = base.match(/^(\d{4}-\d{2}-\d{2})[-_]?(.*)$/) ?? base.match(/^(\d{2}-\d{2})[-_]?(.*)$/);
    const date = (meta.date as string) || (fromName?.[1]?.length === 10 ? fromName[1] : '') || isoDate(stat.mtime);
    const draft = meta.draft === true;
    if (draft && !includeDrafts) continue;
    const slug = slugify(fromName?.[2] || base);
    const year = date.slice(0, 4) || 'undated';
    const html = renderMarkdown(body);
    const text = markdownToText(body);
    posts.push({
      title: (meta.title as string) || base,
      date,
      tags: meta.tags ?? [],
      summary: (meta.summary as string) || text.slice(0, 160),
      draft,
      slug,
      year,
      relUrl: `posts/${year}/${slug}.html`,
      sourcePath: file,
      contentHtml: html,
      dateDisplay: date,
      mtimeMs: stat.mtimeMs,
    });
  }
  // newest first; same-day posts tie-break by file modification time (newest first)
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.mtimeMs - a.mtimeMs));
  return posts;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Build ────────────────────────────────────────────────────────────────────

export interface BuildResult {
  outDir: string;
  postCount: number;
  draftCount: number;
  pageCount: number;
  theme: string;
}

interface ThemeFiles {
  index: string;
  post: string;
  archive: string;
  page: string;
  assets: string[]; // non-template files copied as-is (css, js, images)
  dir: string;
}

function loadTheme(root: string, theme: string): ThemeFiles {
  const dir = path.join(root, 'themes', theme);
  if (!fs.existsSync(dir)) throw new Error(`Theme not found: themes/${theme}`);
  const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
  const assets = fs
    .readdirSync(dir)
    .filter((f) => !f.endsWith('.html') && f !== 'theme.json' && fs.statSync(path.join(dir, f)).isFile());
  return { index: read('index.html'), post: read('post.html'), archive: read('archive.html'), page: read('page.html'), assets, dir };
}

function rel(depth: number): string {
  return depth === 0 ? './' : '../'.repeat(depth);
}

function writeOut(outDir: string, relFile: string, html: string): void {
  const full = path.join(outDir, relFile);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, html, 'utf8');
}

export function buildSite(root: string, options: { includeDrafts?: boolean } = {}): BuildResult {
  const config = loadConfig(root);
  const includeDrafts = options.includeDrafts ?? false;
  const theme = loadTheme(root, config.theme);
  const outDir = path.join(root, 'public');
  const posts = collectPosts(root, includeDrafts);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const siteBase = (depth: number): TemplateData => ({
    site: {
      title: config.title,
      author: config.author,
      description: config.description,
      url: config.url,
      language: config.language,
      year: new Date().getFullYear(),
    },
    base: rel(depth),
    generator: 'PJBlog For Finch',
  });

  const postVm = (p: Post, depth: number) => ({
    title: p.title,
    date: p.date,
    dateDisplay: p.dateDisplay,
    year: p.year,
    tags: p.tags.map((t) => ({ name: t, url: `${rel(depth)}tags/${encodeURIComponent(slugify(t))}.html` })),
    hasTags: p.tags.length > 0,
    summary: p.summary,
    url: `${rel(depth)}${p.relUrl}`,
    draft: p.draft,
    contentHtml: p.contentHtml,
  });

  // post pages (depth 2: posts/<year>/x.html)
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const newer = posts[i - 1];
    const older = posts[i + 1];
    const html = renderTemplate(theme.post, {
      ...siteBase(2),
      post: postVm(p, 2),
      prev: older ? { title: older.title, url: `${rel(2)}${older.relUrl}` } : null,
      next: newer ? { title: newer.title, url: `${rel(2)}${newer.relUrl}` } : null,
    });
    writeOut(outDir, p.relUrl, html);
  }

  // index (latest N)
  const latest = posts.slice(0, config.postsPerPage);
  writeOut(
    outDir,
    'index.html',
    renderTemplate(theme.index, {
      ...siteBase(0),
      posts: latest.map((p) => postVm(p, 0)),
      hasMore: posts.length > latest.length,
      archiveUrl: 'archive.html',
      totalCount: posts.length,
    }),
  );

  // archive (grouped by year)
  const years = new Map<string, Post[]>();
  for (const p of posts) {
    if (!years.has(p.year)) years.set(p.year, []);
    years.get(p.year)!.push(p);
  }
  const groups = [...years.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([year, ps]) => ({ year, posts: ps.map((p) => postVm(p, 0)), count: ps.length }));
  writeOut(
    outDir,
    'archive.html',
    renderTemplate(theme.archive, { ...siteBase(0), groups, totalCount: posts.length, pageTitle: null }),
  );

  // tag pages (reuse archive template, depth 1: tags/x.html)
  const tags = new Map<string, Post[]>();
  for (const p of posts) {
    for (const t of p.tags) {
      const key = slugify(t);
      if (!tags.has(key)) tags.set(key, []);
      tags.get(key)!.push(p);
    }
  }
  for (const [key, ps] of tags) {
    writeOut(
      outDir,
      `tags/${key}.html`,
      renderTemplate(theme.archive, {
        ...siteBase(1),
        groups: [{ year: `#${ps[0].tags.find((t) => slugify(t) === key) ?? key}`, posts: ps.map((p) => postVm(p, 1)), count: ps.length }],
        totalCount: ps.length,
        pageTitle: `#${key}`,
      }),
    );
  }

  // standalone pages: pages/*.md → <slug>.html
  let pageCount = 0;
  const pagesDir = path.join(root, 'pages');
  for (const file of walkMd(pagesDir)) {
    const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const slug = slugify(path.basename(file, '.md'));
    writeOut(
      outDir,
      `${slug}.html`,
      renderTemplate(theme.page, {
        ...siteBase(0),
        page: { title: (meta.title as string) || slug, contentHtml: renderMarkdown(body) },
      }),
    );
    pageCount++;
  }

  // 404
  writeOut(
    outDir,
    '404.html',
    renderTemplate(theme.page, {
      ...siteBase(0),
      page: { title: '404', contentHtml: '<p>Page not found. <a href="./index.html">Back home</a></p>' },
    }),
  );

  // theme assets
  for (const asset of theme.assets) {
    fs.copyFileSync(path.join(theme.dir, asset), path.join(outDir, asset));
  }

  // user assets/
  const assetsDir = path.join(root, 'assets');
  if (fs.existsSync(assetsDir)) {
    fs.cpSync(assetsDir, path.join(outDir, 'assets'), { recursive: true });
  }

  // rss + sitemap
  writeRss(outDir, config, posts.filter((p) => !p.draft).slice(0, 20));
  writeSitemap(outDir, config, posts.filter((p) => !p.draft), pageCount);

  return {
    outDir,
    postCount: posts.filter((p) => !p.draft).length,
    draftCount: posts.filter((p) => p.draft).length,
    pageCount,
    theme: config.theme,
  };
}

function siteUrl(config: BlogConfig): string {
  return config.url ? config.url.replace(/\/$/, '') : '';
}

function writeRss(outDir: string, config: BlogConfig, posts: Post[]): void {
  const base = siteUrl(config);
  const items = posts
    .map(
      (p) => `  <item>
    <title>${escapeHtml(p.title)}</title>
    <link>${base}/${p.relUrl}</link>
    <guid>${base}/${p.relUrl}</guid>
    <pubDate>${new Date(p.date).toUTCString()}</pubDate>
    <description>${escapeHtml(p.summary)}</description>
  </item>`,
    )
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${escapeHtml(config.title)}</title>
  <link>${base}/</link>
  <description>${escapeHtml(config.description)}</description>
  <language>${config.language}</language>
  <generator>PJBlog For Finch</generator>
${items}
</channel></rss>
`;
  fs.writeFileSync(path.join(outDir, 'rss.xml'), xml, 'utf8');
}

function writeSitemap(outDir: string, config: BlogConfig, posts: Post[], _pageCount: number): void {
  const base = siteUrl(config);
  const urls = ['index.html', 'archive.html', ...posts.map((p) => p.relUrl)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${base}/${u}</loc></url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync(path.join(outDir, 'sitemap.xml'), xml, 'utf8');
}
