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
| `ocr_image` | Extract text from an image (PNG, JPG, WebP, BMP, etc.) |
| `ocr_pdf` | OCR a scanned PDF page by page |
| `setup_ocr` | Check environment and install dependencies |
| `ocr_status` | Quick health check |

## Requirements

- **Python 3.10 – 3.12**
- Dependencies (`paddleocr`, `paddlepaddle`, `PyMuPDF`) auto-installed on first use

## Privacy

All inference runs locally. Network access is only for initial model downloads (~150 MB).

## License

MIT