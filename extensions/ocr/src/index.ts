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

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Constants ───────────────────────────────────────────────────────────────

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
  // Prefer existing venv
  const vp = venvPython(DEFAULT_VENV);
  if (existsSync(vp)) {
    const ver = pyVersion(vp);
    if (ver && isVersionInRange(ver)) return { cmd: vp, version: ver };
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

function runOcrScript(pythonCmd: string, scriptPath: string, imagePath: string): { text: string; confidence: number; wasResized?: boolean } {
  const r = spawnSync(pythonCmd, [scriptPath, imagePath], {
    timeout: 120_000, stdio: 'pipe', encoding: 'utf-8',
  });

  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || '').trim() || 'OCR process failed');
  }

  const parsed = JSON.parse(r.stdout.trim());
  if (parsed.error) throw new Error(parsed.error);

  if (parsed.lines?.length > 0) {
    return { text: parsed.lines.join('\n'), confidence: parsed.confidence || 0, wasResized: parsed.resized };
  }
  return { text: 'No text detected in the image.', confidence: 0 };
}

/** Run OCR on a PDF — the script handles per-page rendering and merging. */
function runOcrPdfScript(pythonCmd: string, scriptPath: string, pdfPath: string): { text: string; pages: Array<{ page: number; text: string; confidence: number }> } {
  const r = spawnSync(pythonCmd, [scriptPath, pdfPath, '--pdf'], {
    timeout: 600_000, stdio: 'pipe', encoding: 'utf-8',
  });

  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || '').trim() || 'PDF OCR process failed');
  }

  const parsed = JSON.parse(r.stdout.trim());
  if (parsed.error) throw new Error(parsed.error);

  if (!parsed.pages || parsed.pages.length === 0) {
    return { text: 'No text detected in the PDF.', pages: [] };
  }

  const pages: Array<{ page: number; text: string; confidence: number }> = [];
  for (const pg of parsed.pages) {
    const pageText = (pg.lines as string[]).join('\n');
    pages.push({ page: pg.page, text: pageText, confidence: pg.confidence ?? 0 });
  }

  // Build Markdown output
  const mdParts: string[] = [];
  for (const pg of pages) {
    mdParts.push(`### 📄 Page ${pg.page}`);
    if (pg.confidence > 0) {
      mdParts.push(`> Confidence: **${(pg.confidence * 100).toFixed(1)}%**`);
    }
    mdParts.push('');
    mdParts.push(pg.text || '*No text detected*');
    mdParts.push('');
  }

  return { text: mdParts.join('\n'), pages };
}

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
        // Attempt to detect wrong version
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

      try {
        // ensureSetup auto-installs dependencies if needed
        const setup = ensureSetup();
        const result = runOcrScript(setup.cmd, scriptPath, imagePath);

        // Build Markdown output
        const mdLines: string[] = ['## OCR Result\n'];
        if (result.wasResized) {
          mdLines.push('> ℹ️ Large image was scaled down for processing.\n');
        }
        mdLines.push(result.text);
        if (result.confidence > 0) {
          mdLines.push('');
          mdLines.push(`> Confidence: **${(result.confidence * 100).toFixed(1)}%**`);
        }
        return { content: [{ type: 'text', text: mdLines.join('\n') }] };
      } catch (err) {
        if (err instanceof SetupError) {
          // User-friendly guidance for setup issues
          return { content: [{ type: 'text', text: err.userMessage }], isError: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        // Distinguish common failure modes
        if (msg.includes('PaddleOCR') || msg.includes('No module')) {
          return {
            content: [{
              type: 'text',
              text: `OCR engine not ready: ${msg}\n\nRun \`setup_ocr\` to check the environment, or install manually:\n\`\`\`bash\n${tmpdir()}/ocr-venv/bin/python3 -m pip install paddleocr paddlepaddle\n\`\`\``,
            }],
            isError: true,
          };
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

      try {
        const setup = ensureSetup();
        const result = runOcrPdfScript(setup.cmd, scriptPath, pdfPath);

        // result.text is already Markdown
        const footer = `\n---\n> *Processed **${result.pages.length}** pages: ${result.pages.filter(p => p.confidence > 0).length} with text, ${result.pages.filter(p => p.confidence === 0).length} blank*`;
        return { content: [{ type: 'text', text: result.text + footer }] };
      } catch (err) {
        if (err instanceof SetupError) {
          return { content: [{ type: 'text', text: err.userMessage }], isError: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('PyMuPDF')) {
          return {
            content: [{
              type: 'text',
              text: `PDF 解析库未安装: ${msg}\n\n运行 \`setup_ocr\` 重新安装全部依赖。`,
            }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: `PDF OCR 失败: ${msg}` }], isError: true };
      }
    },
  }));
}

// ── Activation ──────────────────────────────────────────────────────────────

export async function activate(ctx: any): Promise<void> {
  ctx.logger.info('PP-OCRv6 extension activating...');
  registerSetupTool(ctx);
  registerStatusTool(ctx);
  registerOcrImageTool(ctx);
  registerOcrPdfTool(ctx);
  ctx.logger.info('PP-OCRv6 extension activated — OCR ready for images and PDFs');
}

export function deactivate(): void {
  // Nothing to clean up
}
