# Office Tools

A [Finch](https://finchwork.app) mini tool that enables **reading, creating, and editing Word, Excel, and PowerPoint files** directly from the Finch agent.

Powered by [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) — the world's first Office suite built for AI agents.

## Requirements

- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) binary

  The agent will automatically call `setup_officecli` to download and install it on first use. No manual installation needed.

  Manual install alternatives:
  ```bash
  # macOS / Linux
  curl -fsSL https://d.officecli.ai/install.sh | bash

  # or Homebrew
  brew install officecli

  # or npm
  npm install -g @officecli/officecli
  ```

## Features

| Tool | Description |
|------|-------------|
| `setup_officecli` | Download and install OfficeCLI (one-time setup) |
| `check_officecli` | Check if OfficeCLI is installed |
| `read_office_file` | Read .docx, .xlsx, .pptx content (outline / html / text / issues / stats) |
| `create_office_file` | Create new empty Office files |
| `modify_office_file` | Add, set, remove, move elements, find & replace |
| `get_office_element` | Get structured JSON for a specific element |
| `inspect_office_file` | Validate file, query OfficeCLI help system |
| `preview_office_file` | Live preview in browser + click-to-select elements |
| `save_office_file` | Save and close a file |

### Supported File Types

- **Word** (.docx) — full document reading and editing
- **Excel** (.xlsx) — spreadsheets, formulas, charts, pivot tables
- **PowerPoint** (.pptx) — presentations with slides, shapes, charts, images

## Usage

Once installed and enabled in Finch, just ask the agent:

- _"Read my report.docx"_
- _"Create a new presentation called demo.pptx with 3 slides"_
- _"Add a chart to the first slide"_
- _"Edit cell B3 in data.xlsx to be 42"_
- _"Check if OfficeCLI is installed"_

## Permissions

- `filesystem: readwrite` — read and write Office files
- `shell: true` — run the `officecli` binary

## Development

```bash
npm install
npm run build
```

## License

MIT