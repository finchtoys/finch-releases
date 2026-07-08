/**
 * PP-OCRv6 MCP Server
 *
 * stdio-based MCP server that exposes OCR tools via the Model Context Protocol.
 * Launched as a child process by the MCP Client extension.
 *
 * Environment variables (set by the extension host via servers.json env):
 *   OCR_DET_MODEL_PATH  — path to detection ONNX model
 *   OCR_REC_MODEL_PATH  — path to recognition ONNX model
 *   OCR_CHARS_PATH      — path to chars.json (character dictionary)
 *   OCR_LANGUAGE        — language code (e.g. "ch+en")
 *   OCR_TIER            — model tier (tiny/small/medium)
 */

import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';

// ── Config from env ─────────────────────────────────────────────────────────

const DET_MODEL_PATH = process.env.OCR_DET_MODEL_PATH ?? '';
const REC_MODEL_PATH = process.env.OCR_REC_MODEL_PATH ?? '';
const CHARS_PATH = process.env.OCR_CHARS_PATH ?? '';
const LANGUAGE = process.env.OCR_LANGUAGE ?? 'ch+en';
const TIER = process.env.OCR_TIER ?? 'medium';

// ── Models will be loaded lazily ─────────────────────────────────────────────

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
      if (Array.isArray(charset)) {
        return charset;
      }
    } catch {
      // fall through to fallback
    }
  }
  // Fallback minimal charset (ASCII printable + common CJK)
  const ascii = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  charset = ascii.split('');
  return charset;
}

// ── Normalization constants (from inference.yml) ────────────────────────────

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * Convert an RGB raw buffer to a normalized CHW float32 tensor.
 * Also performs RGB → BGR channel swap during the conversion.
 * Formula: (pixel / 255.0 - mean[c]) / std[c]
 */
function rgbToNormalizedCHW(
  rgb: Buffer,
  height: number,
  width: number,
): Float32Array {
  const tensor = new Float32Array(3 * height * width);
  const area = height * width;
  for (let h = 0; h < height; h++) {
    for (let w = 0; w < width; w++) {
      const idx = (h * width + w) * 3;
      const r = rgb[idx];
      const g = rgb[idx + 1];
      const b = rgb[idx + 2];
      // CHW layout: channel 0=B, 1=G, 2=R
      tensor[0 * area + h * width + w] = (b / 255.0 - MEAN[0]) / STD[0];
      tensor[1 * area + h * width + w] = (g / 255.0 - MEAN[1]) / STD[1];
      tensor[2 * area + h * width + w] = (r / 255.0 - MEAN[2]) / STD[2];
    }
  }
  return tensor;
}

// ── Detection preprocessing ─────────────────────────────────────────────────

interface DetPreprocessed {
  /** Normalized CHW float32 tensor [3, paddedH, paddedW] */
  tensor: Float32Array;
  paddedH: number;
  paddedW: number;
  /** Scale factor from output-coords to original-image-coords */
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

  // Step 1: compute resize dimensions (DetResizeForTest)
  const limitSideLen = 960;
  const ratio = Math.min(limitSideLen / Math.max(origH, origW), 1.0);
  const resizedH = Math.round(origH * ratio);
  const resizedW = Math.round(origW * ratio);

  // Step 2: pad to be divisible by 32
  const paddedH = Math.ceil(resizedH / 32) * 32;
  const paddedW = Math.ceil(resizedW / 32) * 32;

  // Step 3: load, resize, pad, get raw RGB
  const buffer = await sharp(imagePath)
    .resize(resizedW, resizedH, { fit: 'fill' })
    .extend({
      top: 0,
      bottom: paddedH - resizedH,
      left: 0,
      right: paddedW - resizedW,
      background: { r: 0, g: 0, b: 0 },
    })
    .raw() // outputs RGB (3 channels)
    .toBuffer();

  // Step 4: normalize, RGB→BGR, HWC→CHW
  const tensor = rgbToNormalizedCHW(buffer, paddedH, paddedW);

  // Scale from output tensor coords back to original image coords
  // Model output is at 1/4 resolution of padded input (DB standard)
  const stride = 4;
  const outH = paddedH / stride;
  const outW = paddedW / stride;
  // Each output pixel maps to stride pixels in the padded input
  // padded → original: scale = orig / padded
  const scaleX = origW / paddedW;
  const scaleY = origH / paddedH;

  return { tensor, paddedH, paddedW, scaleX: scaleX * stride, scaleY: scaleY * stride };
}

// ── Recognition preprocessing ───────────────────────────────────────────────

/**
 * PP-OCRv6 recognition preprocessing for a cropped text region:
 * 1. Crop the text region from the original image
 * 2. Resize to height 48, width proportional (capped at 320)
 * 3. Pad width to 320 with black pixels
 * 4. Normalize (pixel/255 - mean) / std, with RGB→BGR swap, HWC→CHW
 */
async function preprocessForRecognition(
  imagePath: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
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
  const cropWidth = Math.max(1, Math.min(Math.round(x2 - x1), imgW - cropX));
  const cropHeight = Math.max(1, Math.min(Math.round(y2 - y1), imgH - cropY));

  // Compute proportional width (RecResizeImg)
  const aspectRatio = cropWidth / cropHeight;
  let propW = Math.round(targetH * aspectRatio);
  // Cap at targetW (320), otherwise pad to targetW
  const resizeW = Math.min(propW, targetW);
  const padRight = targetW - resizeW;

  // Crop, resize, pad, output raw RGB
  const buffer = await sharp(imagePath)
    .extract({ left: cropX, top: cropY, width: cropWidth, height: cropHeight })
    .resize(resizeW, targetH, { fit: 'fill' })
    .extend({
      top: 0,
      bottom: 0,
      left: 0,
      right: padRight,
      background: { r: 0, g: 0, b: 0 },
    })
    .raw()
    .toBuffer();

  // Normalize, RGB→BGR, HWC→CHW
  return rgbToNormalizedCHW(buffer, targetH, targetW);
}

// ── DB Post-Processing ──────────────────────────────────────────────────────

interface TextBox {
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] in original image coords
  score: number;
}

/**
 * Simple flood-fill to find connected component pixels from a binary mask.
 */
function floodFill(
  binary: Uint8Array,
  visited: Uint8Array,
  startX: number,
  startY: number,
  width: number,
  height: number,
): Array<[number, number]> {
  const pixels: Array<[number, number]> = [];
  const stack: Array<[number, number]> = [[startX, startY]];
  visited[startY * width + startX] = 1;

  while (stack.length > 0) {
    const [cx, cy] = stack.pop()!;
    pixels.push([cx, cy]);

    // 4-connectivity
    const neighbors: Array<[number, number]> = [
      [cx - 1, cy], [cx + 1, cy],
      [cx, cy - 1], [cx, cy + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const nIdx = ny * width + nx;
        if (binary[nIdx] && !visited[nIdx]) {
          visited[nIdx] = 1;
          stack.push([nx, ny]);
        }
      }
    }
  }

  return pixels;
}

/**
 * Differentiable Binarization (DB) post-processing.
 * Converts the model's probability map to bounding boxes.
 */
function dbPostProcess(
  probMap: Float32Array,
  probH: number,
  probW: number,
  scaleX: number,
  scaleY: number,
): TextBox[] {
  const thresh = 0.2;        // DB binarization threshold
  const boxThresh = 0.45;    // minimum average score per box
  const unclipRatio = 1.4;   // expand ratio
  const maxCandidates = 3000;

  // Step 1: threshold to binary mask
  const binary = new Uint8Array(probH * probW);
  for (let i = 0; i < probH * probW; i++) {
    binary[i] = probMap[i] > thresh ? 1 : 0;
  }

  // Step 2: connected components via flood fill
  const visited = new Uint8Array(probH * probW);
  const boxes: TextBox[] = [];

  for (let y = 0; y < probH && boxes.length < maxCandidates; y++) {
    for (let x = 0; x < probW && boxes.length < maxCandidates; x++) {
      const idx = y * probW + x;
      if (!binary[idx] || visited[idx]) continue;

      const region = floodFill(binary, visited, x, y, probW, probH);
      if (region.length < 3) continue; // too small

      // Step 3: compute bounding box + average score
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

      // Step 4: filter by score threshold
      if (avgScore < boxThresh) continue;

      // Step 5: apply unclip (expand) to the box
      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;
      const expandX = boxW * (unclipRatio - 1) / 2;
      const expandY = boxH * (unclipRatio - 1) / 2;

      // Step 6: map to original image coordinates
      const origMinX = Math.max(0, (minX - expandX) * scaleX);
      const origMinY = Math.max(0, (minY - expandY) * scaleY);
      const origMaxX = (maxX + expandX) * scaleX;
      const origMaxY = (maxY + expandY) * scaleY;

      boxes.push({
        bbox: [origMinX, origMinY, origMaxX, origMaxY],
        score: avgScore,
      });
    }
  }

  // Sort by score descending, keep the best ones
  boxes.sort((a, b) => b.score - a.score);
  return boxes.slice(0, maxCandidates);
}

// ── OCR Pipeline ────────────────────────────────────────────────────────────

async function detectText(imagePath: string): Promise<TextBox[]> {
  const session = await ensureDetSession();
  if (!session) {
    throw new Error('Detection model not loaded. Run setup_ocr first.');
  }

  const preprocessed = await preprocessForDetection(imagePath);
  const { tensor, paddedH, paddedW, scaleX, scaleY } = preprocessed;

  // Run inference
  const inputName = session.inputNames[0];
  const feeds: Record<string, any> = {};
  const ort_ = await ensureOrt();
  feeds[inputName] = new ort_.Tensor('float32', tensor, [1, 3, paddedH, paddedW]);
  const results = await session.run(feeds);

  // Get output probability map
  const outputName = session.outputNames[0];
  const outputTensor = results[outputName];
  const outputData = outputTensor.data as Float32Array;
  const outputDims = outputTensor.dims as number[];

  // Output shape: [1, 1, outH, outW] — probability map at 1/4 scale
  const outH = outputDims[2];
  const outW = outputDims[3];

  // Compute effective scale from output-coords to original image
  const effScaleX = scaleX * (paddedW / 4) / outW;
  const effScaleY = scaleY * (paddedH / 4) / outH;

  // Apply DB post-processing
  return dbPostProcess(outputData, outH, outW, effScaleX, effScaleY);
}

async function recognizeText(imagePath: string, box: TextBox): Promise<string> {
  const session = await ensureRecSession();
  if (!session) {
    throw new Error('Recognition model not loaded. Run setup_ocr first.');
  }

  const [x1, y1, x2, y2] = box.bbox;
  const tensor = await preprocessForRecognition(imagePath, x1, y1, x2, y2);

  // Run inference
  const inputName = session.inputNames[0];
  const feeds: Record<string, any> = {};
  const ort_ = await ensureOrt();
  feeds[inputName] = new ort_.Tensor('float32', tensor, [1, 3, 48, 320]);
  const results = await session.run(feeds);

  // Decode recognition output to text
  const outputName = session.outputNames[0];
  const outputTensor = results[outputName];
  const outputData = outputTensor.data as Float32Array;
  const outputDims = outputTensor.dims as number[];

  return decodeRecOutput(outputData, outputDims);
}

// ── CTC Decoding ────────────────────────────────────────────────────────────

function decodeRecOutput(data: Float32Array, dims: number[]): string {
  // dims: [1, sequence_length, num_classes]
  if (dims.length < 3) return '';
  const seqLen = dims[1];
  const numClasses = dims[2];

  const chars = loadCharset();
  const blankIdx = numClasses - 1; // CTC blank is the last class

  let result = '';
  let prevCharIdx = -1;

  for (let t = 0; t < seqLen; t++) {
    // Argmax over classes at this timestep
    let maxIdx = 0;
    let maxVal = -Infinity;
    const offset = t * numClasses;
    for (let c = 0; c < numClasses; c++) {
      const val = data[offset + c];
      if (val > maxVal) {
        maxVal = val;
        maxIdx = c;
      }
    }

    // CTC collapse: skip blanks and consecutive duplicates
    if (maxIdx !== blankIdx && maxIdx !== prevCharIdx) {
      if (maxIdx < chars.length) {
        result += chars[maxIdx];
      }
    }
    prevCharIdx = maxIdx;
  }

  return result;
}

// ── MCP Server ──────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: { code: number; message: string };
}

class McpServer {
  private requestId = 0;
  private initialized = false;
  private rl: ReturnType<typeof createInterface>;

  constructor() {
    this.rl = createInterface({ input: process.stdin });
    this.rl.on('line', (line) => this.handleMessage(line.trim()));

    process.on('uncaughtException', (err) => {
      this.sendLog('error', `Uncaught exception: ${err.message}`);
    });
  }

  private send(response: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  private sendLog(level: string, message: string): void {
    this.send({
      jsonrpc: '2.0',
      id: `log-${++this.requestId}`,
      result: { _log: true, level, message },
    });
  }

  private async handleMessage(line: string): Promise<void> {
    if (!line) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }

    const { id, method, params } = request;

    try {
      switch (method) {
        case 'initialize':
          await this.handleInitialize(id, params);
          break;
        case 'tools/list':
          await this.handleToolsList(id);
          break;
        case 'tools/call':
          await this.handleToolCall(id, params);
          break;
        case 'notifications/initialized':
          this.initialized = true;
          break;
        default:
          this.send({ jsonrpc: '2.0', id, result: {} });
      }
    } catch (err: any) {
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err.message ?? String(err) },
      });
    }
  }

  private async handleInitialize(id: number | string, _params: any): Promise<void> {
    this.send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'PP-OCRv6',
          version: '0.1.0',
        },
      },
    });
  }

  private async handleToolsList(id: number | string): Promise<void> {
    const tools = [
      {
        name: 'ocr_image',
        description: `Extract text from an image using PP-OCRv6. Supports ${LANGUAGE}. Provide the image file path.`,
        inputSchema: {
          type: 'object',
          properties: {
            imagePath: {
              type: 'string',
              description: 'Absolute path to the image file (PNG, JPG, WebP, etc.).',
            },
          },
          required: ['imagePath'],
        },
      },
      {
        name: 'ocr_languages',
        description: 'List supported languages for the current OCR configuration.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'ocr_status',
        description: 'Check whether PP-OCRv6 models are loaded and ready.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];

    this.send({
      jsonrpc: '2.0',
      id,
      result: { tools },
    });
  }

  private async handleToolCall(id: number | string, params: any): Promise<void> {
    const { name, arguments: args } = params ?? {};

    switch (name) {
      case 'ocr_image':
        return this.handleOcrImage(id, args);
      case 'ocr_languages':
        return this.handleOcrLanguages(id);
      case 'ocr_status':
        return this.handleOcrStatus(id);
      default:
        this.send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        });
    }
  }

  private async handleOcrImage(id: number | string, args: any): Promise<void> {
    const imagePath = args?.imagePath;
    if (!imagePath || typeof imagePath !== 'string') {
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Missing required parameter: imagePath' },
      });
      return;
    }

    try {
      // Step 1: Detect text regions
      const boxes = await detectText(imagePath);

      if (boxes.length === 0) {
        this.send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: 'No text detected in the image.' }],
          },
        });
        return;
      }

      // Step 2: Recognize each text region
      const lines: string[] = [];
      for (const box of boxes) {
        const text = await recognizeText(imagePath, box);
        if (text.trim()) {
          lines.push(text.trim());
        }
      }

      const result = lines.join('\n');

      this.send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text: result || 'No text recognized.' },
          ],
        },
      });
    } catch (err: any) {
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `OCR failed: ${err.message}` },
      });
    }
  }

  private async handleOcrLanguages(id: number | string): Promise<void> {
    const languages = LANGUAGE.split('+');
    this.send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{
          type: 'text',
          text: `Current OCR configuration:
- Model tier: ${TIER}
- Languages: ${LANGUAGE}
- Detection model: ${DET_MODEL_PATH ? 'loaded' : 'not configured'}
- Recognition model: ${REC_MODEL_PATH ? 'loaded' : 'not configured'}`,
        }],
      },
    });
  }

  private async handleOcrStatus(id: number | string): Promise<void> {
    const detLoaded = !!detSession;
    const recLoaded = !!recSession;
    const charsLoaded = loadCharset().length;

    this.send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{
          type: 'text',
          text: `PP-OCRv6 Status:
- Model tier: ${TIER}
- Languages: ${LANGUAGE}
- Detection model loaded: ${detLoaded}
- Recognition model loaded: ${recLoaded}
- Character set size: ${charsLoaded}
- Det model path: ${DET_MODEL_PATH || 'N/A'}
- Rec model path: ${REC_MODEL_PATH || 'N/A'}
- Chars path: ${CHARS_PATH || 'N/A'}`,
        }],
      },
    });
  }
}

// ── Start server ────────────────────────────────────────────────────────────

const server = new McpServer();
process.stdin.resume();

// Log startup
const msg = JSON.stringify({
  jsonrpc: '2.0',
  id: 'startup',
  result: {
    _log: true,
    level: 'info',
    message: `PP-OCRv6 MCP server started (tier=${TIER}, lang=${LANGUAGE}, chars=${loadCharset().length})`,
  },
});
process.stdout.write(msg + '\n');
