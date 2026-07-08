# PP-OCRv6

PP-OCRv6 connects PP-OCRv6 ONNX models through Finch's MCP Client so the Agent can extract text from images locally. No cloud API calls, no data leaves your machine.

## Download mirror

This extension downloads models from HuggingFace on first use (~132 MB for medium tier, cached to `extension-data/ocr/models/`). For users in mainland China, the download auto-falls back to `hf-mirror.com` if `huggingface.co` is unreachable (>15s timeout):

```
primary (huggingface.co) ── 15s timeout → fallback (hf-mirror.com)
```

## Model tiers

| Tier | Parameters | Size | Speed | Accuracy (W-Avg) |
|---|---|---|---|---|
| Tiny | 1.5M | ~6 MB | Fastest | 73.5 |
| Small | 7.7M | ~30 MB | Balanced | 81.3 |
| Medium (default) | 34.5M | ~132 MB | Slower | 83.2 |

## Usage

1. Enable the **MCP Client** extension.
2. Enable the **PP-OCRv6** extension.
3. (Optional) Set your preferred tier and language in the extension's Settings panel.
4. Ask Finch: `帮我设置 OCR`. The `setup_ocr` tool will download models and configure the MCP server.
5. Send an image and ask: `识别这张图里的文字`. The `ocr_image` tool extracts text with bounding boxes.

## Tools

- `setup_ocr`: select model tier and language, download ONNX models from HuggingFace, register the local MCP server.
- `ocr_status`: check cached models and MCP server readiness.
- `ocr_image` (MCP): detect text regions and recognize characters from an image.
- `ocr_languages` (MCP): list current language and model configuration.

## Settings

| Field | Type | Default | Description |
|---|---|---|---|
| `tier` | select | `medium` | Model size: tiny / small / medium |
| `language` | select | `ch+en` | Recognition language: ch+en / en / ch / ch+en+ja |

Configure these in Finch → Toolcase → Extensions → PP-OCRv6 → Settings. When models are already cached for the selected tier, the MCP server is auto-configured on extension load — no chat needed.

## Permissions

- `filesystem: readwrite`: writes model files to `extension-data/ocr/models/` and MCP config to `mcp/servers.json`.
- `network: true`: downloads ONNX models from HuggingFace (or mirror) on first use.
- `shell: false`: this extension does not execute shell commands. MCP Client starts the OCR server as a Node.js child process.

## Image formats

PNG, JPG, WebP, TIFF, AVIF are supported via `sharp`. PDF is not supported directly — convert to images first.

## Privacy

All OCR inference runs locally. No images or extracted text are sent to any cloud service. Network access is only used for model downloads (configurable via download mirror).
