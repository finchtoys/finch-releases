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
                    └── 返回最佳结果和置信度分数
```

使用 Python PaddleOCR 进行推理，JS 处理扩展接口并通过子进程调用 Python。

## 运行环境要求

### 必需依赖

| 依赖 | 版本 | 说明 |
|------|------|------|
| **Python** | 3.10 - 3.12 | Python 解释器 |
| **paddleocr** | 3.7+ | PaddleOCR Python 包 |
| **paddlepaddle** | 3.0+ | PaddlePaddle 深度学习框架 |

### 可选依赖（增强预处理）

| 包 | 说明 |
|---|------|
| **opencv-python** | 图像预处理（paddleocr 自动安装） |
| **numpy** | 数组运算（paddleocr 自动安装） |

## 安装方式

### 方式一：虚拟环境（推荐）

```bash
# 创建虚拟环境
python3 -m venv /tmp/ocr-venv

# 激活环境
source /tmp/ocr-venv/bin/activate  # macOS/Linux
# 或
/tmp/ocr-venv/Scripts/activate     # Windows

# 安装依赖
pip install paddleocr paddlepaddle
```

### 方式二：系统全局安装

```bash
pip install paddleocr paddlepaddle
```

### 方式三：使用 pipx（隔离环境）

```bash
pipx install paddleocr
```

## 下载的依赖说明

PaddleOCR 首次运行时会自动下载模型文件：

| 模型 | 大小 | 说明 |
|------|------|------|
| **PP-OCRv6_medium_det** | ~59 MB | 文本检测模型 |
| **PP-OCRv6_medium_rec** | ~73 MB | 文本识别模型 |
| **字符字典** | ~150 KB | 50+ 语言字符字典 |

**总下载大小：** ~132 MB

**下载位置：** `~/.paddlex/official_models/`（PaddleOCR 自动管理）

**网络访问：** 首次使用时从 HuggingFace 下载模型。中国大陆用户如果无法访问 HuggingFace，PaddleOCR 会自动回退到镜像服务器。

## 使用方式

1. 在 Finch 中启用 **PP-OCRv6** 扩展。
2. （可选）运行 `setup_ocr` 检查 Python 环境。
3. 发送图片并说：`识别这张图里的文字`。

## 工具

### `setup_ocr`
检查 Python 环境和 PaddleOCR 安装状态。

### `ocr_status`
检查 Python 和 PaddleOCR 可用性、版本和配置。

### `ocr_image`
使用 PP-OCRv6 和自适应预处理从图片中提取文字。

**参数：**
- `imagePath`（字符串，必填）：图片文件的绝对路径

**返回：**
- 提取的文字和置信度分数

## 高精度参数

Python 脚本使用优化参数以获得更好的识别效果：

| 参数 | 默认值 | 我们的值 | 说明 |
|------|--------|----------|------|
| `text_det_limit_side_len` | 960 | 1536 | 更高分辨率，检测更准确 |
| `text_det_thresh` | 0.3 | 0.2 | 更低阈值，检测更灵敏 |
| `text_det_box_thresh` | 0.6 | 0.4 | 更低阈值，保留更多文字区域 |

## 自适应预处理

当 OCR 置信度低（< 85%）或识别行数少时，扩展会自动：

1. **放大小图片**（< 1500px 的图片放大 2 倍）
2. **归一化对比度**（直方图均衡化）
3. **轻微锐化**（边缘增强）
4. **再次运行 OCR**，使用更好的结果

这确保了以下场景的良好效果：
- 截图中的小字
- 低对比度图片
- 扫描文档

## 权限

- `filesystem: readwrite`：读取图片文件进行 OCR
- `shell: true`：通过子进程调用 Python PaddleOCR
- `network: true`：首次使用时下载模型（可选）

## 支持的图片格式

PNG、JPG、JPEG、WebP、TIFF、BMP、GIF（第一帧）

**注意：** 不直接支持 PDF。请先使用 `pdftoppm` 或 `ImageMagick` 等工具转换为图片。

## 隐私说明

所有 OCR 推理均在本地通过 Python PaddleOCR 运行。图片和提取的文字不会发送到任何云端服务。网络访问仅用于首次模型下载。

## 故障排除

### "No Python interpreter found"

1. 检查 Python 是否安装：
   ```bash
   python3 --version
   ```

2. 检查 PaddleOCR 是否安装：
   ```bash
   python3 -c "import paddleocr; print(paddleocr.__version__)"
   ```

3. 如果使用虚拟环境，确保已激活或使用完整路径：
   ```bash
   /tmp/ocr-venv/bin/python3
   ```

### "OCR failed: timeout"

大图片处理时间较长。尝试：
- 裁剪图片到相关区域
- 如果图片过大（> 4000px），降低分辨率

### 识别准确率低

1. 确保图片有足够对比度
2. 对于小字，尝试放大截图
3. 手写文字识别效果可能不稳定

## 性能

| 图片大小 | 处理时间 |
|----------|----------|
| 1920x1080 | ~2-4 秒 |
| 3840x2160 | ~5-8 秒 |
| 7000x9000 | ~15-25 秒 |

时间包含模型加载（首次运行可能更慢）。

## 许可证

MIT
