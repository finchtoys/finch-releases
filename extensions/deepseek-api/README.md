# DeepSeek API

One DeepSeek API key gives Finch three capabilities:

| Capability | What it does |
| --- | --- |
| Web search | Searches the web and returns ranked results with url, snippet, summary and optional full content |
| Page reading | Reads one URL and returns the page as Markdown |
| OCR | Recognizes text in PDF, Word, PowerPoint, and images (PNG / JPEG / WebP / GIF / BMP / TIFF) |

All three are the raw DeepSeek tool APIs (`/v1/tools/search`, `/v1/tools/fetch`, `/v1/tools/ocr`) behind the same Bearer key, so there is exactly one thing to configure.

## Install

```bash
npx @finchtoys/minitools add .
```

Then enable **DeepSeek API** in Toolcase.

## Set the key

Either way works; both store the key in system secure storage (Keychain / DPAPI / Secret Service), never in a config file, and never return it to the model.

- Click the gear on the DeepSeek API card in Toolcase → **Configure API key**.
- Or just ask Finch to connect DeepSeek — the tool asks for the key in a secure form.

Create a key at <https://platform.deepseek.com/api_keys>.

## Tools

### `deepseek_api`

One tool, four actions:

| action | Required input | Notes |
| --- | --- | --- |
| `search` | `query` (1–128 chars, supports `site:`, `-site:`, quotes) | `count` 1–20 (default 5), `need_content` (default false) |
| `fetch` | `url` | Returns `# title` + Markdown body |
| `ocr` | `path` (local file) **or** `url` (remote file) | `purpose`: `text_recognition` (default) or `rich_layout_recognition` |
| `status` | — | Confirms a key is stored and shows the account balance |

### `setup_deepseek_api`

Collects the key through a secure form and verifies it against the balance endpoint.

## Limits and billing

Set by DeepSeek, not by this mini tool:

- Search and Fetch are billed per 1,000 successful requests (¥5); failed requests and empty results are not billed.
- OCR files are capped at 100 MiB and 1,000 pages, and must finish within 180 s. The tool declares a matching timeout, so a large document waits instead of failing early.
- OCR keeps the per-page `<ref>` / `<box>` coordinate markers in `rich_layout_recognition` output; a page whose `finish_reason` is `length` is reported as incomplete.

## Privacy

The key is stored under the exact secret key `deepseek.apiKey` and is only sent to `api.deepseek.com`. Nothing else is persisted.

## Development

```bash
npm install
npm run build
npx @finchtoys/minitools doctor .
npx @finchtoys/minitools add .
```
