# PP-OCRv6

PP-OCRv6 uses Python PaddleOCR for high-accuracy OCR — optimized for Chinese and English text, with adaptive preprocessing and retry logic.

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
                    └── Return best result with confidence score
```

Uses Python PaddleOCR for inference. JS handles the extension interface and calls Python via subprocess.

## Runtime Requirements

### Required

| Requirement | Version | Description |
|-------------|---------|-------------|
| **Python** | 3.10 - 3.12 | Python interpreter for PaddleOCR |
| **paddleocr** | 3.7+ | PaddleOCR Python package |
| **paddlepaddle** | 3.0+ | PaddlePaddle deep learning framework |

### Optional (for enhanced preprocessing)

| Package | Description |
|---------|-------------|
| **opencv-python** | Image preprocessing (auto-installed with paddleocr) |
| **numpy** | Array operations (auto-installed with paddleocr) |

## Installation

### Option 1: Virtual Environment (Recommended)

```bash
# Create virtual environment
python3 -m venv /tmp/ocr-venv

# Activate
source /tmp/ocr-venv/bin/activate  # macOS/Linux
# or
/tmp/ocr-venv/Scripts/activate     # Windows

# Install dependencies
pip install paddleocr paddlepaddle
```

### Option 2: System-wide Installation

```bash
pip install paddleocr paddlepaddle
```

### Option 3: Using pipx (Isolated)

```bash
pipx install paddleocr
```

## Downloaded Dependencies

When PaddleOCR runs for the first time, it automatically downloads model files:

| Model | Size | Description |
|-------|------|-------------|
| **PP-OCRv6_medium_det** | ~59 MB | Text detection model |
| **PP-OCRv6_medium_rec** | ~73 MB | Text recognition model |
| **Character dict** | ~150 KB | Character dictionary for Chinese and English text |

**Total download size:** ~132 MB

**Download location:** `~/.paddlex/official_models/` (auto-managed by PaddleOCR)

**Network access:** Models are downloaded from HuggingFace on first use. For users in mainland China, PaddleOCR auto-falls back to mirror servers if HuggingFace is unreachable.

## Usage

1. Enable the **PP-OCRv6** extension in Finch.
2. (Optional) Run `setup_ocr` to verify Python environment.
3. Send an image and ask: `识别这张图里的文字` or `Extract text from this image`.

## Tools

### `setup_ocr`
Check Python environment and PaddleOCR installation status.

### `ocr_status`
Check Python and PaddleOCR availability, versions, and configuration.

### `ocr_image`
Extract text from an image using PP-OCRv6 with adaptive preprocessing.

**Parameters:**
- `imagePath` (string, required): Absolute path to the image file

**Returns:**
- Extracted text with confidence score

## High-Accuracy Parameters

The Python script uses optimized parameters for better accuracy:

| Parameter | Default | Our Value | Description |
|-----------|---------|-----------|-------------|
| `text_det_limit_side_len` | 960 | 1536 | Higher resolution for better detection |
| `text_det_thresh` | 0.3 | 0.2 | Lower threshold for more sensitive detection |
| `text_det_box_thresh` | 0.6 | 0.4 | Lower threshold for box filtering |

## Adaptive Preprocessing

When OCR confidence is low (< 85%) or few text lines are detected, the extension automatically:

1. **Upscales small images** (2x for images < 1500px)
2. **Normalizes contrast** (histogram equalization)
3. **Applies light sharpening** (edge enhancement)
4. **Runs OCR again** and uses the better result

This ensures good results for:
- Small text in screenshots
- Low contrast images
- Scanned documents

## Permissions

- `filesystem: read`: Reads image files for OCR
- `shell: true`: Calls Python PaddleOCR via subprocess
- `network: true`: Downloads models on first use (optional)

## Supported Image Formats

PNG, JPG, JPEG, WebP, TIFF, BMP, GIF (first frame)

**Note:** PDF is not supported directly. Convert to images first using tools like `pdftoppm` or `ImageMagick`.

## Privacy

All OCR inference runs locally via Python PaddleOCR. No images or extracted text are sent to any cloud service. Network access is only used for initial model downloads.

## Troubleshooting

### "No Python interpreter found"

1. Check Python is installed:
   ```bash
   python3 --version
   ```

2. Check PaddleOCR is installed:
   ```bash
   python3 -c "import paddleocr; print(paddleocr.__version__)"
   ```

3. If using virtual environment, ensure it's activated or use full path:
   ```bash
   /tmp/ocr-venv/bin/python3
   ```

### "OCR failed: timeout"

Large images may take longer to process. Try:
- Cropping the image to the relevant area
- Reducing image resolution if too large (> 4000px)

### Low accuracy results

1. Ensure image has sufficient contrast
2. For small text, try zooming in before taking screenshot
3. For handwritten text, results may vary

## Performance

| Image Size | Processing Time |
|------------|-----------------|
| 1920x1080 | ~2-4 seconds |
| 3840x2160 | ~5-8 seconds |
| 7000x9000 | ~15-25 seconds |

Times include model loading (first run may be slower).

## License

MIT
