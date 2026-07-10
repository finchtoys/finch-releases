# Office 办公套件

Office 办公套件是一个 Finch 小工具，整合 Word、PDF、PowerPoint 和 Excel 的文档处理工作流。

## 内嵌技能

- `office-docx`：创建、读取、编辑、校验和转换 `.docx` 文档。
- `office-pdf`：提取、OCR、合并、拆分、旋转、加水印和创建 PDF 文件。
- `office-pptx`：创建、读取、编辑并视觉检查 `.pptx` 演示文稿。
- `office-xlsx`：创建、分析、编辑、重算和校验 `.xlsx`、`.xlsm`、`.csv`、`.tsv` 文件。

## 使用

启用小工具后，直接向 Finch 提出 Office 文件需求，或在 Composer 工具栏选择「Office 办公套件」以快速填入对应格式的起始请求。

## 权限

- `filesystem: readwrite`：读取和写入已选的 Office 文件。
- `shell: true`：运行 LibreOffice、Pandoc、Poppler 和校验脚本等本机文档工具。
- `network: false`：小工具不会发起网络请求。

## 开发

```bash
npm install
npm run build
npx @finchtoys/minitools doctor .
```
