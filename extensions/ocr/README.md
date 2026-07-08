# PP-OCRv6 Extension

Extract text from images locally using PP-OCRv6 (PaddleOCR) ONNX models. No cloud API calls, no data leaves your machine.

## Features

- **50 languages** supported by a single model (Chinese, English, Japanese, 46 Latin languages)
- **3 model tiers**: Tiny (~6 MB), Small (~30 MB), Medium (~132 MB)
- **Fully local**: ONNX Runtime inference, no Python or cloud dependencies
- **MCP integration**: Tools exposed through Finch's MCP Client bridge

## How it works

This extension follows the MCP contribution pattern. It writes a server config to MCP Client's `servers.json`, which launches a local Node.js process running `onnxruntime-node` with PP-OCRv6 ONNX models.

```
User image → Finch Agent → ocr_image tool → MCP Server
  → sharp (preprocess) → ONNX Runtime (PP-OCRv6) → text result
```

## Tools

| Tool | Description |
|---|---|
| `setup_ocr` | Select model tier, language, download models, start MCP server |
| `ocr_status` | Check cached models and MCP server readiness |
| `ocr_image` | Extract text from an image (MCP tool, available after setup) |
| `ocr_languages` | List current OCR language configuration (MCP tool) |

## Setup

1. Install the extension in Finch (Toolcase → Extensions)
2. Enable the extension and grant `filesystem: read` and `network` permissions
3. Call `setup_ocr` and choose your preferred model tier and language
4. Wait for models to download (~132 MB for medium tier)
5. Start using `ocr_image` to extract text from images

## Performance

| Tier | Parameters | Model Size | Speed | Accuracy (W-Avg) |
|---|---|---|---|---|
| Tiny | 1.5M | ~6 MB | Fastest | 73.5 |
| Small | 7.7M | ~30 MB | Balanced | 81.3 |
| Medium | 34.5M | ~132 MB | Slower | 83.2 |

## Architecture

```
extensions/ocr/
├── package.json          # Manifest + dependencies
├── src/
│   ├── index.ts          # Extension entry (setup_ocr, ocr_status tools)
│   └── mcp-server.ts     # MCP stdio server (ocr_image, ocr_languages)
├── i18n/
│   ├── zh-CN.json
│   └── en-US.json
├── skills/
│   └── ocr/SKILL.md      # Built-in skill
└── README.md
```

## License

MIT
