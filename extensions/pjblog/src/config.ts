import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BlogConfig {
  title: string;
  author: string;
  description: string;
  /** Site base url, e.g. https://me.github.io/blog — used for RSS/sitemap. */
  url: string;
  theme: string;
  postsPerPage: number;
  language: string;
  publish: {
    /** 'workflow' → push source, GitHub Actions deploys public/; 'branch' → push public/ to gh-pages; 'none' */
    mode: 'workflow' | 'branch' | 'none';
    remote: string;
    branch: string;
  };
}

export const CONFIG_FILE = 'blog.config.json';

export const DEFAULT_CONFIG: BlogConfig = {
  title: 'My Blog',
  author: '',
  description: '',
  url: '',
  theme: 'plain',
  postsPerPage: 10,
  language: 'zh-CN',
  publish: { mode: 'workflow', remote: 'origin', branch: 'main' },
};

/** Walk up from `start` to find the nearest directory containing blog.config.json. */
export function findBlogRoot(start: string | undefined): string | undefined {
  if (!start) return undefined;
  let dir = path.resolve(start);
  for (let n = 0; n < 12; n++) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // also check one level down (cwd may be the parent workspace)
  try {
    for (const entry of fs.readdirSync(path.resolve(start), { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(path.resolve(start), entry.name, CONFIG_FILE))) {
        return path.join(path.resolve(start), entry.name);
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function loadConfig(root: string): BlogConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8')) as Partial<BlogConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    publish: { ...DEFAULT_CONFIG.publish, ...(raw.publish ?? {}) },
  };
}

export function saveConfig(root: string, config: BlogConfig): void {
  fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n', 'utf8');
}
