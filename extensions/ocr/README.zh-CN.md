# PP-OCRv6

基于 Python PaddleOCR 的高精度文字识别扩展，支持图片和扫描版 PDF。

## 使用方式

1. 在 Finch 中启用 **PP-OCRv6** 扩展。
2. 发送图片或 PDF，说：
   - `识别这张图里的文字`
   - `提取这个 PDF 的文字`

首次使用自动安装依赖（Python venv + pip install），无需手动操作。

## 工具

| 工具 | 说明 |
|------|------|
| `ocr_image` | 从图片（PNG、JPG、WebP、BMP 等）提取文字 |
| `ocr_pdf` | 逐页 OCR 扫描版 PDF |
| `setup_ocr` | 检查环境并安装依赖 |
| `ocr_status` | 快速健康检查 |

## 环境要求

- **Python 3.10 – 3.12**
- 依赖（`paddleocr`、`paddlepaddle`、`PyMuPDF`）首次使用时自动安装

## 隐私说明

所有推理在本地运行。网络访问仅用于首次模型下载（约 150 MB）。

## 许可证

MIT