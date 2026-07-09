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
| `ocr_image` | 异步启动图片 OCR（PNG、JPG、WebP、BMP 等），返回任务 ID |
| `ocr_pdf` | 异步启动扫描版 PDF OCR，返回任务 ID |
| `check_ocr_task` | 通过任务 ID 查询进度并获取结果 |
| `ocr_cache` | 查看缓存的 OCR 结果（时间、过期） |
| `clear_ocr_cache` | 清空所有缓存 |
| `setup_ocr` | 检查环境并安装依赖 |
| `ocr_status` | 快速健康检查 |

> **异步流程：** `ocr_image` / `ocr_pdf` 会在后台启动识别进程，立即返回任务 ID + 预计时间。Finch 会在预计时间后自动调用 `check_ocr_task` 获取结果。

## 环境要求

- **Python 3.10 – 3.12**
- 依赖（`paddleocr`、`paddlepaddle`、`PyMuPDF`、`opencv-python`、`numpy`）首次使用时自动安装

## 结果缓存

OCR 结果缓存 **30 天**，基于 SHA-256 文件哈希作为键。同一个文件再次识别直接返回缓存结果，无需重新运行 OCR。

```
extensions/ocr/
├── cache/
│   ├── index.json         # hash → ISO 时间戳
│   └── <sha256>.json      # 结果文件
```

- 缓存文件存放在扩展目录下的 `cache/` 文件夹中
- `index.json` 记录每个文件的创建时间，用于快速过期判断
- 每次写入新缓存时自动清理过期条目
- 使用 `ocr_cache` 查看缓存，`clear_ocr_cache` 清空全部

## 性能与上限

| 类型 | 建议上限 | 说明 |
|------|---------|------|
| 单张图片 | 原始尺寸无限制 | 最长边 >3000px 自动缩放 |
| PDF 页数 | 数百页 | 150 DPI 渲染，两级空白检测（先 72 DPI 预览再 150 DPI），>98% 空白页自动跳过 |
| 单页 PDF 尺寸 | A0 以下 | 超大图纸建议拆分为单页处理 |

- **GPU 加速** — 自动检测 `nvidia-smi`，有显卡则安装 `paddlepaddle-gpu`（3–10 倍提速）
- **模型预热** — 首次冷启动（~10s）在开始识别前处理完，后续页瞬时响应
- **多页 PDF**（>8 页）自动启用 4 线程并行处理
- **动态时间估算** — `check_ocr_task` 中显示基于已处理页数的剩余时间
- PDF 输出带页号标题和置信度
- 缓存存储在扩展私有数据目录中

## 隐私说明

所有推理在本地运行。网络访问仅用于首次模型下载（约 150 MB）。

## 许可证

MIT