---
name: tavily-search
description: Use this skill whenever the user needs fresh web research, current information, source-backed answers, Tavily Search, deep search, webpage extraction, site crawling, competitive/market research, documentation discovery, or fact checking against the open web. This skill should trigger even if the user does not explicitly say "Tavily" when the task needs up-to-date web results, reliable sources, or multiple web pages synthesized into an answer.
---

# Tavily Search

Use Tavily MCP tools for web research that needs current information, citations, extraction from URLs, crawling, mapping a site, or comprehensive multi-source research. Tavily is better than a generic web search when the user wants concise search results with source URLs, full page extraction, or a researched answer grounded in open-web sources.

## Before using Tavily

1. If Tavily may not be configured, call the extension tool `tavily_search_status`.
2. If status says Tavily is not configured or tools are missing because of the API key, call `setup_tavily_search`. It opens a secure form; never ask the user to paste `TAVILY_API_KEY` in chat.
3. To use Tavily MCP tools in a Finch session, first call Finch `ToolSearch` with `source: "mcp"` and a natural-language query such as `Tavily search tools`. MCP tools are injected on demand and are named like `mcp__tavily__<tool>`.

### How Tavily's MCP server is managed (do NOT configure it manually)

`setup_tavily_search` is the ONLY thing you need. Once the user submits the key,
this extension registers the `tavily` MCP server with the MCP Client **for you** —
you do NOT create a `servers.json` entry and you do NOT touch it via the `MCP`
tool. Specifically:

- **Never** call `MCP` with `action=add/edit/remove` for `tavily`. It is registered
  at runtime and bound to this extension's lifecycle; manual edits will be
  overwritten or orphaned.
- If `MCP` `action=list` shows `tavily` as `pending` with 0 tools, that just means
  the API key hasn't been stored yet — call `setup_tavily_search`, **not** `MCP edit`.
- Uninstalling or disabling Tavily Search automatically removes the `tavily` MCP
  server and its stored key. No cleanup is needed.
- After `setup_tavily_search` succeeds, the server connects automatically; just run
  `ToolSearch` (`source: "mcp"`) and then call the `mcp__tavily__<tool>` functions.

## Tool selection

Tavily MCP exposes 5 tools. Choose by task shape:

- `tavily_search`: search the web for current information on any topic. Use for news, fresh facts, market/data lookups, or anything beyond the model knowledge cutoff. It returns snippets and source URLs, so it is the best first step for broad discovery and source-backed answers.
- `tavily_extract`: extract content from known URLs. Use when the user gives URLs, when search results need full-page details, or when you need raw page content in markdown/text before summarizing.
- `tavily_crawl`: crawl a website starting from a URL with configurable depth/breadth. Use for docs discovery, site-wide collection, or gathering multiple linked pages under one domain. Prefer `tavily_map` first if you need to understand the site structure before crawling.
- `tavily_map`: map a website's structure and return URLs found from a base URL. Use for sitemap-like discovery, choosing crawl targets, or finding relevant docs/pages before extraction.
- `tavily_research`: perform comprehensive research on a topic or question across multiple sources and return a detailed researched response. Use when the user asks for an answer, report, comparison, briefing, investigation, or synthesis and you do not need to manually control every source. Rate limit: 20 requests/minute, so avoid calling it repeatedly in loops.

If tool names differ, inspect the injected Tavily MCP tool list and choose the closest match.

## Workflows

### Quick current-info answer

1. Restate the research target internally as a precise query.
2. Use `tavily_search` with advanced depth for nuanced research. Good defaults:
   - `search_depth`: `advanced`
   - `max_results`: 8–15 depending on scope
   - `include_images`: true only when images are useful
   - `include_raw_content`: false unless you need full text directly in search results
3. Read result titles, snippets, URLs, and dates if present. Prefer primary sources, official docs, standards, reputable publications, and recent pages.
4. Use `tavily_extract` on the most important URLs when snippets are not enough.
5. Synthesize; do not dump raw results.

### Comprehensive research answer

Use `tavily_research` when the user asks for a researched answer rather than just a list of search results, for example “帮我调研…”, “比较 A 和 B”, “写一份简报”, “what is the current state of…”. Treat its output as a research draft: verify surprising claims with `tavily_search`/`tavily_extract` when stakes are high, then answer with clear citations.

### Website / docs exploration

1. Use `tavily_map` on the base URL to discover candidate pages.
2. Use `tavily_crawl` when you need many related pages from the same site.
3. Use `tavily_extract` for selected URLs that need faithful page-level content.

## Output style

For research answers, use this structure unless the user requested another format:

```markdown
## 结论
- 直接回答用户的问题。

## 关键发现
- 发现 1（来源：URL）
- 发现 2（来源：URL）

## 需要注意
- 不确定性、时间范围、冲突信息或需要进一步验证的点。
```

For English conversations, use English headings. In Finch's Chinese default, answer in Chinese.

## Citation rules

- Include source URLs for factual claims from the web.
- Prefer 3–6 high-quality sources over many weak sources.
- If sources conflict, say so and explain which source you trust more and why.
- Do not invent citations. If Tavily returns no useful source, say that the search did not find enough evidence.

## Configuration notes

This extension supports three Tavily MCP modes:

- `local` (recommended): `npx -y tavily-mcp@latest` with `TAVILY_API_KEY` and `DEFAULT_PARAMETERS` in env.
- `remote`: `npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=…`.
- `http`: direct Streamable HTTP to `https://mcp.tavily.com/mcp/?tavilyApiKey=…`.

Prefer `local` unless the user specifically asks to use remote MCP. The default parameters are:

```json
{"include_images": true, "max_results": 15, "search_depth": "advanced"}
```
