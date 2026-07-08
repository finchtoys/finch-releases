# PP-OCRv6 Extension

Extract text from images locally using PP-OCRv6 (PaddleOCR) ONNX models. No cloud API calls, no data leaves your machine.

## Features

- **50 languages** supported by a single model (Chinese, English, Japanese, 46 Latin languages)
- **3 model tiers**: Tiny (~6 MB), Small (~30 MB), Medium (~132 MB)
- **Fully local**: ONNX Runtime inference, no Python or cloud dependencies
- **MCP integration**: Tools exposed through Finch's MCP Client bridge
- **Auto-fallback mirror**: `hf-mirror.com` fallback for users in mainland China

## Prerequisites

- **Finch** with **MCP Client** extension enabled (OCR depends on it to launch the server process)
- **Node.js >= 18** (for `onnxruntime-node` and `sharp`)
- ~150 MB disk space for medium models (tiny/small need less)

## Installation

```bash
# Build the extension
cd /path/to/extensions/ocr
npm run build

# Install to Finch personal tier
npx @finch.app/extensions add .
```

Or install via Finch → Toolcase → Extensions → Install Extension.

## Setup

1. Open Finch and make sure **MCP Client** extension is enabled
2. Enable **PP-OCRv6** in Finch → Toolcase → Extensions (grant `filesystem: readwrite` and `network` permissions)
3. Say **"帮我设置 OCR"** or call `setup_ocr`
4. Choose model tier and language in the form
5. Wait for models to download from HuggingFace (~132 MB for medium tier, downloads cached to `extension-data/ocr/models/`)
6. Start using `ocr_image` to extract text from images

> **China mainland users:** The download auto-falls back to `hf-mirror.com` if `huggingface.co` is unreachable or times out (>15s).

## Tools

### Extension Tools (available immediately after enable)

| Tool | Description |
|---|---|
| `setup_ocr` | Configure OCR: select model tier and language, download ONNX models, register MCP server |
| `ocr_status` | Check cached models, char dictionary status, and MCP server readiness |

### MCP Tools (available after `setup_ocr` completes)

| Tool | Description |
|---|---|
| `ocr_image` | Extract text from an image — detects text regions and recognizes characters |
| `ocr_languages` | List current OCR language and model configuration |
| `ocr_status` | Check if models are loaded in memory and ready |

## Supported Image Formats

| Format | Support | Notes |
|---|---|---|
| PNG / JPG / WebP / TIFF / AVIF | ✅ | `sharp` native formats |
| PDF | ❌ | Need to convert to images first |
| Scanned PDF | ❌ | Same as above |

## Performance

| Tier | Parameters | Model Size | Speed | Accuracy (W-Avg) |
|---|---|---|---|---|
| Tiny | 1.5M | ~6 MB | Fastest | 73.5 |
| Small | 7.7M | ~30 MB | Balanced | 81.3 |
| Medium | 34.5M | ~132 MB | Slower | 83.2 |

## Architecture

```
User image → Finch Agent → ocr_image (MCP) → MCP Server
  → sharp (preprocess) → ONNX Runtime (PP-OCRv6) → text result
```

```
extensions/ocr/
├── package.json          # Manifest + dependencies
├── tsconfig.json
├── src/
│   ├── index.ts          # Extension entry (setup_ocr, ocr_status tools)
│   └── mcp-server.ts     # MCP stdio server (ocr_image, ocr_languages, ocr_status)
├── i18n/
│   ├── zh-CN.json        # Chinese UI strings
│   └── en-US.json        # English UI strings
├── skills/
│   └── ocr/SKILL.md      # Built-in skill for agent guidance
└── README.md
```

### Data Flow

1. `setup_ocr` downloads ONNX models + character dictionary from HuggingFace (or mirror)
2. Writes config to `mcp-config.json` alongside models
3. Registers the MCP server in `mcp/servers.json` — MCP Client spawns `mcp-server.js` as child process
4. `ocr_image` receives an image path, preprocesses with `sharp`, runs ONNX inference
5. DB post-processing detects text regions, CTC decoding recognizes characters
6. Returns structured text with bounding boxes

### Download Fallback

```
primary (huggingface.co) ── 15s timeout → 失败/超时
    ↓
mirror (hf-mirror.com) ── 正常下载 → 完成
    ↓（都失败）
报错
```

## Troubleshooting

| Problem | Likely Cause | Fix |
|---|---|---|
| Model download hangs | huggingface.co unreachable in China | Auto-fallback to hf-mirror.com after 15s — retry setup |
| `setup_ocr` form doesn't appear | Extension not enabled | Check Toolcase → Extensions → PP-OCRv6 is enabled |
| OCR tools not showing up | MCP Client not enabled | Enable MCP Client extension |
| "400 Error from provider" | Model API call failure (not OCR) | Re-enable MCP Client or restart Finch |
| `ocr_image` returns nothing | Models not loaded | Run `ocr_status` to check readiness, then `setup_ocr` |

## Development

```bash
npm run build          # Compile TypeScript
npm run dev            # Watch mode (tsc --watch)
npx @finch.app/extensions doctor .   # Lint manifest before install
npx @finch.app/extensions update ocr  # Reinstall after code changes
```

## Privacy

All OCR inference runs **locally** on your machine. No images or extracted text are sent to any cloud service. The only network requests are model downloads from HuggingFace (configurable).

## License

MIT
