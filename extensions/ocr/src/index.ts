/**
 * PP-OCRv6 Finch Extension
 * Uses Python PaddleOCR for high-accuracy OCR of images and PDFs.
 *
 * ── Flow ────────────────────────────────────────────────────────────────────
 * ocr_image → ensureSetup() (auto-installs PaddleOCR + PyMuPDF if needed) → run OCR
 * ocr_pdf   → ensureSetup() → run PDF (per-page OCR, merged output)
 * setup_ocr → diagnostic + fallback manual install
 * ocr_status → quick health check
 */

import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// ── Cache ──────────────────────────────────────────────────────────────────

const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface CacheEntry {
  hash: string;
  text: string;
  confidence: number;
  wasResized?: boolean;
  pages?: Array<{ page: number; text: string; confidence: number }>;
  createdAt: string;
}

/** Index: hash → ISO timestamp.  cacheParent 是 extension-data 或 extensionPath。 */
function idxPath(cacheParent: string): string {
  return join(cacheParent, 'cache', 'index.json');
}
function readIdx(cacheParent: string): Record<string, string> {
  const f = idxPath(cacheParent);
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return {}; }
}
function writeIdx(cacheParent: string, idx: Record<string, string>): void {
  const f = idxPath(cacheParent);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(idx), 'utf-8');
}

function entryPath(cacheParent: string, hash: string): string {
  return join(cacheParent, 'cache', `${hash}.json`);
}

function fileHash(fp: string): string {
  return createHash('sha256').update(readFileSync(fp)).digest('hex');
}

function getCached(cacheParent: string, hash: string): CacheEntry | null {
  const idx = readIdx(cacheParent);
  const ts = idx[hash];
  if (!ts) return null;

  if (Date.now() - new Date(ts).getTime() > CACHE_MAX_AGE_MS) {
    const f = entryPath(cacheParent, hash);
    if (existsSync(f)) unlinkSync(f);
    delete idx[hash];
    writeIdx(cacheParent, idx);
    return null;
  }

  const f = entryPath(cacheParent, hash);
  if (!existsSync(f)) {
    delete idx[hash];
    writeIdx(cacheParent, idx);
    return null;
  }

  try {
    return JSON.parse(readFileSync(f, 'utf-8')) as CacheEntry;
  } catch {
    delete idx[hash];
    writeIdx(cacheParent, idx);
    return null;
  }
}

function setCached(cacheParent: string, hash: string, entry: Omit<CacheEntry, 'hash' | 'createdAt'>): void {
  const now = new Date().toISOString();
  const full: CacheEntry = { ...entry, hash, createdAt: now };

  const f = entryPath(cacheParent, hash);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(full), 'utf-8');

  const idx = readIdx(cacheParent);
  idx[hash] = now;

  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  for (const [h, ts] of Object.entries(idx)) {
    if (new Date(ts).getTime() < cutoff) {
      const ef = entryPath(cacheParent, h);
      if (existsSync(ef)) unlinkSync(ef);
      delete idx[h];
    }
  }

  writeIdx(cacheParent, idx);
}

function storagePath(ctx: any): string {
  return ctx.extension.extensionPath;
}

// ── Async Task Management ──────────────────────────────────────────────────

interface TaskStatus {
  hash: string;
  type: 'image' | 'pdf';
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  estimatedSeconds: number;
  resultFile: string;
  errorFile: string;
}

interface PdfProgress {
  totalPages: number;
  pages: Array<{ page: number; text: string; confidence: number }>;
  /** Per-page moving average estimate of remaining seconds. */
  dynamicEstimateSeconds?: number;
}

function taskDir(cacheParent: string, hash: string): string {
  return join(cacheParent, 'cache', 'tasks', hash);
}
function taskStatusFile(cacheParent: string, hash: string): string {
  return join(taskDir(cacheParent, hash), 'status.json');
}
function taskResultFile(cacheParent: string, hash: string): string {
  return join(taskDir(cacheParent, hash), 'result.json');
}
function taskErrorFile(cacheParent: string, hash: string): string {
  return join(taskDir(cacheParent, hash), 'error.log');
}
function taskProgressFile(cacheParent: string, hash: string): string {
  return join(taskDir(cacheParent, hash), 'progress.json');
}

/**
 * Start an OCR task in the background.
 * For images: collects all stdout, parses JSON on close.
 * For PDFs: streams NDJSON lines, writes progress per page.
 */
function startOcrTask(
  cacheParent: string,
  pythonCmd: string,
  scriptPath: string,
  filePath: string,
  hash: string,
  type: 'image' | 'pdf',
  estimatedSeconds: number,
): TaskStatus {
  const createdAt = new Date().toISOString();
  const tDir = taskDir(cacheParent, hash);
  const rFile = taskResultFile(cacheParent, hash);
  const eFile = taskErrorFile(cacheParent, hash);
  mkdirSync(tDir, { recursive: true });

  const task: TaskStatus = {
    hash, type, status: 'running', createdAt, estimatedSeconds,
    resultFile: rFile, errorFile: eFile,
  };
  writeFileSync(taskStatusFile(cacheParent, hash), JSON.stringify(task), 'utf-8');

  const args = type === 'pdf'
    ? [scriptPath, filePath, '--pdf']
    : [scriptPath, filePath];
  const proc = spawn(pythonCmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  if (type === 'pdf') {
    // ── PDF: NDJSON streaming ──
    const progress: PdfProgress = { totalPages: 0, pages: [] };
    const startTime = Date.now();
    let buf = '';
    let finalized = false;

    function updateEstimate() {
      const elapsed = (Date.now() - startTime) / 1000;
      const done = progress.pages.length;
      if (done > 0 && progress.totalPages > done) {
        const avgPerPage = elapsed / done;
        progress.dynamicEstimateSeconds = Math.round(avgPerPage * (progress.totalPages - done));
      }
    }

    function finalizePdf() {
      if (finalized) return;
      finalized = true;
      progress.pages.sort((a, b) => a.page - b.page);

      const mdLines: string[] = ['## OCR Result\n'];
      if (progress.pages.length) {
        for (const pg of progress.pages) {
          mdLines.push(`### 📄 Page ${pg.page}`);
          if (pg.confidence > 0) mdLines.push(`> Confidence: **${(pg.confidence * 100).toFixed(1)}%**`);
          mdLines.push('', pg.text || '*No text detected*', '');
        }
      } else {
        mdLines.push('No text detected in the PDF.');
      }
      const total = progress.totalPages || progress.pages.length;
      const withText = progress.pages.filter(p => p.confidence > 0).length;
      const markdown = mdLines.join('\n') + `\n---\n> *Processed **${total}** pages: ${withText} with text, ${total - withText} blank*`;

      setCached(cacheParent, hash, {
        text: markdown, confidence: 0,
        pages: progress.pages.map(p => ({ ...p })),
      });
      writeFileSync(rFile, markdown, 'utf-8');

      task.status = 'completed';
      writeFileSync(taskStatusFile(cacheParent, hash), JSON.stringify(task), 'utf-8');
    }

    proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || ''; // keep partial line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'meta') {
            progress.totalPages = msg.total_pages;
            writeFileSync(taskProgressFile(cacheParent, hash), JSON.stringify(progress), 'utf-8');
          } else if (msg.type === 'page') {
            progress.pages.push({
              page: msg.page,
              text: (msg.lines || []).join('\n'),
              confidence: msg.confidence || 0,
            });
            updateEstimate();
            writeFileSync(taskProgressFile(cacheParent, hash), JSON.stringify(progress), 'utf-8');
          } else if (msg.type === 'done') {
            finalizePdf();
          }
        } catch { /* skip unparseable line */ }
      }
    });

    proc.stderr!.on('data', (d: Buffer) => {
      appendFileSync(eFile, d.toString(), 'utf-8');
    });

    proc.on('close', (code) => {
      if (!finalized) {
        if (code !== 0) {
          task.status = 'failed';
          writeFileSync(taskStatusFile(cacheParent, hash), JSON.stringify(task), 'utf-8');
        } else {
          // Process exited without a 'done' message — try to finalize anyway
          finalizePdf();
          if (progress.pages.length === 0) {
            const md = '## OCR Result\n\nNo text detected in the PDF.\n\n---\n> *Processed **0** pages*';
            setCached(cacheParent, hash, { text: md, confidence: 0, pages: [] });
            writeFileSync(rFile, md, 'utf-8');
            task.status = 'completed';
            writeFileSync(taskStatusFile(cacheParent, hash), JSON.stringify(task), 'utf-8');
          }
        }
      }
    });

    proc.on('error', (err) => {
      appendFileSync(eFile, `Process error: ${err.message}`, 'utf-8');
      task.status = 'failed';
      writeFileSync(taskStatusFile(cacheParent, hash), JSON.stringify(task), 'utf-8');
    });

  } else {
    // ── Image: collect stdout, parse on close ──
    let stdout = '';
    const stderrChunks: Buffer[] = [];
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderrChunks.push(d); });

    proc.on('close', (code) => {
      if (stderrChunks.length > 0) {
        writeFileSync(eFile, Buffer.concat(stderrChunks).toString(), 'utf-8');
      }
      if (code !== 0) {
        task.status = 'failed';
        writeFileSync(taskStatusFile(cacheParent, hash), JSON.stringify(task), 'utf-8');
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) {
          writeFileSync(eFile, parsed.error, 'utf-8');
          task.status = 'failed';
          writeFileSync(taskStatusFile(cacheParent, hash), JSON.stringify(task), 'utf-8');
          return;
        }
        const mdLines: string[] = ['## OCR Result\n'];
        if (parsed.resized) mdLines.push('> ℹ️ Large image was scaled down for processing.\n');
        mdLines.push(parsed.lines?.join('\n') || 'No text detected in the image.');
        if (parsed.confidence > 0) mdLines.push('', `> Confidence: **${(parsed.confidence * 100).toFixed(1)}%**`);
        const markdown = mdLines.join('\n');

        setCached(cacheParent, hash, { text: markdown, confidence: parsed.confidence ?? 0, wasResized: parsed.resized });
        writeFileSync(rFile, markdown, 'utf-8');
        task.status = 'completed';
        writeFileSync(taskStatusFile(cacheParent, hash), JSON.stringify(task), 'utf-8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeFileSync(eFile, `Parse error: ${msg}\nRaw: ${stdout.slice(0, 500)}`, 'utf-8');
        task.status = 'failed';
        writeFileSync(taskStatusFile(cacheParent, hash), JSON.stringify(task), 'utf-8');
      }
    });

    proc.on('error', (err) => {
      writeFileSync(eFile, `Process error: ${err.message}`, 'utf-8');
      task.status = 'failed';
      writeFileSync(taskStatusFile(cacheParent, hash), JSON.stringify(task), 'utf-8');
    });
  }

  return task;
}

/**
 * Poll a task's status. For running PDF tasks, returns progress with partial text.
 * Cleans up task directory on completion or failure.
 */
function checkTask(cacheParent: string, hash: string): { status: string; text: string } {
  const sf = taskStatusFile(cacheParent, hash);
  if (!existsSync(sf)) {
    const cached = getCached(cacheParent, hash);
    if (cached) return { status: 'completed', text: cached.text };
    return { status: 'not_found', text: '没有找到对应的任务或缓存。' };
  }

  const task: TaskStatus = JSON.parse(readFileSync(sf, 'utf-8'));
  const elapsed = Math.floor((Date.now() - new Date(task.createdAt).getTime()) / 1000);

  if (task.status === 'running') {
    // Check for PDF progress
    const pf = taskProgressFile(cacheParent, hash);
    if (task.type === 'pdf' && existsSync(pf)) {
      const prog: PdfProgress = JSON.parse(readFileSync(pf, 'utf-8'));
      const done = prog.pages.length;
      const total = prog.totalPages || '?';
      const remaining = prog.dynamicEstimateSeconds ?? Math.max(0, task.estimatedSeconds - elapsed);

      if (done > 0) {
        const mdParts: string[] = [
          `## PDF OCR 进行中\n\n已完成 **${done}**/${total} 页，已耗时 **${elapsed}s**，预计还需 **~${remaining}s**\n`,
        ];
        // Show last few pages as a preview
        const show = prog.pages.slice(Math.max(0, done - 3));
        for (const pg of show) {
          mdParts.push(`### 📄 Page ${pg.page}`);
          if (pg.confidence > 0) mdParts.push(`> Confidence: **${(pg.confidence * 100).toFixed(1)}%**`);
          mdParts.push('', pg.text.slice(0, 200) || '*No text detected*', '');
        }
        return { status: 'running', text: mdParts.join('\n') };
      }
    }

    const remaining = Math.max(0, task.estimatedSeconds - elapsed);
    return {
      status: 'running',
      text: `## OCR 任务进行中\n\n- 已耗时: **${elapsed}s**\n- 预计还需: **~${remaining}s**\n\n请稍后再查。`,
    };
  }

  if (task.status === 'failed') {
    const errLog = existsSync(task.errorFile) ? readFileSync(task.errorFile, 'utf-8').trim() : 'Unknown error';
    rmSync(taskDir(cacheParent, hash), { recursive: true, force: true });
    return { status: 'failed', text: `## OCR 任务失败\n\n\`\`\`\n${errLog}\n\`\`\`` };
  }

  // completed
  let result = '';
  if (existsSync(task.resultFile)) {
    result = readFileSync(task.resultFile, 'utf-8');
  } else {
    const cached = getCached(cacheParent, hash);
    if (cached) result = cached.text;
  }
  rmSync(taskDir(cacheParent, hash), { recursive: true, force: true });
  return { status: 'completed', text: result };
}

// ── Python Constants ────────────────────────────────────────────────────────

const PYTHON_MIN = [3, 10];
const PYTHON_MAX = [3, 12];
const DEFAULT_VENV = join(tmpdir(), 'ocr-venv');

// ── Python Utilities ────────────────────────────────────────────────────────

function isVersionInRange(v: string): boolean {
  const m = v.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const [mj, mn] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  return !(mj < PYTHON_MIN[0] || (mj === PYTHON_MIN[0] && mn < PYTHON_MIN[1])
    || mj > PYTHON_MAX[0] || (mj === PYTHON_MAX[0] && mn > PYTHON_MAX[1]));
}

function venvPython(v: string): string {
  return process.platform === 'win32' ? join(v, 'Scripts', 'python.exe') : join(v, 'bin', 'python');
}

function pyVersion(cmd: string): string | null {
  const r = spawnSync(cmd, ['--version'], { stdio: 'pipe', encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function findPython(): { cmd: string; version: string } | null {
  // Prefer existing venv — but only if it has all dependencies
  const vp = venvPython(DEFAULT_VENV);
  if (existsSync(vp)) {
    const ver = pyVersion(vp);
    const hasDeps = checkPaddle(vp) !== null && checkPyMuPDF(vp);
    if (ver && isVersionInRange(ver) && hasDeps) {
      return { cmd: vp, version: ver };
    }
  }

  for (const c of ['python3.12', 'python3.11', 'python3.10', 'python3', 'python']) {
    const ver = pyVersion(c);
    if (ver && isVersionInRange(ver)) return { cmd: c, version: ver };
  }
  return null;
}

function checkPaddle(cmd: string): string | null {
  const r = spawnSync(cmd, ['-c', 'import paddleocr; print(paddleocr.__version__)'], { stdio: 'pipe', encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function checkPyMuPDF(cmd: string): boolean {
  const r = spawnSync(cmd, ['-c', 'import fitz'], { stdio: 'pipe', encoding: 'utf-8' });
  return r.status === 0;
}

function createVenv(cmd: string): void {
  const r = spawnSync(cmd, ['-m', 'venv', DEFAULT_VENV], { timeout: 60_000, stdio: 'pipe', encoding: 'utf-8' });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim() || 'Failed to create virtual environment');
}

function pipInstall(pyCmd: string): void {
  const r = spawnSync(pyCmd, ['-m', 'pip', 'install', 'paddleocr', 'paddlepaddle', 'PyMuPDF', 'opencv-python', 'numpy', '--timeout', '120'], {
    timeout: 300_000, stdio: 'pipe', encoding: 'utf-8',
  });
  if (r.status !== 0) {
    const timedOut = (r.error as { code?: string } | null)?.code === 'ETIMEDOUT'
      || (r.stderr || '').toLowerCase().includes('timeout');
    throw new Error(timedOut ? 'Download timeout' : (r.stderr || r.stdout || '').trim() || 'pip install failed');
  }
}

// ── Ensure Setup (shared auto-install) ─────────────────────────────────────

interface SetupResult {
  cmd: string;       // Python command ready for inference
  version: string;   // Python version
  paddleVersion: string; // Installed PaddleOCR version
}

/**
 * Ensure Python 3.10-3.12 and PaddleOCR are ready for OCR.
 *
 * Auto-installs PaddleOCR into a virtual environment when Python is available
 * but PaddleOCR is missing. On success, returns the Python cmd to use.
 *
 * Throws with actionable guidance on failure.
 */
function ensureSetup(): SetupResult {
  const python = findPython();
  if (!python) {
    throw new SetupError(
      'Python 3.10-3.12 not found.',
      [
        '**To install Python 3.12:**',
        '• macOS: `brew install python@3.12`',
        '• Ubuntu/Debian: `sudo apt install python3.12`',
        '• Windows: Download from https://www.python.org/downloads/',
        '',
        'After installing Python, share an image and it will work automatically.',
      ].join('\n'),
    );
  }

  const paddleVer = checkPaddle(python.cmd);
  if (paddleVer) {
    return { cmd: python.cmd, version: python.version, paddleVersion: paddleVer };
  }

  // PaddleOCR missing — auto-install into a venv
  const vp = venvPython(DEFAULT_VENV);
  try {
    if (!existsSync(DEFAULT_VENV) || !existsSync(vp)) createVenv(python.cmd);
    pipInstall(vp);

    const v = checkPaddle(vp);
    if (!v) throw new Error('Verification failed after pip install.');

    return { cmd: vp, version: python.version, paddleVersion: v };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('timeout') || msg.includes('TIMEOUT')) {
      throw new SetupError(
        'Download timed out — PaddleOCR is large (~200 MB).',
        [
          '**Try again** — sometimes a retry works.',
          '',
          '**If you are in mainland China,** use a PyPI mirror:',
          '```bash',
          `${python.cmd} -m venv ${DEFAULT_VENV}`,
          `${vp} -m pip install paddleocr paddlepaddle -i https://pypi.tuna.tsinghua.edu.cn/simple`,
          '```',
          '',
          'Or install manually in terminal:',
          '```bash',
          `${python.cmd} -m venv ${DEFAULT_VENV}`,
          `${vp} -m pip install paddleocr paddlepaddle`,
          '```',
          '',
          'After installing, share an image again.',
        ].join('\n'),
      );
    }
    throw new SetupError(
      'Auto-installation failed.',
      [
        `**Error:** ${msg}`,
        '',
        '**Install manually in terminal:**',
        '```bash',
        `${python.cmd} -m venv ${DEFAULT_VENV}`,
        `${vp} -m pip install paddleocr paddlepaddle`,
        '```',
        '',
        'After installing, share an image again.',
      ].join('\n'),
    );
  }
}

class SetupError extends Error {
  userMessage: string;
  constructor(summary: string, detail: string) {
    super(summary);
    this.name = 'SetupError';
    this.userMessage = detail;
  }
}

// ── OCR Runner ──────────────────────────────────────────────────────────────

// ── Tools ───────────────────────────────────────────────────────────────────

function registerSetupTool(ctx: any): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'setup_ocr',
    title: 'Set up PP-OCRv6',
    description: 'Check Python environment and install PaddleOCR. Used for diagnostics or manual setup.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'medium',
    async execute() {
      const lines: string[] = ['## PP-OCRv6 Setup\n'];

      // ── Python ──
      const python = findPython();
      if (!python) {
        const wrong = ['python3.14', 'python3.13', 'python3.9', 'python3.8', 'python3', 'python']
          .map(c => ({ cmd: c, ver: pyVersion(c) }))
          .find(x => x.ver);
        if (wrong) {
          const m = wrong.ver!.match(/(\d+)\.(\d+)/);
          const [mj, mn] = m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [0, 0];
          const tooNew = mj > 3 || (mj === 3 && mn > 12);
          lines.push(`❌ **Python version too ${tooNew ? 'new' : 'old'}:** ${wrong.ver}`);
          lines.push('');
          lines.push('**Required:** Python 3.10 – 3.12');
          if (tooNew) lines.push('PaddlePaddle does not support Python 3.13+ yet.');
          lines.push('');
          lines.push('**Install Python 3.12** and run setup_ocr again.');
        } else {
          lines.push('❌ **Python not found**');
          lines.push('');
          lines.push('**Required:** Python 3.10 – 3.12');
          lines.push('• **macOS:** `brew install python@3.12`');
          lines.push('• **Ubuntu/Debian:** `sudo apt install python3.12`');
          lines.push('• **Windows:** Download from https://www.python.org/downloads/');
          lines.push('');
          lines.push('After installing Python, run setup_ocr again.');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
      }

      lines.push(`✅ **Python:** ${python.cmd} (${python.version})`);

      // ── PaddleOCR (reuse ensureSetup for consistent auto-install) ──
      try {
        const result = ensureSetup();
        lines.push(`✅ **PaddleOCR:** installed (v${result.paddleVersion})`);
      } catch (err) {
        if (err instanceof SetupError) {
          lines.push(`❌ **PaddleOCR:** ${err.message}`);
          lines.push('');
          lines.push(err.userMessage);
          return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
        }
        lines.push(`❌ **Installation failed:** ${err instanceof Error ? err.message : String(err)}`);
        lines.push('');
        lines.push('**Install manually in terminal:**');
        lines.push('```bash');
        lines.push(`${python.cmd} -m venv "${DEFAULT_VENV}"`);
        lines.push(`"${venvPython(DEFAULT_VENV)}" -m pip install paddleocr paddlepaddle`);
        lines.push('```');
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
      }

      // ── Script ──
      const sp = join(ctx.extension.extensionPath, 'scripts', 'ocr.py');
      lines.push(existsSync(sp) ? '✅ **OCR Script:** found' : '❌ **OCR Script:** not found — reinstall the extension');

      lines.push('');
      lines.push('**All set.** Share an image to extract text.');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  }));
}

function registerStatusTool(ctx: any): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'ocr_status',
    title: 'OCR Status',
    description: 'Quickly check PP-OCRv6 readiness: Python version, PaddleOCR installation, and script availability.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'low',
    async execute() {
      const lines: string[] = ['## PP-OCRv6 Status\n'];
      const python = findPython();

      if (python) {
        lines.push(`✅ **Python:** ${python.cmd} (${python.version})`);
        const pv = checkPaddle(python.cmd);
        lines.push(`**PaddleOCR:** ${pv ? `✅ ${pv}` : '❌ not installed'}`);
      } else {
        const fallback = ['python3', 'python', 'python3.13', 'python3.9']
          .map(c => ({ cmd: c, ver: pyVersion(c) }))
          .find(x => x.ver);
        lines.push(`❌ **Python:** not found — need 3.10–3.12`);
        if (fallback) lines.push(`   (detected ${fallback.ver} at ${fallback.cmd} — incompatible)`);
      }

      const sp = join(ctx.extension.extensionPath, 'scripts', 'ocr.py');
      lines.push(`**OCR Script:** ${existsSync(sp) ? '✅ found' : '❌ not found'}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  }));
}

function registerCacheStatusTool(ctx: any): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'ocr_cache',
    title: 'OCR Cache',
    description: 'View cached OCR results: entry count, expiry info, and option to clear cache.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'low',
    async execute() {
      const lines: string[] = ['## OCR Cache\n'];
      const stPath = storagePath(ctx);
      const idx = readIdx(stPath);
      const hashes = Object.keys(idx);
      const now = Date.now();
      let validCount = 0;

      if (hashes.length === 0) {
        lines.push('No cached results.');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      lines.push(`| # | Type | Hash | Created | Expires |`);
      lines.push('|---|------|------|---------|---------|');

      for (let i = 0; i < hashes.length; i++) {
        const h = hashes[i];
        const ts = idx[h];
        const file = entryPath(stPath, h);
        if (!existsSync(file)) continue;
        try {
          const entry = JSON.parse(readFileSync(file, 'utf-8')) as CacheEntry;
          const age = now - new Date(entry.createdAt).getTime();
          if (age > CACHE_MAX_AGE_MS) continue;
          validCount++;
          const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));
          const ageHours = Math.floor((age % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
          const expiresIn = Math.max(0, 30 - ageDays);
          const type = entry.pages ? 'PDF' : 'Image';
          const shortHash = h.slice(0, 12);
          const dateStr = ts.slice(0, 10);
          lines.push(`| ${validCount} | ${type} | \`${shortHash}…\` | ${dateStr} | ${expiresIn}d |`);
        } catch { /* skip unreadable */ }
      }

      if (validCount === 0) {
        lines.push('No cached results.');
      } else {
        lines.push('');
        lines.push(`**Total:** ${validCount} entries`);
        lines.push('');
        lines.push(`Cache root: \`${join(stPath, 'cache')}\``);
        lines.push('');
        lines.push('To clear all cache, call \`clear_ocr_cache\`.');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  }));
}

function registerClearCacheTool(ctx: any): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'clear_ocr_cache',
    title: 'Clear OCR Cache',
    description: 'Delete all cached OCR results.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'medium',
    async execute() {
      const root = join(storagePath(ctx), 'cache');
      if (existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
      }
      return { content: [{ type: 'text', text: 'OCR 缓存已清空。' }] };
    },
  }));
}

function registerOcrImageTool(ctx: any): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'ocr_image',
    title: 'OCR Image',
    description: 'Extract text from an image using PP-OCRv6. Handles setup automatically — just provide the image path.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Absolute path to the image file' },
      },
      required: ['imagePath'],
    },
    risk: 'low',
    async execute(input: any) {
      const imagePath = String((input as any).imagePath ?? '').trim();
      if (!imagePath) {
        return { content: [{ type: 'text', text: 'Please provide the image path.' }], isError: true };
      }
      if (!existsSync(imagePath)) {
        return { content: [{ type: 'text', text: `File not found: ${imagePath}` }], isError: true };
      }

      const scriptPath = join(ctx.extension.extensionPath, 'scripts', 'ocr.py');
      if (!existsSync(scriptPath)) {
        return { content: [{ type: 'text', text: 'OCR script missing. Please reinstall the extension.' }], isError: true };
      }

      const hash = fileHash(imagePath);
      const stPath = storagePath(ctx);

      // ── Cache check ──
      const cached = getCached(stPath, hash);
      if (cached) {
        ctx.logger.debug(`Cache hit for ${imagePath}`);
        return { content: [{ type: 'text', text: cached.text }] };
      }

      // ── Check if already running ──
      const sf = taskStatusFile(stPath, hash);
      if (existsSync(sf)) {
        const existing = JSON.parse(readFileSync(sf, 'utf-8')) as TaskStatus;
        if (existing.status === 'running') {
          const elapsed = Math.floor((Date.now() - new Date(existing.createdAt).getTime()) / 1000);
          return { content: [{ type: 'text', text: `OCR 任务已在运行中（已耗时 ${elapsed}s）。使用 \`check_ocr_task\` 查询进度（任务 ID: \`${hash}\`）。` }] };
        }
      }

      // ── Start async task ──
      try {
        const setup = ensureSetup();
        const estimatedSec = 15;
        const task = startOcrTask(stPath, setup.cmd, scriptPath, imagePath, hash, 'image', estimatedSec);

        return {
          content: [{
            type: 'text',
            text: [
              '## OCR 任务已启动\n',
              '| 字段 | 值 |',
              '|---|----|',
              `| 任务 ID | \`${hash}\` |`,
              `| 类型 | 图片 |`,
              `| 状态 | 运行中 |`,
              `| 创建时间 | ${new Date(task.createdAt).toLocaleString()} |`,
              `| 预计 | ~${estimatedSec} 秒 |`,
              `| 结果文件 | \`${task.resultFile}\` |`,
              `| 错误日志 | \`${task.errorFile}\` |`,
              '',
              `约 ${estimatedSec} 秒后使用 \`check_ocr_task\` 查询结果（传入任务 ID）。`,
            ].join('\n'),
          }],
        };
      } catch (err) {
        if (err instanceof SetupError) {
          return { content: [{ type: 'text', text: err.userMessage }], isError: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('PaddleOCR') || msg.includes('No module')) {
          return { content: [{ type: 'text', text: `OCR engine not ready: ${msg}\n\nRun \`setup_ocr\` to check the environment.` }], isError: true };
        }
        return { content: [{ type: 'text', text: `OCR failed: ${msg}` }], isError: true };
      }
    },
  }));
}

function registerOcrPdfTool(ctx: any): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'ocr_pdf',
    title: 'OCR PDF',
    description: 'Extract text from a PDF by OCR-ing each page using PP-OCRv6. Good for scanned PDFs without selectable text. Handles setup automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: { type: 'string', description: 'Absolute path to the PDF file' },
      },
      required: ['pdfPath'],
    },
    risk: 'low',
    async execute(input: any) {
      const pdfPath = String((input as any).pdfPath ?? '').trim();
      if (!pdfPath) {
        return { content: [{ type: 'text', text: '请提供 PDF 文件路径。' }], isError: true };
      }
      if (!existsSync(pdfPath)) {
        return { content: [{ type: 'text', text: `文件不存在: ${pdfPath}` }], isError: true };
      }

      const scriptPath = join(ctx.extension.extensionPath, 'scripts', 'ocr.py');
      if (!existsSync(scriptPath)) {
        return { content: [{ type: 'text', text: 'OCR 脚本缺失，请重新安装扩展。' }], isError: true };
      }

      const hash = fileHash(pdfPath);
      const stPath = storagePath(ctx);

      // ── Cache check ──
      const cached = getCached(stPath, hash);
      if (cached) {
        ctx.logger.debug(`Cache hit for PDF ${pdfPath}`);
        return { content: [{ type: 'text', text: cached.text }] };
      }

      // ── Check if already running ──
      const sf = taskStatusFile(stPath, hash);
      if (existsSync(sf)) {
        const existing = JSON.parse(readFileSync(sf, 'utf-8')) as TaskStatus;
        if (existing.status === 'running') {
          const elapsed = Math.floor((Date.now() - new Date(existing.createdAt).getTime()) / 1000);
          return { content: [{ type: 'text', text: `PDF OCR 任务已在运行中（已耗时 ${elapsed}s）。使用 \`check_ocr_task\` 查询进度（任务 ID: \`${hash}\`）。` }] };
        }
      }

      // ── Start async task ──
      try {
        const setup = ensureSetup();
        const estimatedSec = 60;
        const task = startOcrTask(stPath, setup.cmd, scriptPath, pdfPath, hash, 'pdf', estimatedSec);

        return {
          content: [{
            type: 'text',
            text: [
              '## PDF OCR 任务已启动\n',
              '| 字段 | 值 |',
              '|---|----|',
              `| 任务 ID | \`${hash}\` |`,
              `| 类型 | PDF |`,
              `| 状态 | 运行中 |`,
              `| 创建时间 | ${new Date(task.createdAt).toLocaleString()} |`,
              `| 预计 | ~${estimatedSec} 秒（大文件可能更久） |`,
              `| 结果文件 | \`${task.resultFile}\` |`,
              `| 错误日志 | \`${task.errorFile}\` |`,
              '',
              '稍后使用 \`check_ocr_task\` 查询结果（传入任务 ID）。',
            ].join('\n'),
          }],
        };
      } catch (err) {
        if (err instanceof SetupError) {
          return { content: [{ type: 'text', text: err.userMessage }], isError: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('PyMuPDF')) {
          return { content: [{ type: 'text', text: `PDF 解析库未安装: ${msg}\n\n运行 \`setup_ocr\` 重新安装全部依赖。` }], isError: true };
        }
        return { content: [{ type: 'text', text: `PDF OCR 失败: ${msg}` }], isError: true };
      }
    },
  }));
}

function registerCheckOcrTaskTool(ctx: any): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'check_ocr_task',
    title: 'Check OCR Task',
    description: 'Check the status of an async OCR task and retrieve results when done. Pass the task ID (SHA-256 hash) returned by ocr_image or ocr_pdf.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID (SHA-256 hash returned by ocr_image or ocr_pdf)' },
      },
      required: ['taskId'],
    },
    risk: 'low',
    async execute(input: any) {
      const hash = String((input as any).taskId ?? '').trim();
      if (!hash) {
        return { content: [{ type: 'text', text: '请提供任务 ID。' }], isError: true };
      }

      const result = checkTask(storagePath(ctx), hash);

      if (result.status === 'running') {
        return { content: [{ type: 'text', text: result.text }] };
      }
      if (result.status === 'failed') {
        return { content: [{ type: 'text', text: result.text }], isError: true };
      }
      if (result.status === 'not_found') {
        return { content: [{ type: 'text', text: result.text }], isError: true };
      }
      // completed
      if (result.text) {
        return { content: [{ type: 'text', text: result.text }] };
      }
      return { content: [{ type: 'text', text: '没有找到对应的任务或缓存。' }], isError: true };
    },
  }));
}

// ── Activation ──────────────────────────────────────────────────────────────

export async function activate(ctx: any): Promise<void> {
  ctx.logger.info('PP-OCRv6 extension activating...');
  registerSetupTool(ctx);
  registerStatusTool(ctx);
  registerCacheStatusTool(ctx);
  registerClearCacheTool(ctx);
  registerOcrImageTool(ctx);
  registerOcrPdfTool(ctx);
  registerCheckOcrTaskTool(ctx);
  ctx.logger.info('PP-OCRv6 extension activated — async OCR ready');
}

export function deactivate(): void {
  // Nothing to clean up
}
