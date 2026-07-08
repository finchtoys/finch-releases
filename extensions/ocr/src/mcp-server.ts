/**
 * PP-OCRv6 MCP Server
 *
 * stdio-based MCP server that exposes OCR tools via the Model Context Protocol.
 * Launched as a child process by the MCP Client extension.
 *
 * Environment variables (set by the extension host via servers.json env):
 *   OCR_DET_MODEL_PATH  — path to detection ONNX model
 *   OCR_REC_MODEL_PATH  — path to recognition ONNX model
 *   OCR_LANGUAGE        — language code (e.g. "ch+en")
 *   OCR_TIER            — model tier (tiny/small/medium)
 */

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Config from env ─────────────────────────────────────────────────────────

const DET_MODEL_PATH = process.env.OCR_DET_MODEL_PATH ?? '';
const REC_MODEL_PATH = process.env.OCR_REC_MODEL_PATH ?? '';
const LANGUAGE = process.env.OCR_LANGUAGE ?? 'ch+en';
const TIER = process.env.OCR_TIER ?? 'medium';

// ── Models will be loaded lazily ─────────────────────────────────────────────

let ort: any = null;
let detSession: any = null;
let recSession: any = null;
let sharpModule: any = null;

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
  // ESM module may have default export
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

// ── Image preprocessing ─────────────────────────────────────────────────────

interface PreprocessedImage {
  /** Preprocessed image tensor (CHW float32) for detection model */
  tensor: Float32Array;
  /** Original image width */
  width: number;
  /** Original image height */
  height: number;
  /** Scale factor applied (for mapping boxes back to original) */
  scale: number;
}

async function preprocessForDetection(imagePath: string): Promise<PreprocessedImage> {
  const sharpInstance = await ensureSharp();
  const img = sharpInstance(imagePath);
  const metadata = await img.metadata();
  const origW = metadata.width ?? 0;
  const origH = metadata.height ?? 0;

  // Resize to 640x640 (PP-OCRv6 standard input size)
  const targetSize = 640;
  const resized = await img
    .resize(targetSize, targetSize, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();

  // Convert to float32 tensor (1, 1, 640, 640)
  // Normalize to [0, 1]
  const tensor = new Float32Array(targetSize * targetSize);
  for (let i = 0; i < targetSize * targetSize; i++) {
    tensor[i] = resized[i] / 255.0;
  }

  const scale = Math.max(origW, origH) / targetSize;

  return { tensor, width: origW, height: origH, scale };
}

interface TextBox {
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] in original image coords
}

async function detectText(imagePath: string): Promise<TextBox[]> {
  const session = await ensureDetSession();
  if (!session) {
    throw new Error('Detection model not loaded. Run setup_ocr first.');
  }

  const preprocessed = await preprocessForDetection(imagePath);
  const { tensor, width, height, scale } = preprocessed;

  // Run inference
  const inputName = session.inputNames[0];
  const feeds: Record<string, any> = {};
  // Create a 4D tensor: [1, 1, 640, 640]
  feeds[inputName] = new ort.Tensor('float32', tensor, [1, 1, 640, 640]);
  const results = await session.run(feeds);

  // Parse detection results
  // Output is typically [1, N, 4] or similar shape for bounding boxes
  const outputName = session.outputNames[0];
  const outputTensor = results[outputName];
  const outputData = outputTensor.data as Float32Array;
  const outputDims = outputTensor.dims;

  const boxes: TextBox[] = [];

  if (outputDims.length === 3 && outputDims[2] === 4) {
    // [batch, num_boxes, 4]
    const numBoxes = outputDims[1];
    for (let i = 0; i < numBoxes; i++) {
      const x1 = outputData[i * 4] * scale;
      const y1 = outputData[i * 4 + 1] * scale;
      const x2 = outputData[i * 4 + 2] * scale;
      const y2 = outputData[i * 4 + 3] * scale;
      boxes.push({ bbox: [x1, y1, x2, y2] });
    }
  }

  return boxes;
}

async function recognizeText(imagePath: string, box: TextBox): Promise<string> {
  const session = await ensureRecSession();
  if (!session) {
    throw new Error('Recognition model not loaded. Run setup_ocr first.');
  }

  const sharpInstance = await ensureSharp();
  const [x1, y1, x2, y2] = box.bbox;

  // Crop the text region from the original image
  const cropWidth = Math.max(1, Math.round(x2 - x1));
  const cropHeight = Math.max(1, Math.round(y2 - y1));

  const cropped = await sharpInstance(imagePath)
    .extract({
      left: Math.round(x1),
      top: Math.round(y1),
      width: cropWidth,
      height: cropHeight,
    })
    .grayscale()
    .resize(320, 48, { fit: 'fill' })  // PP-OCRv6 rec input size
    .raw()
    .toBuffer();

  // Create input tensor (1, 1, 48, 320)
  const tensor = new Float32Array(48 * 320);
  for (let i = 0; i < 48 * 320; i++) {
    tensor[i] = cropped[i] / 255.0;
  }

  const inputName = session.inputNames[0];
  const feeds: Record<string, any> = {};
  feeds[inputName] = new ort.Tensor('float32', tensor, [1, 1, 48, 320]);
  const results = await session.run(feeds);

  // Decode recognition output to text
  const outputName = session.outputNames[0];
  const outputTensor = results[outputName];
  const outputData = outputTensor.data as Float32Array;

  // Simple argmax decoding with character mapping
  const text = decodeRecOutput(outputData, outputTensor.dims);
  return text;
}

// ── Character set (simplified — PP-OCRv6 has a large built-in charset) ──────

const CHARSET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ \n\t' +
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞';

function decodeRecOutput(data: Float32Array, dims: readonly number[]): string {
  // dims: [1, sequence_length, num_classes]
  // For each timestep, argmax over classes
  if (dims.length < 3) return '';

  const seqLen = dims[1];
  const numClasses = dims[2];
  const charLen = CHARSET.length;
  const blankIdx = numClasses - 1;  // CTC blank is usually the last class

  let result = '';
  let prevCharIdx = -1;

  for (let t = 0; t < seqLen; t++) {
    let maxIdx = 0;
    let maxVal = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const val = data[t * numClasses + c];
      if (val > maxVal) {
        maxVal = val;
        maxIdx = c;
      }
    }

    if (maxIdx !== blankIdx && maxIdx !== prevCharIdx) {
      if (maxIdx < charLen) {
        result += CHARSET[maxIdx];
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
- Det model path: ${DET_MODEL_PATH || 'N/A'}
- Rec model path: ${REC_MODEL_PATH || 'N/A'}`,
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
  result: { _log: true, level: 'info', message: `PP-OCRv6 MCP server started (tier=${TIER}, lang=${LANGUAGE})` },
});
process.stdout.write(msg + '\n');
