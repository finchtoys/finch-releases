# Tavily Search

Tavily Search is a mini tool for [Finch](https://finchwork.app/) — a desktop AI agent you can download at [finchwork.app](https://finchwork.app/). Once enabled, Finch can use Tavily to run web search, extract page content, crawl sites, and map sites, giving you source-backed answers.

## Usage

1. Enable the MCP Client extension.
2. Enable the Tavily Search extension.
3. Ask Finch: `Set up Tavily Search`, then paste your Tavily API key into the secure form.
4. Use `/tavily-search` for web research.

You need a Tavily API key — sign up at [tavily.com](https://www.tavily.com/).

## Tools

- `setup_tavily_search`: enter your Tavily API key to connect.
- `tavily_search_status`: check whether Tavily is connected and which tools are available.

## Security

Your Tavily API key is collected via Finch's secret form field, is never echoed back to the model, and is stored only in this extension's local storage — removing Tavily also removes it.
