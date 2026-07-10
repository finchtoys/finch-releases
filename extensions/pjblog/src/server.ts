import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { buildSite } from './build.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const LIVE_SCRIPT = `<script>(function(){
  var es = new EventSource('/__pjblog/events');
  es.addEventListener('reload', function(){ location.reload(); });
  es.onerror = function(){ /* server stopped; keep silent */ };
})();</script>`;

export interface PreviewStatus {
  running: boolean;
  port?: number;
  url?: string;
  root?: string;
  lastBuildAt?: string;
  lastBuildError?: string;
}

type Logger = { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };

class PreviewServer {
  private server?: http.Server;
  private watchers: fs.FSWatcher[] = [];
  private sseClients = new Set<http.ServerResponse>();
  private debounceTimer?: NodeJS.Timeout;
  private status: PreviewStatus = { running: false };
  onStatusChange?: () => void;

  getStatus(): PreviewStatus {
    return { ...this.status };
  }

  async start(root: string, logger: Logger): Promise<PreviewStatus> {
    if (this.status.running && this.status.root === root) return this.getStatus();
    await this.stop();

    // initial build (drafts visible in preview)
    this.rebuild(root, logger);

    const outDir = path.join(root, 'public');
    const server = http.createServer((req, res) => this.handle(req, res, outDir));
    const port = await listen(server, 4321);
    this.server = server;
    this.status = { running: true, port, url: `http://localhost:${port}/`, root, lastBuildAt: new Date().toISOString() };
    this.watch(root, logger);
    logger.info(`preview server started at ${this.status.url}`);
    this.onStatusChange?.();
    return this.getStatus();
  }

  async stop(): Promise<void> {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const c of this.sseClients) c.end();
    this.sseClients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    if (this.status.running) {
      this.status = { running: false };
      this.onStatusChange?.();
    }
  }

  private rebuild(root: string, logger: Logger): void {
    try {
      buildSite(root, { includeDrafts: true });
      this.status.lastBuildAt = new Date().toISOString();
      this.status.lastBuildError = undefined;
    } catch (err) {
      this.status.lastBuildError = err instanceof Error ? err.message : String(err);
      logger.error('preview build failed:', this.status.lastBuildError);
    }
  }

  private watch(root: string, logger: Logger): void {
    const targets = ['posts', 'pages', 'themes', 'assets', 'blog.config.json'];
    for (const t of targets) {
      const full = path.join(root, t);
      if (!fs.existsSync(full)) continue;
      try {
        const watcher = fs.watch(full, { recursive: true }, () => {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.rebuild(root, logger);
            this.broadcast('reload');
          }, 300);
        });
        this.watchers.push(watcher);
      } catch (err) {
        logger.warn(`watch failed for ${t}:`, err);
      }
    }
  }

  private broadcast(event: string): void {
    for (const res of this.sseClients) {
      res.write(`event: ${event}\ndata: ${Date.now()}\n\n`);
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, outDir: string): void {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);

    if (urlPath === '/__pjblog/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    let filePath = path.normalize(path.join(outDir, urlPath));
    if (!filePath.startsWith(outDir)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
      const notFound = path.join(outDir, '404.html');
      if (fs.existsSync(notFound)) filePath = notFound;
      else {
        res.writeHead(404).end('Not Found');
        return;
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    if (ext === '.html') {
      let html = fs.readFileSync(filePath, 'utf8');
      html = html.includes('</body>') ? html.replace('</body>', `${LIVE_SCRIPT}</body>`) : html + LIVE_SCRIPT;
      res.end(html);
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
  }
}

function listen(server: http.Server, startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const tryListen = () => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port < startPort + 50) {
          port++;
          tryListen();
        } else reject(err);
      });
      server.listen(port, '127.0.0.1', () => resolve(port));
    };
    tryListen();
  });
}

export const previewServer = new PreviewServer();

export function openInBrowser(url: string, platform: string): void {
  if (platform === 'darwin') execFile('open', [url]);
  else if (platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  else execFile('xdg-open', [url]);
}
