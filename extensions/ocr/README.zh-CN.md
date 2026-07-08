# PP-OCRv6

PP-OCRv6 使用 Python PaddleOCR 提供高精度文字识别能力，支持 50+ 种语言，具备自适应预处理和重试逻辑。

## 架构

```
ocr_image ──→ Python PaddleOCR（高精度参数）
                    │
                    ├── 第一次尝试：默认预处理
                    │
                    ├── 如果置信度 < 0.85 或识别行数少：
                    │       └── 增强预处理（放大2x、归一化、锐化）
                    │       └── 第二次 OCR 尝试
                    │
                    └── 返回最佳结果
```

使用 Python PaddleOCR 进行推理，JS 处理扩展接口并通过子进程调用 Python。

## 前置要求

Python 3.12+ 并安装 PaddleOCR：

```bash
# 方式一：虚拟环境（推荐）
python3 -m venv /tmp/ocr-venv
source /tmp/ocr-venv/bin/activate
pip install paddleocr paddlepaddle

# 方式二：系统全局安装
pip install paddleocr paddlepaddle
```

## 使用方式

1. 启用 **PP-OCRv6** 扩展。
2. （可选）运行 `setup_ocr` 检查 Python 环境。
3. 发送一张图片，然后说：`识别这张图里的文字`。

## 工具

- `setup_ocr`：检查 Python 环境和 PaddleOCR 安装状态。
- `ocr_status`：检查 Python 和 PaddleOCR 可用性。
- `ocr_image`：使用 PP-OCRv6 从图片中提取文字。

## 高精度参数

Python 脚本使用优化参数以获得更好的识别效果：

| 参数 | 默认值 | 我们的值 | 说明 |
|------|--------|----------|------|
| `text_det_limit_side_len` | 960 | 1536 | 更高分辨率，检测更准确 |
| `text_det_thresh` | 0.3 | 0.2 | 更低阈值，检测更灵敏 |
| `text_det_box_thresh` | 0.6 | 0.4 | 更低阈值，保留更多文字区域 |

## 自适应预处理

当 OCR 置信度低（< 85%）或识别行数少时，扩展会自动：

1. 放大小图片（< 1500px 的图片放大 2 倍）
2. 归一化对比度
3. 轻微锐化
4. 再次运行 OCR，使用更好的结果

## 权限

- `filesystem: readwrite`：读取图片文件进行 OCR。
- `shell: true`：通过子进程调用 Python PaddleOCR。

## 图片格式

支持 PNG、JPG、WebP、TIFF、BMP。暂不支持 PDF，请先转换为图片。

## 隐私说明

所有 OCR 推理均在本地通过 Python PaddleOCR 运行。图片和提取的文字不会发送到任何云端服务。

## 依赖

- Python 3.12+
- `paddleocr` — PaddleOCR Python 包
- `paddlepaddle` — PaddlePaddle 深度学习框架

## 故障排除

如果 OCR 报错 "No Python interpreter found"：

1. 检查 Python 是否安装：`python3 --version`
2. 检查 PaddleOCR 是否安装：`python3 -c "import paddleocr"`
3. 如果使用虚拟环境，确保已激活或使用完整路径：`/tmp/ocr-venv/bin/python3`
