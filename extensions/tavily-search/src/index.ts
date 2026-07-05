import type * as finch from 'finch';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SERVER_NAME = 'tavily';
const REMOTE_URL = 'https://mcp.tavily.com/mcp/';
const DEFAULT_PARAMETERS = '{"include_images": true, "max_results": 15, "search_depth": "advanced"}';

type TavilyMode = 'local' | 'remote' | 'http';

type McpServerUi = {
  toolMeta?: {
    titles?: Record<string, string>;
  };
  toolDisplay?: {
    tools?: Record<string, finch.ToolCallDisplay>;
  };
};

type McpServerConfig = McpServerUi & (
  | { name: string; command: string; args?: string[]; env?: Record<string, string>; description?: string }
  | { name: string; url: string; headers?: Record<string, string>; env?: Record<string, string>; description?: string }
);

const TAVILY_MCP_UI: McpServerUi = {
  toolMeta: {
    titles: {
      tavily_search: 'Tavily Search',
      tavily_extract: 'Tavily Extract',
      tavily_crawl: 'Tavily Crawl',
      tavily_map: 'Tavily Map',
      tavily_research: 'Tavily Research',
    },
  },
  toolDisplay: {
    tools: {
      tavily_search: {
        inline: {
          mode: 'join',
          fields: [{ path: 'query', maxLength: 80 }],
          template: '{query}',
        },
      },
      tavily_extract: {
        inline: {
          mode: 'join',
          fields: [{ path: 'urls', format: 'truncate', maxLength: 80 }],
          template: '{urls}',
        },
      },
      tavily_crawl: {
        inline: {
          mode: 'join',
          fields: [{ path: 'url', format: 'truncate', maxLength: 80 }],
          template: '{url}',
        },
      },
      tavily_map: {
        inline: {
          mode: 'join',
          fields: [{ path: 'url', format: 'truncate', maxLength: 60 }],
          template: '{url}',
        },
      },
      tavily_research: {
        inline: {
          mode: 'join',
          fields: [
            { path: 'input', maxLength: 80 },
            { path: 'query', maxLength: 80 },
            { path: 'topic', maxLength: 40 },
          ],
          template: '{input}{query}{topic}',
        },
      },
    },
  },
};

interface ServersFile {
  servers?: McpServerConfig[];
}

interface McpClientCapability {
  listServers(): Promise<string[]>;
  getServerStatuses?(): Promise<Array<{ name: string; status: string; toolCount: number; ownerExtensionId?: string; qualifiedName?: string }>>;
  listTools(server: string): Promise<Array<{ name: string; title?: string; description?: string; inputSchema?: Record<string, unknown> }>>;
}

function t(ctx: finch.ExtensionContext, key: string, values?: Record<string, string | number | boolean>): string {
  return ctx.i18n?.t ? ctx.i18n.t(key, values) : key;
}

function mcpServersFile(ctx: finch.ExtensionContext): string {
  // MCP Bridge stores its own user config at <extension-data>/mcp/servers.json.
  // Extension storage directories are siblings, so derive it from this extension's storagePath.
  return join(dirname(ctx.storagePath), 'mcp', 'servers.json');
}

function readServers(file: string): ServersFile {
  if (!existsSync(file)) return { servers: [] };
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ServersFile;
  return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
}

function upsertServer(file: string, server: McpServerConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const data = readServers(file);
  const next = (data.servers ?? []).filter((item) => item.name !== server.name);
  next.push(server);
  next.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(file, JSON.stringify({ servers: next }, null, 2) + '\n', 'utf-8');
}

function buildTavilyUrl(apiKey: string): string {
  const url = new URL(REMOTE_URL);
  url.searchParams.set('tavilyApiKey', apiKey);
  return url.toString();
}

function parseMode(value: unknown): TavilyMode {
  if (value === 'remote' || value === 'http' || value === 'local') return value;
  return 'local';
}

function normalizeDefaultParameters(value: unknown): string {
  const raw = String(value ?? DEFAULT_PARAMETERS).trim() || DEFAULT_PARAMETERS;
  JSON.parse(raw);
  return raw;
}

function buildServer(mode: TavilyMode, apiKey: string, defaultParameters: string): McpServerConfig {
  if (mode === 'http') {
    return {
      name: SERVER_NAME,
      url: buildTavilyUrl(apiKey),
      headers: { DEFAULT_PARAMETERS: '${DEFAULT_PARAMETERS}' },
      env: { DEFAULT_PARAMETERS: defaultParameters },
      description: 'Tavily remote MCP server connected directly over Streamable HTTP.',
      ...TAVILY_MCP_UI,
    };
  }

  if (mode === 'remote') {
    return {
      name: SERVER_NAME,
      command: 'npx',
      args: ['-y', 'mcp-remote', buildTavilyUrl(apiKey)],
      env: { DEFAULT_PARAMETERS: defaultParameters },
      description: 'Tavily remote MCP server connected through mcp-remote.',
      ...TAVILY_MCP_UI,
    };
  }

  return {
    name: SERVER_NAME,
    command: 'npx',
    args: ['-y', 'tavily-mcp@latest'],
    env: {
      TAVILY_API_KEY: apiKey,
      DEFAULT_PARAMETERS: defaultParameters,
    },
    description: 'Local Tavily MCP server launched with npx. Recommended when DEFAULT_PARAMETERS should be passed through env.',
    ...TAVILY_MCP_UI,
  };
}

function serverSummary(server: McpServerConfig, mode: TavilyMode): string {
  if ('url' in server) return `${mode} → ${server.url.replace(/tavilyApiKey=[^&]+/, 'tavilyApiKey=***')}`;
  return `${mode} → ${server.command} ${(server.args ?? []).map((arg) => arg.includes('tavilyApiKey=') ? arg.replace(/tavilyApiKey=[^&]+/, 'tavilyApiKey=***') : arg).join(' ')}`;
}

async function verifyWithMcpClient(ctx: finch.ExtensionContext): Promise<string> {
  if (!ctx.capabilities.has('mcp.client')) {
    return 'MCP Client capability is not available. Enable the MCP Client extension, then try Tavily again.';
  }

  const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');
  try {
    const servers = await mcp.listServers();
    if (!servers.includes(SERVER_NAME)) {
      return 'Saved, but MCP Client has not picked up the tavily server yet. Disable/enable MCP Client or restart Finch if it does not appear shortly.';
    }
    const tools = await mcp.listTools(SERVER_NAME);
    const names = tools.map((tool) => tool.name).sort();
    return names.length
      ? `MCP Client can see Tavily tools: ${names.join(', ')}.`
      : 'MCP Client found the tavily server, but it has not reported tools yet.';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Saved, but connection validation did not complete: ${message}`;
  }
}

function registerSetupTool(ctx: finch.ExtensionContext): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'setup_tavily_search',
    title: 'Set up Tavily Search',
    description: 'Collect the user\'s Tavily API key in a secure form and write a local MCP Client configuration for the tavily server. Call this when Tavily is not configured, the user wants to connect Tavily, or Tavily MCP tools fail because the API key is missing.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['local', 'remote', 'http'],
          description: 'Connection mode. local uses npx -y tavily-mcp@latest and is recommended. remote uses npx -y mcp-remote with the Tavily remote MCP URL. http connects directly to the remote MCP URL.',
        },
        defaultParameters: {
          type: 'string',
          description: 'JSON string for Tavily DEFAULT_PARAMETERS. Defaults to include_images=true, max_results=15, search_depth=advanced.',
        },
      },
    },
    risk: 'medium',
    async execute(input, exec) {
      const args = input as { mode?: TavilyMode; defaultParameters?: string };
      const mode = parseMode(args.mode);
      const defaultParameters = args.defaultParameters ?? DEFAULT_PARAMETERS;

      const result = await exec.ui.requestForm({
        title: t(ctx, 'form.setup.title'),
        description: t(ctx, 'form.setup.description'),
        submitLabel: t(ctx, 'form.setup.submit'),
        fields: [
          {
            key: 'apiKey',
            label: 'TAVILY_API_KEY',
            type: 'password',
            secret: true,
            required: true,
            placeholder: 'tvly-…',
            description: t(ctx, 'form.setup.apiKey.description'),
          },
          {
            key: 'mode',
            label: t(ctx, 'field.mode'),
            type: 'select',
            required: true,
            default: mode,
            width: '1/2',
            options: [
              { value: 'local', label: 'local · npx tavily-mcp@latest' },
              { value: 'remote', label: 'remote · npx mcp-remote' },
              { value: 'http', label: 'http · direct remote MCP' },
            ],
          },
          {
            key: 'defaultParameters',
            label: 'DEFAULT_PARAMETERS',
            type: 'textarea',
            default: defaultParameters,
            description: t(ctx, 'form.setup.defaultParameters.description'),
          },
        ],
      });

      if (!result.submitted) {
        return { content: [{ type: 'text', text: `Tavily setup was cancelled (${result.reason}).` }] };
      }

      const apiKey = String(result.values.apiKey ?? '').trim();
      if (!apiKey) return { content: [{ type: 'text', text: 'No Tavily API key was provided; nothing was saved.' }], isError: true };

      let params: string;
      try {
        params = normalizeDefaultParameters(result.values.defaultParameters);
      } catch (err) {
        return { content: [{ type: 'text', text: `DEFAULT_PARAMETERS must be valid JSON: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }

      const selectedMode = parseMode(result.values.mode);
      const server = buildServer(selectedMode, apiKey, params);
      const file = mcpServersFile(ctx);

      try {
        upsertServer(file, server);
      } catch (err) {
        ctx.logger.error('failed to save Tavily MCP config', err);
        return { content: [{ type: 'text', text: `Failed to save Tavily MCP config: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }

      await ctx.ui.showToast({
        title: t(ctx, 'toast.saved.title'),
        description: t(ctx, 'toast.saved.description'),
        variant: 'success',
      });

      const validation = await verifyWithMcpClient(ctx);
      return {
        content: [{
          type: 'text',
          text: `Tavily Search has been configured locally as MCP server "${SERVER_NAME}" (${serverSummary(server, selectedMode)}). The API key was not returned to the model. ${validation}`,
        }],
      };
    },
  }));
}

function registerStatusTool(ctx: finch.ExtensionContext): void {
  ctx.subscriptions.push(ctx.tools.register({
    name: 'tavily_search_status',
    title: 'Tavily Search Status',
    description: 'Check whether Tavily Search MCP is configured and list the Tavily MCP tools visible through mcp.client. Call this when the user asks whether Tavily is connected or before troubleshooting Tavily tool availability.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'low',
    async execute() {
      const file = mcpServersFile(ctx);
      const configured = existsSync(file) && readServers(file).servers?.some((server) => server.name === SERVER_NAME);

      if (!ctx.capabilities.has('mcp.client')) {
        return { content: [{ type: 'text', text: `MCP Client capability is unavailable. Tavily configured in user config: ${configured ? 'yes' : 'no'}.` }], isError: !configured };
      }

      const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');
      const statuses = mcp.getServerStatuses ? await mcp.getServerStatuses() : [];
      const status = statuses.find((item) => item.name === SERVER_NAME);
      let tools: string[] = [];
      try {
        tools = (await mcp.listTools(SERVER_NAME)).map((tool) => tool.name).sort();
      } catch {
        // Status output below is enough for troubleshooting when the server is not reachable yet.
      }

      return {
        content: [{
          type: 'text',
          text: [
            `Configured: ${configured ? 'yes' : 'no'}`,
            `MCP status: ${status ? `${status.status} (${status.toolCount} tools cached)` : 'not listed'}`,
            `Tools: ${tools.length ? tools.join(', ') : 'none yet'}`,
          ].join('\n'),
        }],
      };
    },
  }));
}

export function activate(ctx: finch.ExtensionContext): void {
  ctx.logger.info('Tavily Search extension activated');
  registerSetupTool(ctx);
  registerStatusTool(ctx);
}

export function deactivate(): void {}
