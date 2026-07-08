# PP-OCRv6

PP-OCRv6 uses PP-OCRv6 medium ONNX models for fully local OCR — no cloud API calls, no data leaves your machine. Inference runs directly in the extension process via onnxruntime-node.

## Architecture

```
setup_ocr ──→ download models from HuggingFace → cache to extension-data/ocr/models/
                                ↓
                         onnxruntime-node InferenceSession
                                ↓
 ocr_image ──→ sharp decode → det model (text region detection)
                                ↓
                         rec model (character recognition)
                                ↓
                         CTC decode → recognized text
```

No MCP server. No child process. All inference is in-process.

## Download mirror

This extension downloads models from HuggingFace on first use (~132 MB for medium, cached to `extension-data/ocr/models/`). For users in mainland China, the download auto-falls back to `hf-mirror.com` if `huggingface.co` is unreachable (>15s timeout):

```
primary (huggingface.co) ── 15s timeout → fallback (hf-mirror.com)
```

## Usage

1. Enable the **PP-OCRv6** extension.
2. (Optional) Set your preferred language in the extension's Settings panel.
3. Ask Finch: `帮我设置 OCR`. The `setup_ocr` tool will download models and load them into memory.
4. Send an image and ask: `识别这张图里的文字`. The `ocr_image` tool extracts text with bounding boxes.

## Tools

- `setup_ocr`: select recognition language, download ONNX models from HuggingFace, load models into memory.
- `ocr_status`: check cached models and in-memory model loading status.
- `ocr_image`: detect text regions and recognize characters from an image (shows a file-picker form).

## Settings

| Field | Type | Default | Description |
|---|---|---|---|
| `language` | select | `ch+en` | Recognition language: ch+en / en / ch / ch+en+ja |

Configure in Finch → Toolcase → Extensions → PP-OCRv6 → Settings.

## Permissions

- `filesystem: readwrite`: writes model files to `extension-data/ocr/models/` and config to `extension-data/ocr/models/ocr-config.json`.
- `network: true`: downloads ONNX models from HuggingFace (or mirror) on first use.
- `shell: true`: runs `npm install` to install native dependencies (onnxruntime-node, sharp) on first setup.

## Image formats

PNG, JPG, WebP, TIFF, AVIF are supported via `sharp`. PDF is not supported directly — convert to images first.

## Privacy

All OCR inference runs locally. No images or extracted text are sent to any cloud service. Network access is only used for model downloads.

## Dependencies

- `onnxruntime-node` — ONNX Runtime for Node.js (native binary)
- `sharp` — high-performance image processing (native binary)
