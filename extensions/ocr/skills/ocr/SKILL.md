# OCR — Image Text Extraction

Uses PP-OCRv6 (PP-OCRv6) to detect and recognize text in images. Fully local, no cloud API calls.

## When to use

- User shares an image, screenshot, or photo containing text
- User asks "what does this image say?" or "extract text from this image"
- User pastes an image in the chat and wants the text content
- User asks to OCR a document page or scanned file

## How to use

### First time setup

If OCR is not configured yet, call `setup_ocr`. This will:
1. Open a form to select model tier (tiny / small / medium) and language
2. Download PP-OCRv6 ONNX models from HuggingFace to local cache
3. Register the OCR MCP server so tools become available

### After setup

Call `ocr_image` with the image path:

```
ocr_image(imagePath: "/path/to/screenshot.png")
```

The tool will:
1. Detect text regions in the image
2. Recognize text in each region
3. Return the concatenated text

### Check status

Call `ocr_status` to see which models are cached and whether the MCP server is running.

## Tips

- Supported image formats: PNG, JPG, WebP, BMP, TIFF
- For best results, use clear, well-lit images
- For scanned documents, higher resolution yields better accuracy
- The medium model (~132 MB) offers the best accuracy but requires more RAM
- Models are cached locally after first download
