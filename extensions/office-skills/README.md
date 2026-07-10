# Office Suite

Office Suite is a Finch mini tool that packages document workflows for Word, PDF, PowerPoint, and Excel.

## Included skills

- `office-docx` — create, read, edit, validate, and convert `.docx` documents.
- `office-pdf` — extract, OCR, merge, split, rotate, watermark, and create PDF files.
- `office-pptx` — create, read, edit, and visually QA `.pptx` presentations.
- `office-xlsx` — create, analyze, edit, recalculate, and validate `.xlsx`, `.xlsm`, `.csv`, and `.tsv` files.

## Usage

Enable the mini tool, then either ask Finch about an Office file directly or choose **Office Suite** in the Composer toolbar to insert a format-specific starter prompt.

## Permissions

- `filesystem: readwrite` — read and write selected Office files.
- `shell: true` — run local document tooling such as LibreOffice, Pandoc, Poppler, and validation scripts.
- `network: false` — the mini tool does not make network requests.

## Development

```bash
npm install
npm run build
npx @finch.app/minitools doctor .
```
