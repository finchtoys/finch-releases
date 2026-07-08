import type * as finch from 'finch';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SERVER_NAME = 'ocr';
const HF_BASE = 'https://huggingface.co/PaddlePaddle';
const HF_MIRROR = 'https://hf-mirror.com/PaddlePaddle';

type Tier = 'tiny' | 'small' | 'medium';

const TIER_INFO: Record<Tier, { detRepo: string; recRepo: string; detSize: string; recSize: string }> = {
  tiny:   { detRepo: 'PP-OCRv6_tiny_det_onnx',   recRepo: 'PP-OCRv6_tiny_rec_onnx',   detSize: '1.7 MB',  recSize: '4.3 MB' },
  small:  { detRepo: 'PP-OCRv6_small_det_onnx',  recRepo: 'PP-OCRv6_small_rec_onnx',  detSize: '9.4 MB',  recSize: '20.2 MB' },
  medium: { detRepo: 'PP-OCRv6_medium_det_onnx', recRepo: 'PP-OCRv6_medium_rec_onnx', detSize: '59 MB',  recSize: '73 MB' },
};

interface McpClientCapability {
  listServers(): Promise<string[]>;
  getServerStatuses?(): Promise<Array<{ name: string; status: string; toolCount: number }>>;
  listTools(server: string): Promise<Array<{ name: string }>>;
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

function modelMirrorUrl(tier: Tier, type: 'det' | 'rec'): string {
  const info = TIER_INFO[tier];
  const repo = type === 'det' ? info.detRepo : info.recRepo;
  return `${HF_MIRROR}/${repo}/resolve/main/inference.onnx?download=1`;
}

function recYmlUrl(tier: Tier): string {
  const info = TIER_INFO[tier];
  return `${HF_BASE}/${info.recRepo}/resolve/main/inference.yml`;
}

function recYmlMirrorUrl(tier: Tier): string {
  const info = TIER_INFO[tier];
  return `${HF_MIRROR}/${info.recRepo}/resolve/main/inference.yml`;
}

async function downloadFile(url: string, dest: string, logger: finch.Logger, fallbackUrl?: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });

  // Try primary with a 15s timeout — if it hangs (common in China), fast-fail to mirror
  async function tryFetch(u: string, signal?: AbortSignal): Promise<Response> {
    const resp = await fetch(u, { signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  }

  async function tryDownload(u: string, label: string): Promise<boolean> {
    logger.info(`downloading (${label}): ${u}`);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const resp = await tryFetch(u, controller.signal);
      clearTimeout(timer);
      const buffer = Buffer.from(await resp.arrayBuffer());
      writeFileSync(dest, buffer);
      logger.info(`saved to ${dest} (${buffer.byteLength} bytes) from ${label}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`${label} failed: ${msg}`);
      return false;
    }
  }

  if (await tryDownload(url, 'primary')) return;
  if (fallbackUrl && (await tryDownload(fallbackUrl, 'mirror'))) return;
  throw new Error(`Failed to download from both primary and mirror`);
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
    if (!inDict && trimmed.endsWith(' character_dict:')) {
      inDict = true;
      continue;
    }
    if (inDict) {
      // YAML list items: optional spaces + "- " + value
      const match = trimmed.match(/^(\s*)- (.+)$/);
      if (!match) break; // end of list

      let value = match[2];

      // Handle YAML single-quoted strings
      if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
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
  const ymlMirrorUrl = recYmlMirrorUrl(tier);
  const ymlDest = join(modelsDir, 'inference.yml');

  async function tryFetchYml(u: string, signal?: AbortSignal): Promise<Response> {
    const resp = await fetch(u, { signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  }

  async function tryDownloadYml(u: string, label: string): Promise<boolean> {
    logger.info(`downloading inference.yml (${label}): ${u}`);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const resp = await tryFetchYml(u, controller.signal);
      clearTimeout(timer);
      const text = await resp.text();
      writeFileSync(ymlDest, text);
      logger.info(`inference.yml saved from ${label}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`inference.yml ${label} failed: ${msg}`);
      return false;
    }
  }

  let ymlOk = await tryDownloadYml(ymlUrl, 'primary');
  if (!ymlOk && ymlMirrorUrl) ymlOk = await tryDownloadYml(ymlMirrorUrl, 'mirror');
  if (!ymlOk) throw new Error('Failed to download inference.yml from both sources');

  const yamlContent = readFileSync(ymlDest, 'utf-8');

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

// ── Tools ───────────────────────────────────────────────────────────────────

function registerSetupTool(ctx: finch.ExtensionContext): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'setup_ocr',
    title: 'Set up PP-OCRv6',
    description: 'Configure PP-OCRv6 OCR: select model tier (tiny/small/medium) and languages (CN/EN/JA), download ONNX models from HuggingFace on first use, and register the OCR MCP server. Call this when the user says "set up OCR", "configure OCR", "download OCR models", or when an OCR tool reports that models are not yet available.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'medium',
    async execute(_input, exec) {
      // Read defaults from Toolbox settings
      const settingsTier = ctx.settings.get<string>('tier') ?? 'medium';
      const settingsLang = ctx.settings.get<string>('language') ?? 'ch+en';
      const settingsDefaultTier = TIER_INFO[settingsTier as Tier] ? settingsTier : 'medium';

      const result = await exec.ui.requestForm({
        title: ctx.i18n.t('form.setup.title'),
        description: ctx.i18n.t('form.setup.description'),
        submitLabel: ctx.i18n.t('form.setup.submit'),
        fields: [
          {
            key: 'tier',
            label: ctx.i18n.t('form.setup.tier.label'),
            type: 'select',
            default: settingsDefaultTier,
            options: [
              { value: 'tiny',   label: ctx.i18n.t('form.setup.tier.options.tiny') },
              { value: 'small',  label: ctx.i18n.t('form.setup.tier.options.small') },
              { value: 'medium', label: ctx.i18n.t('form.setup.tier.options.medium') },
            ],
          },
          {
            key: 'language',
            label: ctx.i18n.t('form.setup.language.label'),
            type: 'select',
            default: settingsLang,
            options: [
              { value: 'ch+en',    label: ctx.i18n.t('form.setup.language.options.ch+en') },
              { value: 'en',       label: ctx.i18n.t('form.setup.language.options.en') },
              { value: 'ch',       label: ctx.i18n.t('form.setup.language.options.ch') },
              { value: 'ch+en+ja', label: ctx.i18n.t('form.setup.language.options.ch+en+ja') },
            ],
          },
        ],
      });

      if (!result.submitted) {
        return { content: [{ type: 'text', text: ctx.i18n.t('cancelled', { reason: result.reason }) }] };
      }

      const tier = String(result.values.tier ?? 'medium') as Tier;
      const language = String(result.values.language ?? 'ch+en');

      if (!TIER_INFO[tier]) {
        return { content: [{ type: 'text', text: ctx.i18n.t('error.invalidTier', { tier }) }], isError: true };
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
          await downloadFile(modelDownloadUrl(tier, 'det'), detDest, exec.logger, modelMirrorUrl(tier, 'det'));
        } else {
          exec.logger.info('detection model already cached');
        }

        if (!existsSync(recDest)) {
          exec.logger.info('recognition model not cached, downloading...');
          await downloadFile(modelDownloadUrl(tier, 'rec'), recDest, exec.logger, modelMirrorUrl(tier, 'rec'));
        } else {
          exec.logger.info('recognition model already cached');
        }

        // Download and extract character dictionary
        await ensureCharsJson(mdlDir, tier, exec.logger);
      } catch (err) {
        ctx.logger.error('failed to download OCR models', err);
        return {
          content: [{ type: 'text', text: ctx.i18n.t('error.downloadFailed', { message: err instanceof Error ? err.message : String(err) }) }],
          isError: true,
        };
      }

      // Write MCP server config (read by mcp-server.js at startup)
      const configFilePath = join(mdlDir, 'mcp-config.json');
      const config = { detModelPath: detDest, recModelPath: recDest, charsFilePath, language, tier };
      writeFileSync(configFilePath, JSON.stringify(config, null, 2), 'utf-8');

      await ctx.ui.showToast({
        title: ctx.i18n.t('toast.saved.title'),
        description: ctx.i18n.t('toast.saved.description'),
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
    description: 'Check whether PP-OCRv6 is configured, which model tiers are cached on disk, whether the char dictionary was extracted, and whether the OCR MCP server is reachable with tools listed. Call this when the user asks "is OCR working?", "check OCR status", "are models downloaded?", or before troubleshooting OCR failures.',
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
        lines.push(ctx.i18n.t('status.cachedModels'));
        lines.push(...cachedModels);
        if (charsCount > 0) {
          lines.push(ctx.i18n.t('status.charsCount', { count: String(charsCount) }));
        }
      } else {
        lines.push(ctx.i18n.t('status.noModels'));
      }

      // Check MCP server
      if (!ctx.capabilities.has('mcp.client')) {
        lines.push(`\n${ctx.i18n.t('status.mcpUnavailable')}`);
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

      lines.push(`\n${ctx.i18n.t('status.mcpServer', { status })}`);
      if (tools.length > 0) {
        lines.push(ctx.i18n.t('status.availableTools', { tools: tools.join(', ') }));
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  }));
}

interface McpClient {
  callTool(server: string, name: string, args: unknown): Promise<unknown>;
}

function registerOcrImageTool(ctx: finch.ExtensionContext): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'ocr_image',
    title: 'OCR Image',
    description: 'Show a file-picker form for the user to specify an image path, then extract text from that image using PP-OCRv6. Call this when the user wants to extract text from an image or screenshot. Do NOT guess image paths — always use this tool to let the user provide the path.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'low',
    async execute(_input, exec) {
      const result = await exec.ui.requestForm({
        title: '选择图片',
        description: '输入或拖放图片文件路径，PP-OCRv6 将提取其中的文字。',
        submitLabel: '开始识别',
        fields: [
          {
            key: 'imagePath',
            label: '图片路径',
            type: 'text',
            required: true,
            placeholder: '/path/to/image.png 或拖放文件到此处',
          },
        ],
      });

      if (!result.submitted) {
        return { content: [{ type: 'text', text: ctx.i18n.t('cancelled', { reason: result.reason }) }] };
      }

      const imagePath = String(result.values.imagePath ?? '').trim();
      if (!imagePath) {
        return { content: [{ type: 'text', text: '未提供图片路径。' }], isError: true };
      }

      if (!existsSync(imagePath)) {
        return { content: [{ type: 'text', text: `文件不存在: ${imagePath}` }], isError: true };
      }

      // Call the MCP server's ocr_image tool via mcp.client capability
      if (!ctx.capabilities.has('mcp.client')) {
        return { content: [{ type: 'text', text: 'MCP Client 未启用。请先启用 MCP Client 扩展。' }], isError: true };
      }

      const mcp = ctx.capabilities.get<McpClient>('mcp.client');
      try {
        const mcpResult = await mcp.callTool(SERVER_NAME, 'ocr_image', { imagePath }) as any;
        const text = mcpResult?.content?.[0]?.text ?? 'OCR 未返回结果。';
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `OCR 识别失败: ${msg}` }], isError: true };
      }
    },
  }));
}

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(ctx: finch.ExtensionContext): void {
  ctx.logger.info('PP-OCRv6 extension activating...');

  // Always register tools
  registerSetupTool(ctx);
  registerStatusTool(ctx);
  registerOcrImageTool(ctx);

  // Read settings and auto-configure MCP server if models are already cached
  const tier = ctx.settings.get<string>('tier') ?? '';
  const language = ctx.settings.get<string>('language') ?? 'ch+en';
  const mdlDir = modelsDir(ctx);

  if (tier && TIER_INFO[tier as Tier]) {
    const detDest = modelPath(ctx, tier as Tier, 'det');
    const recDest = modelPath(ctx, tier as Tier, 'rec');
    const charsDest = charsPath(ctx);
    const configPath = join(mdlDir, 'mcp-config.json');

    if (existsSync(detDest) && existsSync(recDest) && existsSync(charsDest)) {
      ctx.logger.info(`models cached for tier=${tier}, writing MCP config`);
      try {
        const cfg = { detModelPath: detDest, recModelPath: recDest, charsFilePath: charsDest, language, tier };
        writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
        ctx.logger.info('MCP config written');
      } catch (err) {
        ctx.logger.warn('config write failed', err);
      }
    } else {
      ctx.logger.info(`models not yet cached for tier=${tier}, run setup_ocr to download`);
    }
  } else {
    ctx.logger.info('no tier setting configured, run setup_ocr to set up');
  }

  ctx.logger.info('PP-OCRv6 extension activated');
}

export function deactivate(): void {
  // MCP Client handles server lifecycle via contributes.mcpServers — no cleanup needed.
}
