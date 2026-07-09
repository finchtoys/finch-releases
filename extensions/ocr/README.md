# PP-OCRv6

High-accuracy OCR for images and scanned PDFs, powered by Python PaddleOCR.

## Usage

1. Enable **PP-OCRv6** in Finch.
2. Share an image or PDF and ask:
   - `Extract text from this image`
   - `Extract text from this PDF`

Setup happens automatically on first use (Python venv + pip install).

## Tools

| Tool | Description |
|------|-------------|
| `ocr_image` | Start async OCR on an image (PNG, JPG, WebP, BMP, etc.) — returns a task ID |
| `ocr_pdf` | Start async OCR on a scanned PDF — returns a task ID |
| `check_ocr_task` | Poll a running task by task ID and retrieve the result when done |
| `ocr_cache` | View cached OCR results (age, expiry) |
| `clear_ocr_cache` | Clear all cached results |
| `setup_ocr` | Check environment and install dependencies |
| `ocr_status` | Quick health check |

> **Async flow:** `ocr_image` / `ocr_pdf` launch a background process and return immediately with a task ID + estimated time. Finch will automatically call `check_ocr_task` after the estimated time to retrieve the result.

## Requirements

- **Python 3.10 – 3.12**
- Dependencies (`paddleocr`, `paddlepaddle`, `PyMuPDF`, `opencv-python`, `numpy`) auto-installed on first use

## Caching

OCR results are cached for **30 days**, keyed by SHA-256 file hash. Same file = instant result without re-running OCR.

```
extensions/ocr/
├── cache/
│   ├── index.json         # hash → ISO timestamp
│   └── <sha256>.json      # result file
```

- Cache files stored in `cache/` directory alongside the extension
- `index.json` records creation time for quick expiry checks
- Expired entries auto-cleaned on each new cache write
- Use `ocr_cache` to inspect, `clear_ocr_cache` to purge

## Performance & Limits

| Type | Suggested Limit | Notes |
|------|----------------|-------|
| Single image | Unlimited | Automatically scaled if longest edge >3000px |
| PDF pages | Hundreds | 200 DPI rendering, >98% blank pages skipped |
| Single PDF page | Up to A0 | Very large drawings should be split first |

- **Multi-page PDFs** (>8 pages) use 4 parallel worker threads automatically
- PDF output includes page headers and confidence per page
- First model load takes ~10 seconds; subsequent calls are faster

## Privacy

All inference runs locally. Network access is only for initial model downloads (~150 MB).

## License

MIT