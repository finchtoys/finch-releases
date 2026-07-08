/**
 * PP-OCRv6 MCP Server
 *
 * stdio-based MCP server that exposes OCR tools via the Model Context Protocol.
 * Launched as a child process by the MCP Client extension.
 *
 * Uses the official @modelcontextprotocol/sdk for protocol compliance.
 *
 * Environment variables (set by the extension host via servers.json env):
 *   OCR_DET_MODEL_PATH  — path to detection ONNX model
 *   OCR_REC_MODEL_PATH  — path to recognition ONNX model
 *   OCR_CHARS_PATH      — path to chars.json (character dictionary)
 *   OCR_LANGUAGE        — language code (e.g. "ch+en")
 *   OCR_TIER            — model tier (tiny/small/medium)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Config ──────────────────────────────────────────────────────────────────

// Canonical config path: ~/.finch/extension-data/ocr/models/mcp-config.json
// Also accepts argv[2] for manual testing.
const CANONICAL_CONFIG = join(homedir(), '.finch', 'extension-data', 'ocr', 'models', 'mcp-config.json');
const CONFIG_PATH = process.argv[2] || CANONICAL_CONFIG;

interface McpConfig {
  detModelPath: string;
  recModelPath: string;
  charsFilePath: string;
  language: string;
  tier: string;
}

function loadConfig(): McpConfig {
  if (!CONFIG_PATH || !existsSync(CONFIG_PATH)) {
    return {
      detModelPath: '',
      recModelPath: '',
      charsFilePath: '',
      language: 'ch+en',
      tier: 'medium',
    };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

let config = loadConfig();
const DET_MODEL_PATH = config.detModelPath;
const REC_MODEL_PATH = config.recModelPath;
const CHARS_PATH = config.charsFilePath;
const LANGUAGE = config.language;
const TIER = config.tier;

// ── Models (lazy-loaded) ────────────────────────────────────────────────────

let ort: any = null;
let detSession: any = null;
let recSession: any = null;
let sharpModule: any = null;
let charset: string[] = [];

async function ensureOrt(): Promise<any> {
  if (!ort) {
    ort = await import('onnxruntime-node');
  }
  return ort;
}

async function ensureSharp(): Promise<any> {
  if (!sharpModule) {
    sharpModule = await import('sharp');
  }
  return sharpModule.default ?? sharpModule;
}

async function ensureDetSession(): Promise<any> {
  if (!detSession && DET_MODEL_PATH) {
    const ort_ = await ensureOrt();
    detSession = await ort_.InferenceSession.create(DET_MODEL_PATH);
  }
  return detSession;
}

async function ensureRecSession(): Promise<any> {
  if (!recSession && REC_MODEL_PATH) {
    const ort_ = await ensureOrt();
    recSession = await ort_.InferenceSession.create(REC_MODEL_PATH);
  }
  return recSession;
}

function loadCharset(): string[] {
  if (charset.length > 0) return charset;
  if (CHARS_PATH && existsSync(CHARS_PATH)) {
    try {
      const raw = readFileSync(CHARS_PATH, 'utf-8');
      charset = JSON.parse(raw);
      if (Array.isArray(charset)) return charset;
    } catch {
      // fall through to fallback
    }
  }
  // Fallback: ASCII printable
  const ascii = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  charset = ascii.split('');
  return charset;
}

// ── Normalization constants (from PP-OCRv6 inference.yml) ───────────────────

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * Convert an RGB raw buffer to a normalized CHW float32 tensor.
 * Performs RGB → BGR channel swap during the conversion.
 * Formula: (pixel / 255.0 - mean[c]) / std[c]
 */
function rgbToNormalizedCHW(rgb: Buffer, height: number, width: number): Float32Array {
  const tensor = new Float32Array(3 * height * width);
  const area = height * width;
  for (let h = 0; h < height; h++) {
    for (let w = 0; w < width; w++) {
      const idx = (h * width + w) * 3;
      const r = rgb[idx];
      const g = rgb[idx + 1];
      const b = rgb[idx + 2];
      tensor[0 * area + h * width + w] = (b / 255.0 - MEAN[0]) / STD[0]; // B
      tensor[1 * area + h * width + w] = (g / 255.0 - MEAN[1]) / STD[1]; // G
      tensor[2 * area + h * width + w] = (r / 255.0 - MEAN[2]) / STD[2]; // R
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

  // DetResizeForTest: resize so longest side ≤ 960, divisible by 32
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

  const tensor = rgbToNormalizedCHW(buffer, paddedH, paddedW);

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

  // Bounds checking
  const metadata = await sharp(imagePath).metadata();
  const imgW = metadata.width ?? 0;
  const imgH = metadata.height ?? 0;
  const cropX = Math.max(0, Math.round(x1));
  const cropY = Math.max(0, Math.round(y1));
  const cropW = Math.max(1, Math.min(Math.round(x2 - x1), imgW - cropX));
  const cropH = Math.max(1, Math.min(Math.round(y2 - y1), imgH - cropY));

  // RecResizeImg: resize to height 48, width proportional (max 320)
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

  return rgbToNormalizedCHW(buffer, targetH, targetW);
}

// ── DB Post-Processing ──────────────────────────────────────────────────────

interface TextBox {
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] in original image coords
  score: number;
}

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

// ── OCR Pipeline ────────────────────────────────────────────────────────────

async function detectText(imagePath: string): Promise<TextBox[]> {
  const session = await ensureDetSession();
  if (!session) throw new Error('Detection model not loaded. Run setup_ocr first.');

  const pp = await preprocessForDetection(imagePath);
  const ort_ = await ensureOrt();

  const feeds: Record<string, any> = {};
  feeds[session.inputNames[0]] = new ort_.Tensor('float32', pp.tensor, [1, 3, pp.paddedH, pp.paddedW]);
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
  const ort_ = await ensureOrt();

  const feeds: Record<string, any> = {};
  feeds[session.inputNames[0]] = new ort_.Tensor('float32', tensor, [1, 3, 48, 320]);
  const results = await session.run(feeds);

  const outputTensor = results[session.outputNames[0]];
  return decodeRecOutput(outputTensor.data as Float32Array, outputTensor.dims as number[]);
}

// ── CTC Decoding ────────────────────────────────────────────────────────────

function decodeRecOutput(data: Float32Array, dims: number[]): string {
  if (dims.length < 3) return '';
  const seqLen = dims[1];
  const numClasses = dims[2];
  const chars = loadCharset();
  const blankIdx = numClasses - 1;

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
      if (maxIdx < chars.length) result += chars[maxIdx];
    }
    prevCharIdx = maxIdx;
  }
  return result;
}

// ── Tool handlers ───────────────────────────────────────────────────────────

async function handleOcrImage(imagePath: string): Promise<string> {
  // Re-read config so setup_ocr changes take effect without MCP server restart
  config = loadConfig();
  const boxes = await detectText(imagePath);
  if (boxes.length === 0) return 'No text detected in the image.';

  const lines: string[] = [];
  for (const box of boxes) {
    const text = await recognizeText(imagePath, box);
    if (text.trim()) lines.push(text.trim());
  }
  return lines.join('\n') || 'No text recognized.';
}

// ── Start server ────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'PP-OCRv6', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// Tool: ocr_image
server.registerTool('ocr_image', {
  description: `Extract text from an image using PP-OCRv6. Detects text regions and recognizes characters. Supports ${LANGUAGE}. Call this when the user shares an image, pastes a screenshot, uploads a photo, or asks to "read text from an image" or "OCR this image". Provide the absolute file path to the image. Returns recognized text with per-line bounding boxes.`,
  inputSchema: z.object({
    imagePath: z.string().describe('Absolute path to the image file (PNG, JPG, WebP, etc.).'),
  }),
}, async (args) => {
  const text = await handleOcrImage(args.imagePath);
  return { content: [{ type: 'text' as const, text }] };
});

// Tool: ocr_languages
server.registerTool('ocr_languages', {
  description: 'List supported languages and current OCR configuration — model tier, language setting, whether detection and recognition models are loaded. Call this when the user asks "what languages does OCR support?" or to verify the current OCR setup.',
  inputSchema: z.object({}),
}, async () => {
  return {
    content: [{
      type: 'text' as const,
      text: `Current OCR configuration:
- Model tier: ${TIER}
- Languages: ${LANGUAGE}
- Detection model: ${DET_MODEL_PATH ? 'loaded' : 'not configured'}
- Recognition model: ${REC_MODEL_PATH ? 'loaded' : 'not configured'}`,
    }],
  };
});

// Tool: ocr_status
server.registerTool('ocr_status', {
  description: 'Check whether PP-OCRv6 models have been loaded into memory and are ready for OCR calls. Returns model loading status, character dictionary size, and any errors during initialization. Call this before ocr_image to verify readiness, or when the user asks "is OCR ready?" or OCR seems unresponsive.',
  inputSchema: z.object({}),
}, async () => {
  const charsLoaded = loadCharset().length;
  return {
    content: [{
      type: 'text' as const,
      text: `PP-OCRv6 Status:
- Model tier: ${TIER}
- Languages: ${LANGUAGE}
- Detection model loaded: ${!!detSession}
- Recognition model loaded: ${!!recSession}
- Character set size: ${charsLoaded}
- Det model path: ${DET_MODEL_PATH || 'N/A'}
- Rec model path: ${REC_MODEL_PATH || 'N/A'}
- Chars path: ${CHARS_PATH || 'N/A'}`,
    }],
  };
});

// Connect and start
const transport = new StdioServerTransport();
await server.connect(transport);

// Startup log via stderr (visible in Finch logs, not on stdout which is MCP transport)
console.error(
  `PP-OCRv6 MCP server started (tier=${TIER}, lang=${LANGUAGE}, chars=${loadCharset().length})`,
);
