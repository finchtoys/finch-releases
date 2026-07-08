# PP-OCRv6

PP-OCRv6 uses Python PaddleOCR for high-accuracy OCR — supports 50+ languages with adaptive preprocessing and retry logic.

## Architecture

```
ocr_image ──→ Python PaddleOCR (high-accuracy params)
                    │
                    ├── First attempt: default preprocessing
                    │
                    ├── If confidence < 0.85 or few lines:
                    │       └── Enhanced preprocessing (upscale 2x, normalize, sharpen)
                    │       └── Second OCR attempt
                    │
                    └── Return best result
```

Uses Python PaddleOCR for inference. JS handles the extension interface and calls Python via subprocess.

## Prerequisites

Python 3.12+ with PaddleOCR installed:

```bash
# Option 1: Virtual environment (recommended)
python3 -m venv /tmp/ocr-venv
source /tmp/ocr-venv/bin/activate
pip install paddleocr paddlepaddle

# Option 2: System-wide
pip install paddleocr paddlepaddle
```

## Usage

1. Enable the **PP-OCRv6** extension.
2. (Optional) Run `setup_ocr` to check Python environment.
3. Send an image and ask: `识别这张图里的文字`. The `ocr_image` tool extracts text.

## Tools

- `setup_ocr`: Check Python environment and PaddleOCR installation.
- `ocr_status`: Check Python and PaddleOCR availability.
- `ocr_image`: Extract text from an image using PP-OCRv6.

## High-Accuracy Parameters

The Python script uses optimized parameters for better accuracy:

| Parameter | Default | Our Value | Description |
|-----------|---------|-----------|-------------|
| `text_det_limit_side_len` | 960 | 1536 | Higher resolution for better detection |
| `text_det_thresh` | 0.3 | 0.2 | Lower threshold for more sensitive detection |
| `text_det_box_thresh` | 0.6 | 0.4 | Lower threshold for box filtering |

## Adaptive Preprocessing

When OCR confidence is low (< 85%) or few text lines are detected, the extension automatically:

1. Upscales small images (2x for images < 1500px)
2. Normalizes contrast
3. Applies light sharpening
4. Runs OCR again and uses the better result

## Permissions

- `filesystem: readwrite`: reads image files for OCR.
- `shell: true`: calls Python PaddleOCR via subprocess.

## Image formats

PNG, JPG, WebP, TIFF, BMP are supported. PDF is not supported directly — convert to images first.

## Privacy

All OCR inference runs locally via Python PaddleOCR. No images or extracted text are sent to any cloud service.

## Dependencies

- Python 3.12+
- `paddleocr` — PaddleOCR Python package
- `paddlepaddle` — PaddlePaddle deep learning framework

## Troubleshooting

If OCR fails with "No Python interpreter found":

1. Check Python is installed: `python3 --version`
2. Check PaddleOCR is installed: `python3 -c "import paddleocr"`
3. If using venv, make sure it's activated or use full path: `/tmp/ocr-venv/bin/python3`
