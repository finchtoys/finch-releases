/**
 * PP-OCRv6 Finch Extension
 * Uses Python PaddleOCR for high-accuracy OCR.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ── Python OCR ──────────────────────────────────────────────────────────────

/**
 * OCR using Python PaddleOCR with adaptive preprocessing.
 */
async function ocrImageViaPython(imagePath: string, extensionPath: string): Promise<{ text: string; confidence: number }> {
  const { execSync } = await import('node:child_process');

  // Find the Python script
  const scriptPath = join(extensionPath, 'scripts', 'ocr.py');
  if (!existsSync(scriptPath)) {
    throw new Error('OCR script not found. Please reinstall the extension.');
  }

  // Try to find Python with paddleocr installed
  const pythonCmds = [
    '/tmp/ocr-venv/bin/python3.12',
    '/tmp/ocr-venv/bin/python3',
    'python3',
    'python',
  ];

  let lastError: Error | null = null;
  for (const cmd of pythonCmds) {
    try {
      const result = execSync(`${cmd} "${scriptPath}" "${imagePath}"`, {
        timeout: 120_000,
        stdio: 'pipe',
        encoding: 'utf-8',
      });

      // Parse JSON output (last line, ignore warnings/logs)
      const lines = result.trim().split('\n');
      const jsonLine = lines[lines.length - 1];
      const parsed = JSON.parse(jsonLine);

      if (parsed.error) {
        throw new Error(parsed.error);
      }

      if (parsed.lines && parsed.lines.length > 0) {
        return {
          text: parsed.lines.join('\n'),
          confidence: parsed.confidence || 0,
        };
      }

      return { text: 'No text detected in the image.', confidence: 0 };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }

  throw lastError || new Error('No Python interpreter found. Please install Python 3.12+ with paddleocr.');
}

// ── Tools ───────────────────────────────────────────────────────────────────

function registerSetupTool(ctx: any): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'setup_ocr',
    title: 'Set up PP-OCRv6',
    description: 'Check Python environment and install PaddleOCR if needed. Call when OCR reports setup issues.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'medium',
    async execute(_input: any, exec: any) {
      const { execSync } = await import('node:child_process');

      const lines: string[] = ['## PP-OCRv6 Setup\n'];

      // Step 1: Check Python availability
      const pythonCmds = ['/tmp/ocr-venv/bin/python3.12', '/tmp/ocr-venv/bin/python3', 'python3', 'python'];
      let pythonCmd: string | null = null;
      let pythonVersion = 'unknown';

      for (const cmd of pythonCmds) {
        try {
          pythonVersion = execSync(`${cmd} --version`, { stdio: 'pipe', encoding: 'utf-8' }).trim();
          pythonCmd = cmd;
          break;
        } catch {
          continue;
        }
      }

      if (!pythonCmd) {
        lines.push('❌ **Python not found**');
        lines.push('');
        lines.push('**Required:** Python 3.10 or higher');
        lines.push('');
        lines.push('**Install Python:**');
        lines.push('- **macOS:** `brew install python@3.12`');
        lines.push('- **Ubuntu/Debian:** `sudo apt install python3.12`');
        lines.push('- **Windows:** Download from https://www.python.org/downloads/');
        lines.push('');
        lines.push('After installing Python, run `setup_ocr` again.');
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
      }

      lines.push(`✅ **Python:** ${pythonCmd} (${pythonVersion})`);

      // Check Python version (need 3.10+)
      const versionMatch = pythonVersion.match(/(\d+)\.(\d+)/);
      if (versionMatch) {
        const major = parseInt(versionMatch[1]);
        const minor = parseInt(versionMatch[2]);
        if (major < 3 || (major === 3 && minor < 10)) {
          lines.push('');
          lines.push(`❌ **Python version too old:** ${pythonVersion}`);
          lines.push('**Required:** Python 3.10 or higher');
          lines.push('Please upgrade Python and try again.');
          return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
        }
      }

      // Step 2: Check PaddleOCR
      let paddleocrInstalled = false;
      let paddleocrVersion = 'unknown';
      try {
        paddleocrVersion = execSync(`${pythonCmd} -c "import paddleocr; print(paddleocr.__version__)"`, { stdio: 'pipe', encoding: 'utf-8' }).trim();
        paddleocrInstalled = true;
        lines.push(`✅ **PaddleOCR:** installed (v${paddleocrVersion})`);
      } catch {
        lines.push('⚠️ **PaddleOCR:** not installed');
      }

      // Step 3: Install PaddleOCR if not installed
      if (!paddleocrInstalled) {
        lines.push('');
        lines.push('📦 **Dependencies to install:**');
        lines.push('- `paddleocr` (v3.7+) — OCR engine');
        lines.push('- `paddlepaddle` (v3.0+) — Deep learning framework');
        lines.push('- `opencv-python` — Image processing (auto-installed)');
        lines.push('- `numpy` — Array operations (auto-installed)');
        lines.push('');
        lines.push('**Total download size:** ~200 MB');
        lines.push('**Download source:** PyPI (pip)');
        lines.push('');
        lines.push('⏳ **Installing...** (this may take 2-5 minutes on first run)');

        try {
          // Try to install in the venv first
          if (pythonCmd.includes('ocr-venv')) {
            lines.push('Installing in existing virtual environment...');
            execSync(`${pythonCmd} -m pip install paddleocr paddlepaddle --timeout 120`, {
              timeout: 300_000,
              stdio: 'pipe',
            });
          } else {
            // Create venv and install
            lines.push('Creating virtual environment...');
            execSync('python3 -m venv /tmp/ocr-venv', { timeout: 60_000, stdio: 'pipe' });
            lines.push('Installing PaddleOCR in virtual environment...');
            execSync('/tmp/ocr-venv/bin/python3 -m pip install paddleocr paddlepaddle --timeout 120', {
              timeout: 300_000,
              stdio: 'pipe',
            });
          }

          // Verify installation
          paddleocrVersion = execSync('/tmp/ocr-venv/bin/python3 -c "import paddleocr; print(paddleocr.__version__)"', {
            stdio: 'pipe',
            encoding: 'utf-8',
          }).trim();
          paddleocrInstalled = true;
          lines.push('');
          lines.push(`✅ **PaddleOCR installed:** v${paddleocrVersion}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          lines.push('');

          if (errMsg.includes('timeout') || errMsg.includes('ETIMEDOUT')) {
            lines.push('❌ **Download timeout**');
            lines.push('');
            lines.push('**Possible causes:**');
            lines.push('- Slow network connection');
            lines.push('- PyPI server is blocked or slow');
            lines.push('- Firewall blocking downloads');
            lines.push('');
            lines.push('**Solutions:**');
            lines.push('1. **Use a faster network** (WiFi instead of mobile)');
            lines.push('2. **Use a mirror** (for China users):');
            lines.push('   ```bash');
            lines.push('   pip install paddleocr paddlepaddle -i https://pypi.tuna.tsinghua.edu.cn/simple');
            lines.push('   ```');
            lines.push('3. **Install manually** in terminal:');
            lines.push('   ```bash');
            lines.push('   python3 -m venv /tmp/ocr-venv');
            lines.push('   source /tmp/ocr-venv/bin/activate');
            lines.push('   pip install paddleocr paddlepaddle');
            lines.push('   ```');
          } else {
            lines.push(`❌ **Installation failed:** ${errMsg}`);
            lines.push('');
            lines.push('**Please install manually:**');
            lines.push('```bash');
            lines.push('python3 -m venv /tmp/ocr-venv');
            lines.push('source /tmp/ocr-venv/bin/activate');
            lines.push('pip install paddleocr paddlepaddle');
            lines.push('```');
          }
          return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
        }
      }

      // Step 4: Check OCR script
      const scriptPath = join(ctx.extension.extensionPath, 'scripts', 'ocr.py');
      if (existsSync(scriptPath)) {
        lines.push('✅ **OCR Script:** found');
      } else {
        lines.push('❌ **OCR Script:** not found');
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
      }

      lines.push('');
      lines.push('🎉 **PP-OCRv6 is ready!**');
      lines.push('');
      lines.push('**Usage:** Send an image and say "识别这张图里的文字"');
      lines.push('');
      lines.push('**First OCR call** will download models (~132 MB) from HuggingFace.');

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  }));
}

function registerStatusTool(ctx: any): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'ocr_status',
    title: 'OCR Status',
    description: 'Check PP-OCRv6 status and Python environment.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'low',
    async execute() {
      const { execSync } = await import('node:child_process');

      const lines: string[] = ['## PP-OCRv6 Status\n'];

      // Check Python
      const pythonCmds = ['/tmp/ocr-venv/bin/python3.12', 'python3', 'python'];
      let pythonCmd: string | null = null;
      let pythonVersion = 'unknown';

      for (const cmd of pythonCmds) {
        try {
          pythonVersion = execSync(`${cmd} --version`, { stdio: 'pipe', encoding: 'utf-8' }).trim();
          pythonCmd = cmd;
          break;
        } catch {
          continue;
        }
      }

      lines.push(`**Python:** ${pythonCmd ? `✅ ${pythonCmd}` : '❌ not found'}`);
      if (pythonCmd) {
        lines.push(`**Version:** ${pythonVersion}`);

        // Check PaddleOCR
        try {
          execSync(`${pythonCmd} -c "import paddleocr; print(paddleocr.__version__)"`, { stdio: 'pipe' });
          lines.push('**PaddleOCR:** ✅ installed');
        } catch {
          lines.push('**PaddleOCR:** ❌ not installed');
        }
      }

      // Check script
      const scriptPath = join(ctx.extension.extensionPath, 'scripts', 'ocr.py');
      lines.push(`**OCR Script:** ${existsSync(scriptPath) ? '✅ found' : '❌ not found'}`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  }));
}

function registerOcrImageTool(ctx: any): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'ocr_image',
    title: 'OCR Image',
    description: 'Extract text from an image using PP-OCRv6. Call when the user shares an image, pastes a screenshot, or asks to read text from an image. Provide the image file path.',
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
        return { content: [{ type: 'text', text: 'Please provide an image path.' }], isError: true };
      }

      if (!existsSync(imagePath)) {
        return { content: [{ type: 'text', text: `File not found: ${imagePath}` }], isError: true };
      }

      try {
        const result = await ocrImageViaPython(imagePath, ctx.extension.extensionPath);

        let responseText = result.text;
        if (result.confidence > 0) {
          responseText += `\n\n---\n*Confidence: ${(result.confidence * 100).toFixed(1)}%*`;
        }

        return { content: [{ type: 'text', text: responseText }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `OCR failed: ${msg}` }], isError: true };
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

  ctx.logger.info('PP-OCRv6 extension activated');
}

export function deactivate(): void {
  // Nothing to clean up
}
