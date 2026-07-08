import type * as finch from 'finch';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SERVER_NAME = 'ocr';
const HF_BASE = 'https://huggingface.co/PaddlePaddle';

type Tier = 'tiny' | 'small' | 'medium';

const TIER_INFO: Record<Tier, { detRepo: string; recRepo: string; detSize: string; recSize: string }> = {
  tiny:   { detRepo: 'PP-OCRv6_tiny_det_onnx',   recRepo: 'PP-OCRv6_tiny_rec_onnx',   detSize: '1.7 MB',  recSize: '4.3 MB' },
  small:  { detRepo: 'PP-OCRv6_small_det_onnx',  recRepo: 'PP-OCRv6_small_rec_onnx',  detSize: '9.4 MB',  recSize: '20.2 MB' },
  medium: { detRepo: 'PP-OCRv6_medium_det_onnx', recRepo: 'PP-OCRv6_medium_rec_onnx', detSize: '59 MB',  recSize: '73 MB' },
};

interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
}

interface ServersFile {
  servers?: McpServerConfig[];
}

interface McpClientCapability {
  listServers(): Promise<string[]>;
  getServerStatuses?(): Promise<Array<{ name: string; status: string; toolCount: number }>>;
  listTools(server: string): Promise<Array<{ name: string }>>;
}

function mcpServersFile(ctx: finch.ExtensionContext): string {
  return join(dirname(ctx.storagePath), 'mcp', 'servers.json');
}

function readServers(file: string): ServersFile {
  if (!existsSync(file)) return { servers: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ServersFile;
    return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
  } catch {
    return { servers: [] };
  }
}

function upsertServer(file: string, server: McpServerConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const data = readServers(file);
  const next = (data.servers ?? []).filter((item) => item.name !== server.name);
  next.push(server);
  next.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(file, JSON.stringify({ servers: next }, null, 2) + '\n', 'utf-8');
}

function modelsDir(ctx: finch.ExtensionContext): string {
  return join(ctx.storagePath, 'models');
}

function modelPath(ctx: finch.ExtensionContext, tier: Tier, type: 'det' | 'rec'): string {
  const info = TIER_INFO[tier];
  const repo = type === 'det' ? info.detRepo : info.recRepo;
  return join(modelsDir(ctx), `${repo}.onnx`);
}

function charsPath(ctx: finch.ExtensionContext): string {
  return join(modelsDir(ctx), 'chars.json');
}

function modelDownloadUrl(tier: Tier, type: 'det' | 'rec'): string {
  const info = TIER_INFO[tier];
  const repo = type === 'det' ? info.detRepo : info.recRepo;
  return `${HF_BASE}/${repo}/resolve/main/inference.onnx?download=1`;
}

function recYmlUrl(tier: Tier): string {
  const info = TIER_INFO[tier];
  return `${HF_BASE}/${info.recRepo}/resolve/main/inference.yml`;
}

async function downloadFile(url: string, dest: string, logger: finch.Logger): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });

  logger.info(`downloading: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  writeFileSync(dest, Buffer.from(buffer));
  logger.info(`saved to ${dest} (${buffer.byteLength} bytes)`);
}

/**
 * Extract the character dictionary from PP-OCRv6 inference.yml.
 * The YAML has a simple list under PostProcess > character_dict:
 *   character_dict:
 *     - '!'
 *     - '"'
 *     ...
 */
function extractCharacterDict(yamlContent: string): string[] {
  const chars: string[] = [];
  const lines = yamlContent.split('\n');
  let inDict = false;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === 'character_dict:' || trimmed.endsWith(' character_dict:')) {
      inDict = true;
      continue;
    }
    if (inDict) {
      // End of dict: lines no longer start with `- ` at the dict indentation
      if (!trimmed.startsWith('- ')) break;

      // Extract value after `- `
      let value = trimmed.slice(2);

      // Handle YAML single-quoted strings
      if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
        // YAML escaping: '' inside single quotes → '
        value = value.replace(/''/g, "'");
      }

      chars.push(value);
    }
  }

  return chars;
}

async function ensureCharsJson(modelsDir: string, tier: Tier, logger: finch.Logger): Promise<string> {
  const dest = join(modelsDir, 'chars.json');
  if (existsSync(dest)) {
    logger.info('chars.json already cached');
    return dest;
  }

  const ymlUrl = recYmlUrl(tier);
  const ymlDest = join(modelsDir, 'inference.yml');

  logger.info(`downloading inference.yml from ${ymlUrl}`);
  const response = await fetch(ymlUrl);
  if (!response.ok) {
    throw new Error(`Failed to download inference.yml: ${response.status} ${response.statusText}`);
  }
  const yamlContent = await response.text();
  writeFileSync(ymlDest, yamlContent);

  const chars = extractCharacterDict(yamlContent);
  logger.info(`extracted ${chars.length} characters from character_dict`);

  writeFileSync(dest, JSON.stringify(chars), 'utf-8');
  logger.info(`chars.json saved to ${dest}`);

  return dest;
}

async function verifyWithMcpClient(ctx: finch.ExtensionContext): Promise<string> {
  if (!ctx.capabilities.has('mcp.client')) {
    return 'MCP Client capability is not available. Enable the MCP Client extension, then try OCR again.';
  }

  const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');
  try {
    const servers = await mcp.listServers();
    if (!servers.includes(SERVER_NAME)) {
      return 'Saved, but MCP Client has not picked up the OCR server yet. Disable/enable MCP Client or restart Finch if it does not appear shortly.';
    }
    const tools = await mcp.listTools(SERVER_NAME);
    const names = tools.map((tool) => tool.name).sort();
    return names.length
      ? `MCP Client can see OCR tools: ${names.join(', ')}.`
      : 'MCP Client found the OCR server, but it has not reported tools yet.';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Saved, but connection validation did not complete: ${message}`;
  }
}

function buildServer(
  tier: Tier,
  language: string,
  detModelPath: string,
  recModelPath: string,
  charsFilePath: string,
): McpServerConfig {
  return {
    name: SERVER_NAME,
    command: 'node',
    args: ['dist/mcp-server.js'],
    env: {
      OCR_DET_MODEL_PATH: detModelPath,
      OCR_REC_MODEL_PATH: recModelPath,
      OCR_CHARS_PATH: charsFilePath,
      OCR_LANGUAGE: language,
      OCR_TIER: tier,
    },
    description: `PP-OCRv6 ${tier} OCR server (${language}).`,
  };
}

// ── Tools ───────────────────────────────────────────────────────────────────

function registerSetupTool(ctx: finch.ExtensionContext): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'setup_ocr',
    title: 'Set up PP-OCRv6',
    description: 'Configure OCR: select model tier and languages, download ONNX models, and start the OCR MCP server. Call this when OCR is not set up yet.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'medium',
    async execute(_input, exec) {
      const result = await exec.ui.requestForm({
        title: '设置 PP-OCRv6 OCR',
        description: '选择模型档位和识别语言，首次使用需要下载模型（约 132 MB）。',
        submitLabel: '下载并启动',
        fields: [
          {
            key: 'tier',
            label: '模型档位',
            type: 'select',
            default: 'medium',
            options: [
              { value: 'tiny',   label: 'Tiny (~6 MB) — 快速轻量' },
              { value: 'small',  label: 'Small (~30 MB) — 平衡' },
              { value: 'medium', label: 'Medium (~132 MB) — 最高精度（推荐）' },
            ],
          },
          {
            key: 'language',
            label: '识别语言',
            type: 'select',
            default: 'ch+en',
            description: 'PP-OCRv6 单模型支持 50 种语言，按需选择',
            options: [
              { value: 'ch+en',     label: '中文 + 英文' },
              { value: 'en',        label: '英文' },
              { value: 'ch',        label: '中文' },
              { value: 'ch+en+ja',  label: '中文 + 英文 + 日文' },
            ],
          },
        ],
      });

      if (!result.submitted) {
        return { content: [{ type: 'text', text: `OCR setup was cancelled (${result.reason}).` }] };
      }

      const tier = String(result.values.tier ?? 'medium') as Tier;
      const language = String(result.values.language ?? 'ch+en');

      if (!TIER_INFO[tier]) {
        return { content: [{ type: 'text', text: `Invalid tier: ${tier}` }], isError: true };
      }

      // Download models
      const detDest = modelPath(ctx, tier, 'det');
      const recDest = modelPath(ctx, tier, 'rec');
      const mdlDir = modelsDir(ctx);
      let charsFilePath = join(mdlDir, 'chars.json');

      try {
        // Check if models already exist
        if (!existsSync(detDest)) {
          exec.logger.info('detection model not cached, downloading...');
          await downloadFile(modelDownloadUrl(tier, 'det'), detDest, exec.logger);
        } else {
          exec.logger.info('detection model already cached');
        }

        if (!existsSync(recDest)) {
          exec.logger.info('recognition model not cached, downloading...');
          await downloadFile(modelDownloadUrl(tier, 'rec'), recDest, exec.logger);
        } else {
          exec.logger.info('recognition model already cached');
        }

        // Download and extract character dictionary
        await ensureCharsJson(mdlDir, tier, exec.logger);
      } catch (err) {
        ctx.logger.error('failed to download OCR models', err);
        return {
          content: [{ type: 'text', text: `Failed to download OCR models: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      // Write MCP server config
      const server = buildServer(tier, language, detDest, recDest, charsFilePath);
      const file = mcpServersFile(ctx);

      try {
        upsertServer(file, server);
      } catch (err) {
        ctx.logger.error('failed to save OCR MCP config', err);
        return {
          content: [{ type: 'text', text: `Failed to save OCR MCP config: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      await ctx.ui.showToast({
        title: 'OCR 配置已保存',
        description: `PP-OCRv6 ${tier} 模型已就绪，MCP Client 将启动 OCR 服务。`,
        variant: 'success',
      });

      const validation = await verifyWithMcpClient(ctx);
      return {
        content: [{
          type: 'text',
          text: [
            `✅ PP-OCRv6 (${tier}) 配置完成！`,
            `- 检测模型: ${TIER_INFO[tier].detSize}`,
            `- 识别模型: ${TIER_INFO[tier].recSize}`,
            `- 语言: ${language}`,
            `- 字符集: 已加载 ${charsFilePath}`,
            `- 模型路径: ${mdlDir}`,
            '',
            validation,
          ].join('\n'),
        }],
      };
    },
  }));
}

function registerStatusTool(ctx: finch.ExtensionContext): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'ocr_status',
    title: 'OCR Status',
    description: 'Check whether PP-OCRv6 is configured, which models are cached, and which tools are available through MCP Client.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'low',
    async execute() {
      const modelDir = modelsDir(ctx);
      const lines: string[] = ['## OCR Status\n'];

      // Check for cached models
      const cachedModels: string[] = [];
      let charsCount = 0;
      if (existsSync(modelDir)) {
        const files = readdirSync(modelDir);
        for (const file of files) {
          if (file.endsWith('.onnx')) {
            const stat = statSync(join(modelDir, file));
            cachedModels.push(`- ${file} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
          }
          if (file === 'chars.json') {
            try {
              const raw = readFileSync(join(modelDir, file), 'utf-8');
              const arr = JSON.parse(raw);
              if (Array.isArray(arr)) charsCount = arr.length;
            } catch { /* ignore */ }
          }
        }
      }

      if (cachedModels.length > 0) {
        lines.push('**Cached models:**');
        lines.push(...cachedModels);
        if (charsCount > 0) {
          lines.push(`- Character dictionary: ${charsCount} entries`);
        }
      } else {
        lines.push('**No models cached.** Run `setup_ocr` to download models.');
      }

      // Check MCP server
      if (!ctx.capabilities.has('mcp.client')) {
        lines.push('\n**MCP Client:** not available (enable the MCP Client extension)');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');
      let tools: string[] = [];
      let status = 'not listed';

      try {
        const servers = await mcp.listServers();
        if (servers.includes(SERVER_NAME)) {
          const statuses = mcp.getServerStatuses ? await mcp.getServerStatuses() : [];
          const s = statuses.find((item) => item.name === SERVER_NAME);
          status = s ? `${s.status} (${s.toolCount} tools cached)` : 'running';
          tools = (await mcp.listTools(SERVER_NAME)).map((t) => t.name).sort();
        } else {
          status = 'not configured or not detected';
        }
      } catch {
        status = 'unreachable';
      }

      lines.push(`\n**OCR MCP Server:** ${status}`);
      if (tools.length > 0) {
        lines.push(`**Available tools:** ${tools.join(', ')}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  }));
}

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(ctx: finch.ExtensionContext): void {
  ctx.logger.info('PP-OCRv6 extension activating...');
  registerSetupTool(ctx);
  registerStatusTool(ctx);
  ctx.logger.info('PP-OCRv6 extension activated — setup_ocr and ocr_status tools registered');
}

export function deactivate(): void {
  // ctx.subscriptions.dispose handles cleanup
}
