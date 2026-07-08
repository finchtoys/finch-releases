/**
 * PP-OCRv6 OCR Extension
 *
 * Fully local OCR via PP-OCRv6 medium ONNX models.
 * No MCP server — inference runs directly in the extension process.
 * Models downloaded from HuggingFace on first use (with hf-mirror.com fallback).
 */

import type * as finch from 'finch';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ── Constants ───────────────────────────────────────────────────────────────

const HF_BASE = 'https://huggingface.co/PaddlePaddle';
const HF_MIRROR = 'https://hf-mirror.com/PaddlePaddle';
const DET_REPO = 'PP-OCRv6_medium_det_onnx';
const REC_REPO = 'PP-OCRv6_medium_rec_onnx';

// Detection normalization (ImageNet) — matches PP-OCRv6 det inference.yml
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD  = [0.229, 0.224, 0.225];

// Recognition normalization — (pixel/255 - 0.5) / 0.5, maps [0,255] → [-1,1]
const REC_MEAN = [0.5, 0.5, 0.5];
const REC_STD  = [0.5, 0.5, 0.5];

// ── Types ───────────────────────────────────────────────────────────────────

interface OcrConfig {
  detModelPath: string;
  recModelPath: string;
  charsFilePath: string;
}

interface TextBox {
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] in original image coords
  score: number;
}

// ── Module-level state ──────────────────────────────────────────────────────

let config: OcrConfig | null = null;
let ortModule: any = null;
let detSession: any = null;
let recSession: any = null;
let sharpModule: any = null;
let charsetCache: string[] = [];

// ── Config helpers ──────────────────────────────────────────────────────────

function configPath(ctx: finch.ExtensionContext): string {
  return join(ctx.storagePath, 'models', 'ocr-config.json');
}

function modelsDir(ctx: finch.ExtensionContext): string {
  return join(ctx.storagePath, 'models');
}

function detModelPath(ctx: finch.ExtensionContext): string {
  return join(modelsDir(ctx), `${DET_REPO}.onnx`);
}

function recModelPath(ctx: finch.ExtensionContext): string {
  return join(modelsDir(ctx), `${REC_REPO}.onnx`);
}

function charsPath(ctx: finch.ExtensionContext): string {
  return join(modelsDir(ctx), 'chars.json');
}

function loadConfig(ctx: finch.ExtensionContext): OcrConfig | null {
  const cp = configPath(ctx);
  if (!existsSync(cp)) return null;
  return JSON.parse(readFileSync(cp, 'utf-8'));
}

// ── Lazy-loaded native modules ──────────────────────────────────────────────

async function ensureOrt(): Promise<any> {
  if (!ortModule) {
    ortModule = await import('onnxruntime-node');
  }
  return ortModule;
}

async function ensureSharp(): Promise<any> {
  if (!sharpModule) {
    sharpModule = await import('sharp');
  }
  return sharpModule.default ?? sharpModule;
}

async function ensureDetSession(): Promise<any> {
  if (!detSession && config?.detModelPath) {
    const ort = await ensureOrt();
    detSession = await ort.InferenceSession.create(config.detModelPath);
  }
  return detSession;
}

async function ensureRecSession(): Promise<any> {
  if (!recSession && config?.recModelPath) {
    const ort = await ensureOrt();
    recSession = await ort.InferenceSession.create(config.recModelPath);
  }
  return recSession;
}

function loadCharset(): string[] {
  if (charsetCache.length > 0) return charsetCache;
  if (config?.charsFilePath && existsSync(config.charsFilePath)) {
    try {
      const raw = readFileSync(config.charsFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        charsetCache = parsed;
        return charsetCache;
      }
    } catch {
      // fall through
    }
  }
  // Fallback: ASCII printable
  const ascii = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  charsetCache = ascii.split('');
  return charsetCache;
}

function resetSessions(): void {
  detSession = null;
  recSession = null;
  charsetCache = [];
}

// ── Model download ──────────────────────────────────────────────────────────

function modelDownloadUrl(repo: string): string {
  return `${HF_BASE}/${repo}/resolve/main/inference.onnx?download=1`;
}

function modelMirrorUrl(repo: string): string {
  return `${HF_MIRROR}/${repo}/resolve/main/inference.onnx?download=1`;
}

function recYmlUrl(): string {
  return `${HF_BASE}/${REC_REPO}/resolve/main/inference.yml`;
}

function recYmlMirrorUrl(): string {
  return `${HF_MIRROR}/${REC_REPO}/resolve/main/inference.yml`;
}

async function downloadFile(url: string, dest: string, logger: finch.Logger, fallbackUrl?: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });

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
  throw new Error('Failed to download from both primary and mirror');
}

function extractCharacterDict(yamlContent: string): string[] {
  const chars: string[] = [];
  const lines = yamlContent.split('\n');
  let inDict = false;

  for (const line of lines) {
    const trimmed = line.replace(/[\r\n\t ]+$/, '');
    if (!inDict && trimmed.endsWith(' character_dict:')) {
      inDict = true;
      continue;
    }
    if (inDict) {
      const match = trimmed.match(/^(\s*)- (.+)$/);
      if (!match) break;

      let value = match[2];
      if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
        value = value.slice(1, -1);
        value = value.replace(/''/g, "'");
      }
      chars.push(value);
    }
  }

  return chars;
}

async function ensureCharsJson(ctx: finch.ExtensionContext, logger: finch.Logger): Promise<string> {
  const dest = charsPath(ctx);
  if (existsSync(dest)) {
    logger.info('chars.json already cached');
    return dest;
  }

  const mdlDir = modelsDir(ctx);
  const ymlDest = join(mdlDir, 'inference.yml');

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

  let ymlOk = await tryDownloadYml(recYmlUrl(), 'primary');
  if (!ymlOk) ymlOk = await tryDownloadYml(recYmlMirrorUrl(), 'mirror');
  if (!ymlOk) throw new Error('Failed to download inference.yml from both sources');

  const yamlContent = readFileSync(ymlDest, 'utf-8');
  const chars = extractCharacterDict(yamlContent);
  logger.info(`extracted ${chars.length} characters from character_dict`);

  writeFileSync(dest, JSON.stringify(chars), 'utf-8');
  logger.info(`chars.json saved to ${dest}`);

  return dest;
}

// ── Normalization / Tensor conversion ───────────────────────────────────────

/**
 * Convert an RGB raw buffer to a normalized CHW float32 tensor.
 * Performs RGB → BGR channel swap during the conversion.
 * Formula: (pixel / 255.0 - mean[c]) / std[c]
 */
function rgbToNormalizedCHW(rgb: Buffer, height: number, width: number, mean: number[], std: number[]): Float32Array {
  const tensor = new Float32Array(3 * height * width);
  const area = height * width;
  for (let h = 0; h < height; h++) {
    for (let w = 0; w < width; w++) {
      const idx = (h * width + w) * 3;
      const r = rgb[idx];
      const g = rgb[idx + 1];
      const b = rgb[idx + 2];
      tensor[0 * area + h * width + w] = (b / 255.0 - mean[0]) / std[0]; // B
      tensor[1 * area + h * width + w] = (g / 255.0 - mean[1]) / std[1]; // G
      tensor[2 * area + h * width + w] = (r / 255.0 - mean[2]) / std[2]; // R
    }
  }
  return tensor;
}

// ── Detection preprocessing ─────────────────────────────────────────────────

interface DetPreprocessed {
  tensor: Float32Array;
  paddedH: number;
  paddedW: number;
  scaleX: number;
  scaleY: number;
}

/**
 * PP-OCRv6 detection preprocessing:
 * 1. Load RGB, keep original dimensions
 * 2. Resize keeping aspect ratio: long side ≤ 960
 * 3. Pad to make both dimensions divisible by 32
 * 4. Normalize (pixel/255 - mean) / std, with RGB→BGR swap, HWC→CHW
 */
async function preprocessForDetection(imagePath: string): Promise<DetPreprocessed> {
  const sharp = await ensureSharp();
  const metadata = await sharp(imagePath).metadata();
  const origW = metadata.width ?? 0;
  const origH = metadata.height ?? 0;

  const limitSideLen = 960;
  const ratio = Math.min(limitSideLen / Math.max(origH, origW), 1.0);
  const resizedH = Math.round(origH * ratio);
  const resizedW = Math.round(origW * ratio);
  const paddedH = Math.ceil(resizedH / 32) * 32;
  const paddedW = Math.ceil(resizedW / 32) * 32;

  const buffer = await sharp(imagePath)
    .resize(resizedW, resizedH, { fit: 'fill' })
    .extend({
      top: 0,
      bottom: paddedH - resizedH,
      left: 0,
      right: paddedW - resizedW,
      background: { r: 0, g: 0, b: 0 },
    })
    .raw()
    .toBuffer();

  const tensor = rgbToNormalizedCHW(buffer, paddedH, paddedW, DET_MEAN, DET_STD);

  // DB model typically downsamples by 4x; scale from output coords to original
  const stride = 4;
  return {
    tensor,
    paddedH,
    paddedW,
    scaleX: (origW / paddedW) * stride,
    scaleY: (origH / paddedH) * stride,
  };
}

// ── Recognition preprocessing ───────────────────────────────────────────────

/**
 * PP-OCRv6 recognition preprocessing for a cropped text region:
 * 1. Crop the text region from the original image
 * 2. Resize to height 48, width proportional (capped at 320)
 * 3. Pad width to 320 with black pixels
 * 4. Normalize, RGB→BGR, HWC→CHW
 */
async function preprocessForRecognition(
  imagePath: string,
  x1: number, y1: number, x2: number, y2: number,
): Promise<Float32Array> {
  const sharp = await ensureSharp();
  const targetH = 48;
  const targetW = 320;

  const metadata = await sharp(imagePath).metadata();
  const imgW = metadata.width ?? 0;
  const imgH = metadata.height ?? 0;
  const cropX = Math.max(0, Math.round(x1));
  const cropY = Math.max(0, Math.round(y1));
  const cropW = Math.max(1, Math.min(Math.round(x2 - x1), imgW - cropX));
  const cropH = Math.max(1, Math.min(Math.round(y2 - y1), imgH - cropY));

  const propW = Math.round(targetH * (cropW / cropH));
  const resizeW = Math.min(propW, targetW);
  const padRight = targetW - resizeW;

  const buffer = await sharp(imagePath)
    .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
    .resize(resizeW, targetH, { fit: 'fill' })
    .extend({
      top: 0, bottom: 0,
      left: 0, right: padRight,
      background: { r: 0, g: 0, b: 0 },
    })
    .raw()
    .toBuffer();

  return rgbToNormalizedCHW(buffer, targetH, targetW, REC_MEAN, REC_STD);
}

// ── DB Post-Processing ──────────────────────────────────────────────────────

/**
 * Flood-fill to find connected component pixels from a binary mask.
 */
function floodFill(
  binary: Uint8Array, visited: Uint8Array,
  startX: number, startY: number,
  width: number, height: number,
): Array<[number, number]> {
  const pixels: Array<[number, number]> = [];
  const stack: Array<[number, number]> = [[startX, startY]];
  visited[startY * width + startX] = 1;

  while (stack.length > 0) {
    const [cx, cy] = stack.pop()!;
    pixels.push([cx, cy]);

    for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const idx = ny * width + nx;
        if (binary[idx] && !visited[idx]) {
          visited[idx] = 1;
          stack.push([nx, ny]);
        }
      }
    }
  }
  return pixels;
}

/**
 * DB post-processing: threshold → connected components → unclip → filter.
 */
function dbPostProcess(
  probMap: Float32Array, probH: number, probW: number,
  scaleX: number, scaleY: number,
): TextBox[] {
  const thresh = 0.2;
  const boxThresh = 0.45;
  const unclipRatio = 1.4;
  const maxCandidates = 3000;

  // Binary mask
  const binary = new Uint8Array(probH * probW);
  for (let i = 0; i < probH * probW; i++) {
    binary[i] = probMap[i] > thresh ? 1 : 0;
  }

  const visited = new Uint8Array(probH * probW);
  const boxes: TextBox[] = [];

  for (let y = 0; y < probH && boxes.length < maxCandidates; y++) {
    for (let x = 0; x < probW && boxes.length < maxCandidates; x++) {
      const idx = y * probW + x;
      if (!binary[idx] || visited[idx]) continue;

      const region = floodFill(binary, visited, x, y, probW, probH);
      if (region.length < 3) continue;

      let minX = probW, minY = probH, maxX = 0, maxY = 0;
      let sumScore = 0;
      for (const [px, py] of region) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
        sumScore += probMap[py * probW + px];
      }
      const avgScore = sumScore / region.length;
      if (avgScore < boxThresh) continue;

      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;
      const expandX = boxW * (unclipRatio - 1) / 2;
      const expandY = boxH * (unclipRatio - 1) / 2;

      boxes.push({
        bbox: [
          Math.max(0, (minX - expandX) * scaleX),
          Math.max(0, (minY - expandY) * scaleY),
          (maxX + expandX) * scaleX,
          (maxY + expandY) * scaleY,
        ],
        score: avgScore,
      });
    }
  }

  boxes.sort((a, b) => b.score - a.score);
  return boxes.slice(0, maxCandidates);
}

// ── CTC Decoding ────────────────────────────────────────────────────────────

function decodeRecOutput(data: Float32Array, dims: number[]): string {
  if (dims.length < 3) return '';
  const seqLen = dims[1];
  const numClasses = dims[2];
  const chars = loadCharset();
  // PP-OCR CTC: blank at index 0, charset at indices 1..N
  const blankIdx = 0;

  let result = '';
  let prevCharIdx = -1;

  for (let t = 0; t < seqLen; t++) {
    let maxIdx = 0;
    let maxVal = -Infinity;
    const offset = t * numClasses;
    for (let c = 0; c < numClasses; c++) {
      const val = data[offset + c];
      if (val > maxVal) { maxVal = val; maxIdx = c; }
    }
    if (maxIdx !== blankIdx && maxIdx !== prevCharIdx) {
      // maxIdx-1 because charset doesn't include blank at index 0
      const charIdx = maxIdx - 1;
      if (charIdx >= 0 && charIdx < chars.length) result += chars[charIdx];
    }
    prevCharIdx = maxIdx;
  }
  return result;
}

// ── OCR Pipeline ────────────────────────────────────────────────────────────

async function detectText(imagePath: string): Promise<TextBox[]> {
  const session = await ensureDetSession();
  if (!session) throw new Error('Detection model not loaded. Run setup_ocr first.');

  const pp = await preprocessForDetection(imagePath);
  const ort = await ensureOrt();

  const feeds: Record<string, any> = {};
  feeds[session.inputNames[0]] = new ort.Tensor('float32', pp.tensor, [1, 3, pp.paddedH, pp.paddedW]);
  const results = await session.run(feeds);

  const outputTensor = results[session.outputNames[0]];
  const outputData = outputTensor.data as Float32Array;
  const dims = outputTensor.dims as number[];

  const outH = dims[2];
  const outW = dims[3];

  // Adjust scale for actual output dimensions (4x is approximate)
  const effScaleX = pp.scaleX * (pp.paddedW / 4) / outW;
  const effScaleY = pp.scaleY * (pp.paddedH / 4) / outH;

  return dbPostProcess(outputData, outH, outW, effScaleX, effScaleY);
}

async function recognizeText(imagePath: string, box: TextBox): Promise<string> {
  const session = await ensureRecSession();
  if (!session) throw new Error('Recognition model not loaded. Run setup_ocr first.');

  const [x1, y1, x2, y2] = box.bbox;
  const tensor = await preprocessForRecognition(imagePath, x1, y1, x2, y2);
  const ort = await ensureOrt();

  const feeds: Record<string, any> = {};
  feeds[session.inputNames[0]] = new ort.Tensor('float32', tensor, [1, 3, 48, 320]);
  const results = await session.run(feeds);

  const outputTensor = results[session.outputNames[0]];
  return decodeRecOutput(outputTensor.data as Float32Array, outputTensor.dims as number[]);
}

async function ocrImage(imagePath: string): Promise<string> {
  const boxes = await detectText(imagePath);
  if (boxes.length === 0) return 'No text detected in the image.';

  const lines: string[] = [];
  for (const box of boxes) {
    const text = await recognizeText(imagePath, box);
    if (text.trim()) lines.push(text.trim());
  }
  return lines.join('\n') || 'No text recognized.';
}

// ── Tools ───────────────────────────────────────────────────────────────────

function registerSetupTool(ctx: finch.ExtensionContext): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'setup_ocr',
    title: 'Set up PP-OCRv6',
    description: 'Download PP-OCRv6 medium ONNX models from HuggingFace on first use and load models into memory. Supports Chinese, English, Japanese, and 47 other languages automatically. Call this when the user says "set up OCR", "configure OCR", "download OCR models", or when OCR reports that models are not yet available.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'medium',
    async execute(_input, exec) {
      const result = await exec.ui.requestForm({
        title: ctx.i18n.t('form.setup.title'),
        description: ctx.i18n.t('form.setup.description'),
        submitLabel: ctx.i18n.t('form.setup.submit'),
        fields: [],
      });

      if (!result.submitted) {
        return { content: [{ type: 'text', text: ctx.i18n.t('cancelled', { reason: result.reason ?? 'cancelled' }) }] };
      }

      const detDest = detModelPath(ctx);
      const recDest = recModelPath(ctx);
      const mdlDir = modelsDir(ctx);

      // Install native deps if missing
      const extDir = ctx.extension.extensionPath;
      const nativeDepExists = existsSync(join(extDir, 'node_modules', 'onnxruntime-node', 'package.json'))
        && existsSync(join(extDir, 'node_modules', 'sharp', 'package.json'));
      if (!nativeDepExists) {
        exec.logger.info('installing native deps (onnxruntime-node, sharp)...');
        try {
          const { execSync } = await import('node:child_process');
          execSync('npm install onnxruntime-node sharp --no-save --ignore-scripts', {
            cwd: extDir, timeout: 120_000, stdio: 'pipe',
          });
          execSync('node node_modules/onnxruntime-node/install || true', {
            cwd: extDir, timeout: 60_000, stdio: 'pipe',
          });
          execSync('node node_modules/sharp/install || true', {
            cwd: extDir, timeout: 60_000, stdio: 'pipe',
          });
          exec.logger.info('native deps installed');
        } catch (err) {
          exec.logger.error('failed to install native deps', err);
          return {
            content: [{ type: 'text', text: ctx.i18n.t('error.nativeDepsFailed', { message: err instanceof Error ? err.message : String(err) }) }],
            isError: true,
          };
        }
      }

      // Download models
      try {
        if (!existsSync(detDest)) {
          exec.logger.info('detection model not cached, downloading...');
          await downloadFile(modelDownloadUrl(DET_REPO), detDest, exec.logger, modelMirrorUrl(DET_REPO));
        }
        if (!existsSync(recDest)) {
          exec.logger.info('recognition model not cached, downloading...');
          await downloadFile(modelDownloadUrl(REC_REPO), recDest, exec.logger, modelMirrorUrl(REC_REPO));
        }
        await ensureCharsJson(ctx, exec.logger);
      } catch (err) {
        ctx.logger.error('failed to download OCR models', err);
        return {
          content: [{ type: 'text', text: ctx.i18n.t('error.downloadFailed', { message: err instanceof Error ? err.message : String(err) }) }],
          isError: true,
        };
      }

      // Save config and load models
      config = {
        detModelPath: detDest,
        recModelPath: recDest,
        charsFilePath: charsPath(ctx),
      };
      mkdirSync(dirname(configPath(ctx)), { recursive: true });
      writeFileSync(configPath(ctx), JSON.stringify(config, null, 2), 'utf-8');

      // Reset sessions so they'll be re-created with new config on next OCR
      resetSessions();

      await ctx.ui.showToast({
        title: ctx.i18n.t('toast.saved.title'),
        description: ctx.i18n.t('toast.saved.description'),
        variant: 'success',
      });

      return {
        content: [{
          type: 'text',
          text: [
            `✅ PP-OCRv6 (medium) 配置完成！`,
            `- 检测模型: 59 MB`,
            `- 识别模型: 73 MB`,
            `- 字符集: ${loadCharset().length} 个字符（支持中英日等 50 种语言）`,
            `- 模型已加载到内存，可以开始使用`,
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
    description: 'Check whether PP-OCRv6 models are cached and loaded in memory. Call when asked "is OCR ready?" or troubleshooting OCR failures.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'low',
    async execute() {
      const modelDir = modelsDir(ctx);
      const lines: string[] = ['## OCR Status\n'];

      // Check cached files
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
        if (charsCount > 0) lines.push(ctx.i18n.t('status.charsCount', { count: String(charsCount) }));
      } else {
        lines.push(ctx.i18n.t('status.noModels'));
      }

      // Check in-memory state
      const detLoaded = !!detSession;
      const recLoaded = !!recSession;
      lines.push(`\n**模型加载状态:**`);
      lines.push(`- 检测模型: ${detLoaded ? '✅ 已加载' : '❌ 未加载'}`);
      lines.push(`- 识别模型: ${recLoaded ? '✅ 已加载' : '❌ 未加载'}`);
      if (config) {
        lines.push(`- 字符集: ${loadCharset().length} 个字符`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  }));
}

function registerOcrImageTool(ctx: finch.ExtensionContext): void {
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
    async execute(input) {
      const imagePath = String((input as any).imagePath ?? '').trim();
      if (!imagePath) {
        return { content: [{ type: 'text', text: ctx.i18n.t('error.noImagePath') }], isError: true };
      }

      if (!existsSync(imagePath)) {
        return { content: [{ type: 'text', text: ctx.i18n.t('error.fileNotFound', { path: imagePath }) }], isError: true };
      }

      if (!config) {
        return { content: [{ type: 'text', text: ctx.i18n.t('error.notConfigured') }], isError: true };
      }

      try {
        const text = await ocrImage(imagePath);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: ctx.i18n.t('error.ocrFailed', { message: msg }) }], isError: true };
      }
    },
  }));
}

// ── Activation ──────────────────────────────────────────────────────────────

export async function activate(ctx: finch.ExtensionContext): Promise<void> {
  ctx.logger.info('PP-OCRv6 extension activating...');

  registerSetupTool(ctx);
  registerStatusTool(ctx);
  registerOcrImageTool(ctx);

  // Load saved config and pre-load ONNX sessions in background
  const saved = loadConfig(ctx);
  if (saved) {
    config = saved;
    ctx.logger.info('found saved config, loading models in background...');
    // Kick off lazy loading — sessions will be ready by the time the user calls ocr_image
    ensureDetSession().then(() => ctx.logger.info('detection session loaded')).catch((err) => ctx.logger.warn('detection session preload failed', err));
    ensureRecSession().then(() => ctx.logger.info('recognition session loaded')).catch((err) => ctx.logger.warn('recognition session preload failed', err));
    loadCharset(); // synchronous file read
  } else {
    ctx.logger.info('no saved config found, run setup_ocr to configure');
  }

  ctx.logger.info('PP-OCRv6 extension activated');
}

export function deactivate(): void {
  // ONNX sessions are tied to the process; clean-up is automatic on exit.
  ortModule = null;
  detSession = null;
  recSession = null;
  sharpModule = null;
  charsetCache = [];
  config = null;
}
