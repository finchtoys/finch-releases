import type * as finch from 'finch';
import { exec, execFile, execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ── Module-level state ────────────────────────────────────────────────────

let _extensionPath = '';
/** Track running watch processes: resolved file path → { process, url, lastActivity } */
const watchProcesses = new Map<string, { proc: ReturnType<typeof spawn>; url: string; lastActivity: number }>();
/** Auto-stop watch after this many milliseconds of inactivity (5 minutes). */
const WATCH_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Interval to check for idle watch processes (every 60 seconds). */
let watchIdleChecker: ReturnType<typeof setInterval> | null = null;

function touchWatchActivity(filePath: string): void {
  const entry = watchProcesses.get(filePath);
  if (entry) entry.lastActivity = Date.now();
}

function startWatchIdleChecker(): void {
  if (watchIdleChecker) return;
  watchIdleChecker = setInterval(() => {
    const now = Date.now();
    for (const [file, entry] of watchProcesses) {
      if (now - entry.lastActivity > WATCH_IDLE_TIMEOUT_MS) {
        try { entry.proc.kill(); } catch { /* ignore */ }
        try { execSync(`${getOfficeCLIBinary()} unwatch "${file}"`, { timeout: 5000, stdio: 'pipe' }); } catch { /* ignore */ }
        watchProcesses.delete(file);
      }
    }
    if (watchProcesses.size === 0 && watchIdleChecker) {
      clearInterval(watchIdleChecker);
      watchIdleChecker = null;
    }
  }, 60_000);
}

function getBinPath(): string {
  const suffix = process.platform === 'win32' ? 'officecli.exe' : 'officecli';
  return join(_extensionPath, 'bin', suffix);
}

function getBinDir(): string {
  return join(_extensionPath, 'bin');
}

function getDataDir(): string {
  return join(_extensionPath, 'data');
}

/** Resolve file path: if relative, place it in the extension's data/ directory. */
function resolveFilePath(filePath: string): string {
  // Already absolute — use as-is
  if (filePath.startsWith('/')) return filePath;
  // Home dir shortcut
  if (filePath.startsWith('~')) return filePath.replace(/^~/, process.env.HOME || '/Users/jinhan');
  // Relative — place in data/ directory
  const dataDir = getDataDir();
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, filePath);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolvePath(filePath: string, cwd?: string): string {
  if (filePath.startsWith('/')) return filePath;
  if (filePath.startsWith('~')) return filePath.replace(/^~/, process.env.HOME || '/Users/jinhan');
  return cwd ? `${cwd}/${filePath}` : filePath;
}

function getOfficeCLIBinary(): string {
  const local = getBinPath();
  if (existsSync(local)) return local;
  // Fallback to PATH
  return 'officecli';
}

async function runOfficeCLI(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const binary = getOfficeCLIBinary();
  try {
    // Use execFile to avoid shell interpretation of special characters
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const stderr = e.stderr?.trim() || '';
    const stdout = e.stdout?.trim() || '';
    const message = e.message || String(err);
    throw new Error(stderr || stdout || message);
  }
}

function isOfficeCLIInstalled(): boolean {
  try {
    execSync(`${getOfficeCLIBinary()} --version`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function getOfficeCLIVersion(): string {
  try {
    return execSync(`${getOfficeCLIBinary()} --version`, { timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function ensureFileExists(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}. Make sure the path is correct and the file exists.`);
  }
}

/** Open a URL in the user's default browser. */
function openBrowser(url: string): void {
  if (process.platform === 'darwin') {
    execSync(`open "${url}"`, { timeout: 5000, stdio: 'pipe' });
  } else if (process.platform === 'win32') {
    execSync(`start "" "${url}"`, { timeout: 5000, stdio: 'pipe' });
  } else {
    execSync(`xdg-open "${url}"`, { timeout: 5000, stdio: 'pipe' });
  }
}

/** Start a live preview for a file. Returns the URL or throws on error. */
async function startPreviewForFile(filePath: string, port?: number): Promise<string> {
  const resolved = resolveFilePath(filePath);
  ensureFileExists(resolved);

  // Already running?
  if (watchProcesses.has(resolved)) {
    return watchProcesses.get(resolved)!.url;
  }

  const binary = getOfficeCLIBinary();
  const args = ['watch', resolved];
  if (port) args.push('--port', String(port));

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  watchProcesses.set(resolved, { proc: child, url: '(waiting for server to start...)', lastActivity: Date.now() });

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for preview server to start (15s).'));
    }, 15_000);

    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/https?:\/\/localhost[:/]\d+/);
      if (match) {
        clearTimeout(timeout);
        child.stdout?.off('data', onData);
        resolve(match[0]);
      }
    };

    child.stdout?.on('data', onData);

    child.on('error', (err) => {
      clearTimeout(timeout);
      watchProcesses.delete(resolved);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      watchProcesses.delete(resolved);
      if (code && code !== 0) {
        reject(new Error(`officecli watch exited with code ${code}`));
      }
    });
  });

  const tracked = watchProcesses.get(resolved);
  if (tracked) tracked.url = url;

  // Start idle checker to auto-stop watch after inactivity
  startWatchIdleChecker();

  try { openBrowser(url); } catch { /* best-effort */ }

  return url;
}

/** Map Node.js platform to OfficeCLI platform string. */
function mapPlatform(): string {
  const map: Record<string, string> = { darwin: 'mac', linux: 'linux', win32: 'win' };
  return map[process.platform] || process.platform;
}

/** Map Node.js arch to OfficeCLI arch string. */
function mapArch(): string {
  // OfficeCLI release assets use: arm64, x64
  const map: Record<string, string> = { arm64: 'arm64', x64: 'x64' };
  return map[process.arch] || process.arch;
}

// ── Tool: setup_officecli ─────────────────────────────────────────────────

function registerSetupTool(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'setup_officecli',
      title: 'Setup OfficeCLI',
      description: 'Download and install OfficeCLI binary into the extension directory. Call this when OfficeCLI is not installed and you need to set it up. This is a one-time setup — once installed, all other office tools will work.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'medium',
      async execute() {
        if (isOfficeCLIInstalled()) {
          return {
            content: [{
              type: 'text',
              text: [
                `✅ OfficeCLI is already installed.`,
                `Version: ${getOfficeCLIVersion()}`,
                `Location: \`${getOfficeCLIBinary()}\``,
                '',
                'No setup needed — all office tools are ready to use.',
              ].join('\n'),
            }],
          };
        }

        const binDir = getBinDir();
        const binPath = getBinPath();

        try {
          mkdirSync(binDir, { recursive: true });

          const os = mapPlatform();
          const arch = mapArch();
          const ext = process.platform === 'win32' ? '.exe' : '';
          const fileName = `officecli-${os}-${arch}${ext}`;
          const url = `https://github.com/iOfficeAI/OfficeCLI/releases/latest/download/${fileName}`;
          const tmpPath = `${binDir}/${fileName}`;

          // Download the binary directly (not an archive)
          execSync(
            `curl -fSL -o "${tmpPath}" "${url}"`,
            { timeout: 120_000, stdio: 'pipe', shell: 'bash' },
          );

          // Verify download succeeded
          if (!existsSync(tmpPath)) {
            throw new Error(`Download failed: ${tmpPath} not found`);
          }

          // Move to expected location if different
          if (tmpPath !== binPath) {
            execSync(`mv "${tmpPath}" "${binPath}"`, { stdio: 'pipe' });
          }

          // Make executable
          if (existsSync(binPath)) {
            chmodSync(binPath, 0o755);
          }

          if (!existsSync(binPath)) {
            throw new Error(`Binary not found at ${binPath} after download.`);
          }

          const version = getOfficeCLIVersion();
          return {
            content: [{
              type: 'text',
              text: [
                `✅ OfficeCLI installed successfully!`,
                `Version: ${version}`,
                `Location: \`${binPath}\``,
                '',
                'All office tools are now ready to use.',
              ].join('\n'),
            }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{
              type: 'text',
              text: [
                `❌ Failed to install OfficeCLI: ${message}`,
                '',
                '**Manual install alternatives:**',
                '```bash',
                'curl -fsSL https://d.officecli.ai/install.sh | bash',
                '```',
                'or `brew install officecli` or `npm install -g @officecli/officecli`',
                '',
                'After installing, restart Finch or re-enable the extension.',
              ].join('\n'),
            }],
            isError: true,
          };
        }
      },
    }),
  );
}

// ── Tool: check_officecli ─────────────────────────────────────────────────

function registerCheckTool(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'check_officecli',
      title: 'Check OfficeCLI',
      description: 'Check whether OfficeCLI is installed and show available tools. Call this first before using any other office tools.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'low',
      async execute() {
        const binPath = getBinPath();

        if (!isOfficeCLIInstalled()) {
          const localExists = existsSync(binPath);
          return {
            content: [{
              type: 'text',
              text: [
                '**OfficeCLI is not available.**',
                localExists
                  ? `Binary exists at \`${binPath}\` but may not be executable. Try calling \`setup_officecli\` to reinstall.`
                  : `Not found in PATH or at \`${binPath}\`.`,
                '',
                '**To install, call the `setup_officecli` tool.**',
                '',
                '**Manual install alternatives:**',
                '```bash',
                'curl -fsSL https://d.officecli.ai/install.sh | bash',
                '```',
                'or `brew install officecli` or `npm install -g @officecli/officecli`',
              ].join('\n'),
            }],
          };
        }

        const version = getOfficeCLIVersion();
        const binary = getOfficeCLIBinary();
        const location = binary === 'officecli' ? 'PATH (installed via brew/npm/manual install)' : `\`${binary}\``;
        return {
          content: [{
            type: 'text',
            text: [
              `✅ OfficeCLI is installed.`,
              `Version: ${version}`,
              `Location: ${location}`,
              '',
              '**Strategy — work top-down:**',
              '1. `read_office_file` — inspect document structure (outline/html/text/issues/stats)',
              '2. `get_office_element` — drill into specific elements with `--depth N`',
              '3. `modify_office_file` — add/set/remove/move elements, find & replace',
              '4. `save_office_file` — flush changes to disk when done',
              '',
              '**When unsure about property names, value formats, or syntax:**',
              'Run `inspect_office_file` with `action=help` and a `helpQuery` to look up the exact schema.',
              'Example: `officecli help pptx shape` lists all shape properties.',
              '',
              '**Available tools:**',
              '- `read_office_file` — view document content',
              '- `create_office_file` — create new Office files',
              '- `modify_office_file` — add, set, remove, move elements, find & replace',
              '- `get_office_element` — get structured JSON for any element',
              '- `inspect_office_file` — validate, run help queries',
              '- `preview_office_file` — live preview in browser + click-to-select elements',
              '- `save_office_file` — save and close a file',
            ].join('\n'),
          }],
        };
      },
    }),
  );
}

// ── Tool: read_office_file ────────────────────────────────────────────────

function registerReadTool(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'read_office_file',
      title: 'Read Office File',
      description: 'Read content from a Word (.docx), Excel (.xlsx), or PowerPoint (.pptx) file. This is your L1 (first-layer) inspection tool.\n\n' +
        '**View modes:**\n' +
        '- `outline` — Document structure (headings, slides, sheets, cell values). Best for understanding the overall document.\n' +
        '- `html` — Static HTML snapshot of the rendered document. Best for seeing layout and formatting.\n' +
        '- `text` — Plain text extraction. Best for getting just the words.\n' +
        '- `issues` — Formatting/content/structure problems. Use `--limit N` to cap results.\n' +
        '- `stats` — Document statistics (pages, words, shapes, etc.).\n' +
        '- `annotated` — Text with formatting annotations.\n\n' +
        '**Usage flow:** Start with `outline` to understand structure, then drill deeper with `get_office_element`.\n' +
        'Use `html` mode for a visual preview of the rendered document.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the .docx, .xlsx, or .pptx file. Relative or absolute.' },
          viewMode: { type: 'string', enum: ['outline', 'html', 'text', 'issues', 'stats', 'annotated'], description: 'View mode (default: outline).' },
          limit: { type: 'number', description: 'Max results for issues mode (e.g. 10).' },
        },
        required: ['filePath'],
      },
      risk: 'low',
      async execute(input: Record<string, unknown>) {
        const { filePath, viewMode = 'outline', limit } = input as { filePath: string; viewMode?: string; limit?: number };
        const resolved = resolveFilePath(filePath);
        ensureFileExists(resolved);

        const args = ['view', resolved, viewMode];
        if (limit != null && viewMode === 'issues') {
          args.push('--limit', String(limit));
        }

        const { stdout } = await runOfficeCLI(args);
        const modeLabel = viewMode.charAt(0).toUpperCase() + viewMode.slice(1);

        return {
          content: [{
            type: 'text',
            text: [
              `📄 ${filePath} — ${modeLabel}`,
              '',
              stdout || '(empty)',
            ].join('\n'),
          }],
        };
      },
    }),
  );
}

// ── Tool: create_office_file ──────────────────────────────────────────────

function registerCreateTool(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'create_office_file',
      title: 'Create Office File',
      description: 'Create a new Word (.docx), Excel (.xlsx), or PowerPoint (.pptx) file. File type is inferred from the extension.\n\n' +
        'After creation:\n' +
        '- PPT: auto-starts live preview in browser\n' +
        '- Word/Excel: asks user if they want live preview\n\n' +
        'OfficeCLI auto-starts a resident session on first access (60s idle timeout), ' +
        'so subsequent edits are fast with no file I/O overhead.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path for the new file, e.g. "report.docx", "data.xlsx", "deck.pptx". Extension determines file type.' },
        },
        required: ['filePath'],
      },
      risk: 'medium',
      async execute(input: Record<string, unknown>) {
        const { filePath } = input as { filePath: string };
        const resolved = resolveFilePath(filePath);

        if (existsSync(resolved)) {
          return { content: [{ type: 'text', text: `File already exists: ${filePath}. Use modify_office_file to edit it, or choose a different path.` }] };
        }

        await runOfficeCLI(['create', resolved]);

        try {
          const url = await startPreviewForFile(filePath);
          openBrowser(url);

          return {
            content: [{
              type: 'text',
              text: [
                `✅ Created new file: ${filePath}`,
                '',
                `👁 Live preview started: ${url}`,
                '',
                'The preview has been opened in your browser. Use `modify_office_file` to add content — the browser will auto-refresh.',
                'When done, call `preview_office_file(action=stop)` to shut down the server.',
              ].join('\n'),
            }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{
              type: 'text',
              text: [
                `✅ Created new file: ${filePath}`,
                '',
                `⚠️ Failed to start preview: ${message}`,
                '',
                'Use `read_office_file` to view it, or `modify_office_file` to add content.',
              ].join('\n'),
            }],
          };
        }
      },
    }),
  );
}

// ── Tool: modify_office_file ──────────────────────────────────────────────

function registerModifyTool(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'modify_office_file',
      title: 'Modify Office File',
      description: 'Modify elements in an Office file (Word/Excel/PowerPoint). This is your L2 (DOM-level) editing tool.\n\n' +
        '**Commands:**\n' +
        '- `add` — Add new elements (slides, shapes, cells, sheets, paragraphs, tables, charts, etc.)\n' +
        '- `set` — Modify properties of existing elements (text, font, color, position, bold, etc.)\n' +
        '- `remove` — Remove elements\n' +
        '- `move` — Move an element to a different parent or position\n' +
        '- `find-and-replace` — Find and replace text across the document\n\n' +
        '**Element paths** (1-based, XPath-style):\n' +
        '- PPT: `/slide[1]`, `/slide[1]/shape[2]`, or `/slide[1]/shape[@name=Title 1]` for stable IDs\n' +
        '- Excel: `/Sheet1`, `/Sheet1/A1`, `/Sheet1/row[3]/cell[B]`\n' +
        '- Word: `/body/p[3]`, `/body/table[1]/row[1]/cell[2]`\n' +
        '- Root: `/` for document-level properties\n\n' +
        '**Element types** (for `add`):\n' +
        '- PPT: `slide`, `shape`, `table`, `chart`, `picture`, `textbox`, `connector`, `group`, `animation`, `transition`\n' +
        '- Excel: `sheet`, `row`, `cell`, `table`, `chart`, `pivotTable`, `picture`, `sparkline`, `comment`\n' +
        '- Word: `paragraph`, `run`, `table`, `picture`, `shape`, `textbox`, `chart`, `section`, `header`, `footer`, `comment`, `bookmark`, `hyperlink`\n\n' +
        '**Props** (key=value):\n' +
        '- Text: `text`, `title`, `font`, `size`, `bold=true`, `italic=true`, `color=FF0000`, `highlight=yellow`\n' +
        '- Position: `x`, `y`, `w`, `h` with units like `cm`, `pt`, `px`\n' +
        '- Colors: hex (`FF0000`), named (`red`), theme (`accent1`)\n' +
        '- Excel cells: `value`, `formula=SUM(A1:A10)`, `bold=true`, `numberFormat=#,##0`\n' +
        '- Spacing: `12pt`, `0.5cm`, `1.5x`\n' +
        '- Dotted aliases: `font.color=red`, `font.bold=true`, `font.size=14pt`\n\n' +
        '**Find & Replace** (set command with `find`/`replace`):\n' +
        'Set `command=set` and include `find` and `replace` in props to do find-and-replace.\n' +
        'Example: props={"find":"draft","replace":"final"} finds "draft" across the document and replaces it with "final".\n' +
        'Use `regex=true` in props for regex matching.\n\n' +
        '**Clone existing elements:**\n' +
        'Set `command=add` and include `from` in props to clone an element.\n' +
        'Example: props={"from":"/slide[1]"} clones the first slide.\n\n' +
        '**IMPORTANT — When unsure about property names, value formats, or command syntax:**\n' +
        'Run `inspect_office_file` with `helpQuery` set to look up the exact schema.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the .docx, .xlsx, or .pptx file.' },
          command: { type: 'string', enum: ['add', 'set', 'remove', 'move'], description: 'Operation: add (create new), set (modify), remove (delete), move (reposition).' },
          elementPath: { type: 'string', description: 'Path to the target element. E.g. "/" (root), "/slide[1]", "/slide[1]/shape[2]", "/Sheet1/A1", "/body/p[3]". For add, this is the parent where the new element goes.' },
          elementType: { type: 'string', description: 'Element type to add (required for add command). E.g. "slide", "shape", "paragraph", "run", "table", "chart", "picture", "sheet", "row", "cell", "pivotTable", "comment", "section".' },
          props: {
            type: 'object',
            description: 'Key-value properties. Examples: {"title":"Q4 Report","text":"Hello","font":"Arial","size":24,"color":"FFFFFF","bold":true,"background":"1A1A2E","x":"2cm","y":"5cm"}. For find/replace: {"find":"draft","replace":"final"} or {"find":"\\d+%","regex":true,"replace":"[redacted]"} on the root path "/". For clone: {"from":"/slide[1]"} on add command. For Excel: {"value":123,"formula":"SUM(A1:A10)"}.',
            properties: {},
            additionalProperties: true,
          },
          targetPath: { type: 'string', description: 'For move command: destination parent path. For add with --after/--before: anchor element path. Optional.' },
        },
        required: ['filePath', 'command', 'elementPath'],
      },
      risk: 'medium',
      async execute(input: Record<string, unknown>) {
        const { filePath, command, elementPath, elementType, props, targetPath } = input as {
          filePath: string;
          command: string;
          elementPath: string;
          elementType?: string;
          props?: Record<string, string | number | boolean>;
          targetPath?: string;
        };

        const resolved = resolveFilePath(filePath);
        if (command !== 'add') {
          ensureFileExists(resolved);
        }

        const args = [command, resolved, elementPath];

        if (elementType && command === 'add') {
          args.push('--type', elementType);
        }

        if (targetPath) {
          if (command === 'move') {
            args.push('--to', targetPath);
          } else {
            args.push('--after', targetPath);
          }
        }

        if (props && typeof props === 'object' && Object.keys(props).length > 0) {
          for (const [key, value] of Object.entries(props)) {
            const strVal = String(value);
            args.push('--prop', `${key}=${strVal}`);
          }
        }

        const { stdout, stderr } = await runOfficeCLI(args);

        // Touch watch activity if preview is running for this file
        touchWatchActivity(resolved);

        // If no preview running, start one
        let previewInfo = '';
        if (!watchProcesses.has(resolved)) {
          try {
            const url = await startPreviewForFile(filePath);
            previewInfo = `\n\n👁 Live preview started: ${url}`;
          } catch {
            // Preview failed to start — not critical, just skip
          }
        }

        return {
          content: [{
            type: 'text',
            text: [
              `✅ ${command} on ${filePath} (path: ${elementPath})`,
              stderr ? `\n${stderr}` : '',
              stdout ? `\n${stdout}` : '',
              previewInfo,
            ].filter(Boolean).join(''),
          }],
        };
      },
    }),
  );
}

// ── Tool: get_office_element ──────────────────────────────────────────────

function registerGetTool(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'get_office_element',
      title: 'Get Office Element',
      description: 'Get detailed structured information (JSON) about a specific element in an Office file. ' +
        'Use this to inspect element properties, cell values, formulas, styles, positions, etc. ' +
        'Use `--depth N` to expand N levels of children.\n\n' +
        '**Examples:**\n' +
        '- `get data.xlsx /Sheet1/B2 --json` — get a single cell\'s value and properties\n' +
        '- `get deck.pptx \'/slide[1]\' --depth 1` — list all shapes on slide 1\n' +
        '- `get report.docx /` — full document structure\n' +
        '- `get report.docx \'/body/p[3]\' --depth 2 --json` — paragraph with children\n\n' +
        '**Stable ID addressing:** Elements with stable IDs return paths like `/slide[1]/shape[@id=550950021]` ' +
        'which persist across insert/delete operations (unlike positional indices).\n\n' +
        'Use this before modifying an element to see its current state.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the .docx, .xlsx, or .pptx file.' },
          elementPath: { type: 'string', description: 'Path to the element. Use "/" for full document. E.g. "/slide[1]", "/slide[1]/shape[1]", "/Sheet1/B2", "/body/p[3]". Also supports stable IDs: "/slide[1]/shape[@id=550950021]".' },
          depth: { type: 'number', description: 'How many levels of children to expand (default: 1). Use 0 for just the element itself, 2+ for deeper children.' },
        },
        required: ['filePath', 'elementPath'],
      },
      risk: 'low',
      async execute(input: Record<string, unknown>) {
        const { filePath, elementPath, depth } = input as { filePath: string; elementPath: string; depth?: number };
        const resolved = resolveFilePath(filePath);
        ensureFileExists(resolved);

        const args = ['get', resolved, elementPath, '--json'];
        if (depth != null) {
          args.push('--depth', String(depth));
        }

        const { stdout } = await runOfficeCLI(args);

        try {
          const parsed = JSON.parse(stdout);
          const depthInfo = depth != null ? ` (depth=${depth})` : '';
          return {
            content: [{
              type: 'text',
              text: [
                `📋 ${filePath} → ${elementPath}${depthInfo}`,
                '',
                '```json',
                JSON.stringify(parsed, null, 2),
                '```',
              ].join('\n'),
            }],
          };
        } catch {
          return { content: [{ type: 'text', text: stdout || '(no output)' }] };
        }
      },
    }),
  );
}

// ── Tool: inspect_office_file ─────────────────────────────────────────────

function registerInspectTool(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'inspect_office_file',
      title: 'Inspect Office File',
      description: 'Run diagnostics, validation, or help queries for Office files.\n\n' +
        '**Actions:**\n' +
        '- `validate` — Validate the file against the OpenXML schema. Catches structural issues.\n' +
        '- `help` — Query the OfficeCLI help system for property names, value formats, and syntax.\n' +
        '  Use this when you are unsure about command syntax instead of guessing.\n\n' +
        '**Help query examples:**\n' +
        '- `officecli help` — list all commands\n' +
        '- `officecli help pptx` — list all PPTX element types\n' +
        '- `officecli help pptx shape` — full shape schema with properties, aliases, examples\n' +
        '- `officecli help docx paragraph` — paragraph properties\n' +
        '- `officecli help xlsx cell` — cell properties, value formats\n' +
        '- `officecli help pptx set shape` — only props usable with the `set` command\n' +
        '- `officecli help pptx shape --json` — structured machine-readable schema\n\n' +
        '**Format aliases:** `word`→`docx`, `excel`→`xlsx`, `ppt`/`powerpoint`→`pptx`.\n\n' +
        '**IMPORTANT:** When you are unsure about property names, value formats, or command syntax, ' +
        'ALWAYS run a help query here instead of guessing. One help query beats guess-fail-retry loops.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the file to validate. Only needed for validate action.' },
          action: { type: 'string', enum: ['validate', 'help'], description: 'Action: validate the file or query the help system.' },
          helpQuery: { type: 'string', description: 'For help action: the help query string. E.g. "pptx shape", "docx paragraph", "xlsx cell", "pptx", "". Empty string = general help.' },
        },
        required: ['action'],
      },
      risk: 'low',
      async execute(input: Record<string, unknown>) {
        const { filePath, action, helpQuery } = input as { filePath?: string; action: string; helpQuery?: string };

        if (action === 'help') {
          const args = ['help'];
          if (helpQuery) {
            args.push(helpQuery);
          }
          const { stdout } = await runOfficeCLI(args);
          return {
            content: [{
              type: 'text',
              text: [
                '📖 OfficeCLI Help',
                helpQuery ? `Query: \`officecli help ${helpQuery}\`` : 'General help',
                '',
                '```',
                stdout || '(no output)',
                '```',
                '',
                '**Tip:** For more specific help, run again with a more targeted query like `pptx shape`, `docx paragraph`, or `xlsx cell`.',
              ].join('\n'),
            }],
          };
        }

        if (!filePath) {
          return { content: [{ type: 'text', text: 'filePath is required for validate action.' }], isError: true };
        }
        const resolved = resolveFilePath(filePath);
        ensureFileExists(resolved);

        const { stdout } = await runOfficeCLI(['validate', resolved]);
        return {
          content: [{
            type: 'text',
            text: [
              `🔍 Validation result for ${filePath}`,
              '',
              stdout || 'No issues found — file is valid.',
            ].join('\n'),
          }],
        };
      },
    }),
  );
}

// ── Tool: save_office_file ────────────────────────────────────────────────

function registerSaveTool(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'save_office_file',
      title: 'Save Office File',
      description: 'Save and close an Office file. Flushes the resident session to disk.\n\n' +
        'OfficeCLI auto-starts a resident session on first file access (60s idle timeout). ' +
        'Its own reads (get/query/view) always see the latest edits, so you generally do NOT need to ' +
        'save mid-workflow. Call this only when:\n' +
        '- You are done editing the file\n' +
        '- A non-officecli program needs to read the file (e.g. Word, Excel, PowerPoint, a renderer)\n' +
        '- You want to explicitly release the file handle',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the .docx, .xlsx, or .pptx file to save and close.' },
        },
        required: ['filePath'],
      },
      risk: 'low',
      async execute(input: Record<string, unknown>) {
        const { filePath } = input as { filePath: string };
        const resolved = resolveFilePath(filePath);
        ensureFileExists(resolved);

        const { stdout } = await runOfficeCLI(['close', resolved]);
        return {
          content: [{
            type: 'text',
            text: `✅ Saved and closed: ${filePath}${stdout ? '\n' + stdout : ''}`,
          }],
        };
      },
    }),
  );
}

// ── Tool: preview_office_file ─────────────────────────────────────────────

function registerPreviewTool(ctx: finch.MiniToolContext): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'preview_office_file',
      title: 'Preview Office File',
      description: 'Start, stop, or read selected elements from a live HTML preview of an Office file.\n\n' +
        '**Actions:**\n' +
        '- `start` — Launch a live preview server (default port 26315). The browser auto-refreshes on every file change. ' +
        'You and the user can click elements in the browser to select them, then use `action=selected` to inspect them.\n' +
        '- `stop` — Shut down the preview server for the given file.\n' +
        '- `selected` — Get structured JSON for whatever element the user clicked in the browser preview.\n\n' +
        '**Workflow:**\n' +
        '1. Start preview: `preview_office_file(action=start, filePath=deck.pptx)`\n' +
        '2. Open the returned URL in browser\n' +
        '3. After the user clicks an element: `preview_office_file(action=selected, filePath=deck.pptx)`\n' +
        '4. Use the returned path with `modify_office_file` to edit it\n' +
        '5. Stop preview when done: `preview_office_file(action=stop, filePath=deck.pptx)`',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the .docx, .xlsx, or .pptx file.' },
          action: { type: 'string', enum: ['start', 'stop', 'selected'], description: 'start: launch live preview. stop: shut down preview. selected: get the currently selected element in the browser.' },
          port: { type: 'number', description: 'Port for the preview server (default: 26315). Only used with start action.' },
        },
        required: ['filePath', 'action'],
      },
      risk: 'low',
      async execute(input: Record<string, unknown>) {
        const { filePath, action, port } = input as { filePath: string; action: string; port?: number };
        const resolved = resolveFilePath(filePath);
        ensureFileExists(resolved);

        // ── selected: read browser selection ──
        if (action === 'selected') {
          const { stdout } = await runOfficeCLI(['get', resolved, 'selected', '--json']);

          if (!stdout) {
            return { content: [{ type: 'text', text: 'No element is currently selected in the browser. Click an element in the preview first.' }] };
          }

          try {
            const parsed = JSON.parse(stdout);
            return {
              content: [{
                type: 'text',
                text: [
                  '🎯 Selected element:',
                  '',
                  '```json',
                  JSON.stringify(parsed, null, 2),
                  '```',
                  '',
                  'Use `modify_office_file` with the returned `path` to edit the selected element.',
                ].join('\n'),
              }],
            };
          } catch {
            return { content: [{ type: 'text', text: stdout }] };
          }
        }

        // ── stop: shut down preview server ──
        if (action === 'stop') {
          // Kill tracked process if we have it
          const tracked = watchProcesses.get(resolved);
          if (tracked) {
            tracked.proc.kill();
            watchProcesses.delete(resolved);
          }
          // Also send unwatch command
          try {
            await runOfficeCLI(['unwatch', resolved]);
          } catch {
            // unwatch may fail if already stopped — not an error
          }
          return { content: [{ type: 'text', text: `⏹ Preview stopped for ${filePath}` }] };
        }

        // ── start: launch watch server ──
        try {
          const url = await startPreviewForFile(filePath, port);
          return {
            content: [{
              type: 'text',
              text: [
                `👁 Preview started for ${filePath}`,
                '',
                `URL: ${url}`,
                '',
                'The preview has been opened in your browser. Click elements to select them,',
                'then call this tool again with `action=selected` to inspect the selection.',
                'When done, call `action=stop` to shut down the server.',
              ].join('\n'),
            }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{
              type: 'text',
              text: `❌ Failed to start preview for ${filePath}: ${message}`,
            }],
            isError: true,
          };
        }
      },
    }),
  );
}

// ── Activation ────────────────────────────────────────────────────────────

export function activate(ctx: finch.MiniToolContext): void {
  // Store extension path for local binary resolution
  _extensionPath = ctx.extension.extensionPath;

  ctx.logger.info(`office-tools activating (extension path: ${_extensionPath})`);

  registerCheckTool(ctx);
  registerSetupTool(ctx);
  registerReadTool(ctx);
  registerCreateTool(ctx);
  registerModifyTool(ctx);
  registerGetTool(ctx);
  registerInspectTool(ctx);
  registerPreviewTool(ctx);
  registerSaveTool(ctx);

  ctx.logger.info('office-tools activated — 9 tools registered');
}

export function deactivate(): void {
  // Kill all running watch processes
  for (const [file, tracked] of watchProcesses) {
    try {
      tracked.proc.kill();
    } catch {
      // ignore
    }
  }
  watchProcesses.clear();
}