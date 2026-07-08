# PP-OCRv6

PP-OCRv6 扩展通过 Finch 的 MCP Client 连接 PP-OCRv6 ONNX 模型，让 Agent 可以本地提取图片中的文字。无需云端 API 调用，数据不离开你的电脑。

## 下载镜像

扩展首次使用时会从 HuggingFace 下载模型（Medium 档约 132 MB，缓存到 `extension-data/ocr/models/`）。中国大陆用户无需手动配置——如果 `huggingface.co` 不可达（>15s 超时），自动回退到 `hf-mirror.com`：

```
primary (huggingface.co) ── 15s 超时 → fallback (hf-mirror.com)
```

## 模型档位

| 档位 | 参数量 | 体积 | 速度 | 准确率 (W-Avg) |
|---|---|---|---|---|
| Tiny | 1.5M | ~6 MB | 最快 | 73.5 |
| Small | 7.7M | ~30 MB | 均衡 | 81.3 |
| Medium（默认） | 34.5M | ~132 MB | 较慢 | 83.2 |

## 使用方式

1. 启用 **MCP Client** 扩展。
2. 启用 **PP-OCRv6** 扩展。
3. （可选）在扩展 Settings 面板中预设模型档位和语言。
4. 对 Finch 说：`帮我设置 OCR`。扩展会调用 `setup_ocr` 下载模型并配置 MCP 服务。
5. 发送一张带文字的图片，然后说：`识别这张图里的文字`。`ocr_image` 工具返回带坐标框的文字结果。

## 工具

- `setup_ocr`：选择模型档位和识别语言，从 HuggingFace 下载 ONNX 模型，注册本机 MCP server。
- `ocr_status`：检查已缓存的模型和 MCP server 就绪状态。
- `ocr_image`（MCP）：检测文字区域并识别图中的文字。
- `ocr_languages`（MCP）：列出当前语言和模型配置。

## 设置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `tier` | select | `medium` | 模型档位：tiny / small / medium |
| `language` | select | `ch+en` | 识别语言：ch+en / en / ch / ch+en+ja |

在 Finch → Toolcase → Extensions → PP-OCRv6 → Settings 中配置。当所选档位的模型已缓存，扩展启动时自动配置 MCP server，无需额外对话。

## 权限

- `filesystem: readwrite`：将模型写入 `extension-data/ocr/models/`，将 MCP 配置写入 `mcp/servers.json`。
- `network: true`：首次使用时从 HuggingFace（或镜像）下载 ONNX 模型。
- `shell: false`：本扩展不执行 shell 命令。MCP Client 以 Node.js 子进程方式启动 OCR server。

## 图片格式

支持 PNG、JPG、WebP、TIFF、AVIF（依赖 `sharp`）。暂不支持 PDF，请先转换为图片再使用。

## 隐私说明

所有 OCR 推理均在本地运行。图片和提取的文字不会发送到任何云端服务。网络访问仅用于模型下载（可通过镜像地址配置）。
