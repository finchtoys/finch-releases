---
name: deepseek-api
description: Use this skill when the user needs web search with ranked sources, a specific URL read as Markdown, or text extracted from a PDF, Word, PowerPoint, or image file (OCR). Trigger for requests like "搜一下最新的 X", "读一下这个链接", "把这个 PDF/截图里的文字取出来", or when the deepseek_api tool reports that no API key is configured.
---

# DeepSeek API

`deepseek_api` wraps three DeepSeek tool APIs behind one key: `search`, `fetch`, `ocr`, plus `status`. Use it instead of a generic web search when the user wants ranked sources with summaries, needs one specific page read in full, or needs text out of a document or image.

## Before using it

1. If a call returns "DeepSeek API is not configured yet", call `setup_deepseek_api` first — it opens a secure form for the key. Never ask the user to paste a key into chat.
2. When the user asks whether it is connected or something fails, call `deepseek_api` with `action: "status"`. It reports whether a key is stored and the account balance; a `402` means the account has no balance left.

## Choosing an action

| Situation | Call |
| --- | --- |
| Needs current information or sources | `action: "search"` with `query` |
| Already has a URL and wants its content | `action: "fetch"` with `url` |
| Has a file (PDF / DOC / DOCX / PPT / PPTX / image) and wants its text | `action: "ocr"` with `path` |
| Wants search results plus the full page text in one step | `action: "search"` with `need_content: true` |

`fetch` is cheaper and more precise than searching for a page you already have. Prefer it whenever the URL is known.

## Parameter rules

- `query` is capped at 128 Unicode characters. Narrow it instead of lengthening it; use `site:`, `-site:`, and quoted phrases to constrain results.
- `count` defaults to 5. Use 10 only when the user wants breadth; above that the extra results are usually noise.
- `rerank_score` in each result runs 0–3; treat ≥ 1.5 as a good source and say so when citing weak ones.
- `ocr` takes `path` for a local file (absolute path) or `url` for a remote one. Pass the absolute path the user gave you; do not guess a location.
- For `ocr`, `purpose: "text_recognition"` is the default and is what you want for plain text extraction. Use `rich_layout_recognition` only when layout or coordinates matter — its output keeps `<ref>` / `<box>` coordinate markers per page.
- OCR can legitimately take minutes for a large document; the tool declares a long timeout, so do not retry a slow call.

## Reading the output

- Search output is a numbered list: title, url, then `site · date · rerank`, then the summary. Cite the url.
- OCR output is split per page (`--- 第 N 页 ---`). A page marked "output hit the limit, this page is incomplete" was truncated — say so rather than presenting it as the full page.
- OCR token counts in the footer are informational; DeepSeek bills Search and Fetch per 1,000 successful requests, not per token.

## Errors worth relaying

- `402` — the DeepSeek account balance is exhausted; the user needs to top up.
- `413` — the file exceeds the 100 MiB OCR limit; suggest splitting the document.
- `429` — too many concurrent recognitions; wait and retry once rather than looping.
