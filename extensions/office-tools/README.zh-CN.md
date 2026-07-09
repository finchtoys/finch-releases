# Office Tools

[Finch](https://finchwork.app) 扩展，让 Finch Agent 能够直接读取、创建和编辑 Word、Excel、PowerPoint 文件。

底层使用 [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) —— 专为 AI Agent 设计的 Office 套件命令行工具。

## 前置条件

- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) 二进制文件

  Agent 会在首次使用时自动调用 `setup_officecli` 下载安装，无需手动操作。

  手动安装方式：
  ```bash
  curl -fsSL https://d.officecli.ai/install.sh | bash
  # 或
  brew install officecli
  # 或
  npm install -g @officecli/officecli
  ```

## 功能

| 工具 | 说明 |
|------|------|
| `setup_officecli` | 下载安装 OfficeCLI（一次性设置） |
| `check_officecli` | 检查 OfficeCLI 安装状态 |
| `read_office_file` | 读取 .docx、.xlsx、.pptx 内容（大纲/HTML/纯文本/问题/统计） |
| `create_office_file` | 创建新文件 |
| `modify_office_file` | 增、改、删、移动元素，查找替换 |
| `get_office_element` | 获取元素的 JSON 结构化数据 |
| `inspect_office_file` | 校验文件、查询 OfficeCLI 帮助文档 |
| `preview_office_file` | 实时预览 + 浏览器点击选择元素 |
| `save_office_file` | 保存并关闭文件 |

### 支持的文件类型

- **Word** (.docx) — 完整文档读写编辑
- **Excel** (.xlsx) — 电子表格、公式、图表、透视表
- **PowerPoint** (.pptx) — 演示文稿，含幻灯片、形状、图表、动画

## 预览功能

支持三种格式的实时预览：

| 格式 | 预览行为 |
|------|---------|
| PPT | 创建/编辑时**自动启动**预览 |
| Word | 编辑时**询问用户**是否需要预览 |
| Excel | 编辑时**询问用户**是否需要预览 |

预览启动后会自动打开浏览器，编辑文件时浏览器自动刷新。可以在浏览器里点击选中元素，然后通过工具获取选中元素的路径进行编辑。

## 使用示例

安装并启用后，直接跟 Finch 说：

- _"帮我创建一个 Q4 汇报 PPT"_
- _"读取 report.docx 看看结构"_
- _"在 data.xlsx 的 B3 单元格写入 42"_
- _"给 PPT 第一页添加一个标题"_
- _"帮我预览一下这个 Excel"_

## 提示词指南

扩展内置了 34 个提示词指南，覆盖常见办公场景：

### 通用
- 检查 OfficeCLI 安装状态
- 查询 OfficeCLI 帮助文档

### Word
- 读取文档结构
- 创建正式报告（含目录、页眉页脚）
- 创建会议纪要
- 创建提案文档
- 创建合同协议
- 创建简历
- 添加表格和图片
- 添加批注和修订
- 批量查找替换

### Excel
- 读取表格结构
- 创建预算追踪器
- 创建销售仪表盘
- 创建数据透视表
- 创建成绩册
- 创建财务模型
- 创建项目追踪器
- 添加公式和图表
- 排序和筛选

### PowerPoint
- 读取幻灯片大纲
- 创建 Pitch Deck
- 创建季度业务回顾
- 创建产品发布会演示
- 创建培训演示
- 创建数据可视化演示
- 添加动画和过渡
- 移动/克隆/重排幻灯片
- 批量修改（统一字体、加 Logo）

### 预览
- 预览并点击编辑（通用）
- 预览 Word 文档
- 预览 Excel 表格
- 预览 PowerPoint

## 权限

- `filesystem: readwrite` — 读写 Office 文件
- `shell: true` — 运行 `officecli` 二进制文件

## 开发

```bash
npm install
npm run build
```

## 许可证

MIT