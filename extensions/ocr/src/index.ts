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

      // Check Python availability
      const pythonCmds = ['/tmp/ocr-venv/bin/python3.12', 'python3', 'python'];
      let pythonCmd: string | null = null;

      for (const cmd of pythonCmds) {
        try {
          execSync(`${cmd} -c "import paddleocr"`, { stdio: 'pipe' });
          pythonCmd = cmd;
          break;
        } catch {
          continue;
        }
      }

      if (!pythonCmd) {
        return {
          content: [{
            type: 'text',
            text: [
              '❌ PaddleOCR not found. Please install it:',
              '',
              '```bash',
              '# Create virtual environment',
              'python3 -m venv /tmp/ocr-venv',
              '',
              '# Activate and install',
              'source /tmp/ocr-venv/bin/activate',
              'pip install paddleocr paddlepaddle',
              '```',
              '',
              'Or install system-wide:',
              '```bash',
              'pip install paddleocr paddlepaddle',
              '```',
            ].join('\n'),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: [
            '✅ PP-OCRv6 ready!',
            `- Python: ${pythonCmd}`,
            '- PaddleOCR: installed',
            '',
            'You can now use ocr_image to extract text from images.',
          ].join('\n'),
        }],
      };
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
