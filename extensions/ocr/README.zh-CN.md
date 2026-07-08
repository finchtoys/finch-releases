# PP-OCRv6

PP-OCRv6 使用 PP-OCRv6 medium ONNX 模型提供完全离线的文字识别能力。推理直接在扩展进程中通过 onnxruntime-node 运行，无需 MCP 服务，无需子进程。

## 架构

```
setup_ocr ──→ 从 HuggingFace 下载模型 → 缓存到 extension-data/ocr/models/
                                ↓
                         onnxruntime-node InferenceSession
                                ↓
 ocr_image ──→ sharp 解码 → 检测模型（文字区域检测）
                                ↓
                         识别模型（字符识别）
                                ↓
                         CTC 解码 → 识别文字
```

无 MCP 服务、无子进程，所有推理在进程内完成。

## 下载镜像

扩展首次使用时会从 HuggingFace 下载模型（约 132 MB，缓存到 `extension-data/ocr/models/`）。中国大陆用户无需手动配置——如果 `huggingface.co` 不可达（>15s 超时），自动回退到 `hf-mirror.com`：

```
primary (huggingface.co) ── 15s 超时 → fallback (hf-mirror.com)
```

## 使用方式

1. 启用 **PP-OCRv6** 扩展。
2. （可选）在扩展 Settings 面板中预设识别语言。
3. 对 Finch 说：`帮我设置 OCR`。扩展会调用 `setup_ocr` 下载模型并加载到内存。
4. 发送一张带文字的图片，然后说：`识别这张图里的文字`。`ocr_image` 工具返回带坐标框的文字结果。

## 工具

- `setup_ocr`：选择识别语言，从 HuggingFace 下载 ONNX 模型，加载到内存。
- `ocr_status`：检查已缓存的模型和内存中模型加载状态。
- `ocr_image`：检测文字区域并识别图中的文字（弹出文件选择表单）。

## 设置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `language` | select | `ch+en` | 识别语言：ch+en / en / ch / ch+en+ja |

在 Finch → Toolcase → Extensions → PP-OCRv6 → Settings 中配置。

## 权限

- `filesystem: readwrite`：将模型写入 `extension-data/ocr/models/`，配置写入 `extension-data/ocr/models/ocr-config.json`。
- `network: true`：首次使用时从 HuggingFace（或镜像）下载 ONNX 模型。
- `shell: true`：首次设置时运行 `npm install` 安装原生依赖（onnxruntime-node、sharp）。

## 图片格式

支持 PNG、JPG、WebP、TIFF、AVIF（依赖 `sharp`）。暂不支持 PDF，请先转换为图片再使用。

## 隐私说明

所有 OCR 推理均在本地运行。图片和提取的文字不会发送到任何云端服务。网络访问仅用于模型下载。

## 依赖

- `onnxruntime-node` — ONNX Runtime for Node.js（原生二进制）
- `sharp` — 高性能图片处理（原生二进制）
