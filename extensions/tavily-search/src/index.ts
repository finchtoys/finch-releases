import type * as finch from 'finch';

const SERVER_NAME = 'tavily';
const REMOTE_URL = 'https://mcp.tavily.com/mcp/';
const DEFAULT_PARAMETERS = '{"include_images": true, "max_results": 15, "search_depth": "advanced"}';
/** ctx.storage key holding the user's setup inputs (apiKey + mode + params).
 *  This is the extension's OWN storage, removed automatically on uninstall — so
 *  Tavily's config never lingers inside the MCP Client after removal. */
const STORAGE_KEY = 'tavily.setup';

type TavilyMode = 'local' | 'remote' | 'http';

/** Persisted setup inputs. The resolved MCP server config is rebuilt from these
 *  on every activation, so buildServer() logic can evolve without migrations. */
interface StoredSetup {
  apiKey: string;
  mode: TavilyMode;
  defaultParameters: string;
}

// Transport is built dynamically here (command/url + env with the resolved API key)
// and registered via mcp.client#registerServer() at activate time.
// Presentation metadata (tool titles, ToolCallCard inline summaries) is declared
// statically in package.json under `contributes.mcpServers[].toolMeta / toolDisplay`.
// The MCP bridge merges both: transport from the runtime registration, presentation
// from the contribution, and writes the result to the global tool catalog
// (~/.finch/tools.json) when the tools connect.
// This separation means no secrets ever appear in the static manifest, and the
// extension never writes to the shared servers.json user config file.
type McpServerConfig =
  | { name: string; command: string; args?: string[]; env?: Record<string, string>; description?: string; ownerExtensionId?: string; ownerExtensionName?: string }
  | { name: string; url: string; headers?: Record<string, string>; env?: Record<string, string>; description?: string; ownerExtensionId?: string; ownerExtensionName?: string };

interface McpClientCapability {
  listServers(): Promise<string[]>;
  getServerStatuses?(): Promise<Array<{ name: string; status: string; toolCount: number; ownerExtensionId?: string; qualifiedName?: string }>>;
  listTools(server: string): Promise<Array<{ name: string; title?: string; description?: string; inputSchema?: Record<string, unknown> }>>;
  /** Register a runtime MCP server bound to this extension's lifecycle. In-memory
   *  only on the MCP Client side; leaves no orphaned config on uninstall. */
  registerServer(config: McpServerConfig): Promise<{ ok: boolean; error?: string }>;
  unregisterServer(name: string): Promise<{ ok: boolean }>;
}

/** Active context, captured on activate so deactivate() can unregister the
 *  runtime server (deactivate has no ctx parameter). */
let activeCtx: finch.ExtensionContext | null = null;

function t(ctx: finch.ExtensionContext, key: string, values?: Record<string, string | number | boolean>): string {
  return ctx.i18n?.t ? ctx.i18n.t(key, values) : key;
}

async function readSetup(ctx: finch.ExtensionContext): Promise<StoredSetup | undefined> {
  const raw = await ctx.storage.get<StoredSetup>(STORAGE_KEY);
  if (!raw || typeof raw.apiKey !== 'string' || !raw.apiKey) return undefined;
  let mode = parseMode(raw.mode);
  // Migrate legacy setups: `remote` is the deprecated mcp-remote proxy shim —
  // Finch connects to the same endpoint directly over HTTP, so upgrade it to
  // `http` and persist the change. `local` is left untouched (deliberate choice).
  if (mode === 'remote') {
    mode = 'http';
    await ctx.storage.set(STORAGE_KEY, { ...raw, mode });
  }
  return { apiKey: raw.apiKey, mode, defaultParameters: String(raw.defaultParameters ?? DEFAULT_PARAMETERS) };
}

/** Persist setup inputs, then (re)register the resolved server with MCP Client. */
async function saveAndRegister(ctx: finch.ExtensionContext, setup: StoredSetup): Promise<{ ok: boolean; error?: string }> {
  await ctx.storage.set(STORAGE_KEY, setup);
  return registerRuntimeServer(ctx, setup);
}

/** Build the resolved server from stored setup and hand it to MCP Client. */
async function registerRuntimeServer(ctx: finch.ExtensionContext, setup: StoredSetup): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.capabilities.has('mcp.client')) return { ok: false, error: 'mcp.client capability unavailable' };
  const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');
  const server = buildServer(setup.mode, setup.apiKey, setup.defaultParameters);
  server.ownerExtensionId = ctx.extension.id;
  server.ownerExtensionName = ctx.extension.displayName;
  try {
    return await mcp.registerServer(server);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove Tavily's runtime server from MCP Client (best-effort). */
async function unregisterRuntimeServer(ctx: finch.ExtensionContext): Promise<void> {
  if (!ctx.capabilities.has('mcp.client')) return;
  try {
    await ctx.capabilities.get<McpClientCapability>('mcp.client').unregisterServer(SERVER_NAME);
  } catch {
    // App shutdown or MCP Client already gone — runtime state is in-memory, so
    // it disappears anyway; nothing to clean up.
  }
}

function buildTavilyUrl(apiKey: string): string {
  const url = new URL(REMOTE_URL);
  url.searchParams.set('tavilyApiKey', apiKey);
  return url.toString();
}

function parseMode(value: unknown): TavilyMode {
  if (value === 'local' || value === 'remote') return value;
  // Default to direct Streamable HTTP: no local child process / npx cold start,
  // no stdio proxy hop — Finch's MCP Client connects straight to Tavily's hosted
  // MCP endpoint, which is the lowest-overhead path on Finch.
  return 'http';
}

function normalizeDefaultParameters(value: unknown): string {
  const raw = String(value ?? DEFAULT_PARAMETERS).trim() || DEFAULT_PARAMETERS;
  JSON.parse(raw);
  return raw;
}

function buildServer(mode: TavilyMode, apiKey: string, defaultParameters: string): McpServerConfig {
  if (mode === 'local') {
    return {
      name: SERVER_NAME,
      command: 'npx',
      args: ['-y', 'tavily-mcp@latest'],
      env: {
        TAVILY_API_KEY: apiKey,
        DEFAULT_PARAMETERS: defaultParameters,
      },
      description: 'Local Tavily MCP server launched with npx. Recommended when DEFAULT_PARAMETERS should be passed through env.',
    };
  }

  if (mode === 'remote') {
    return {
      name: SERVER_NAME,
      command: 'npx',
      args: ['-y', 'mcp-remote', buildTavilyUrl(apiKey)],
      env: { DEFAULT_PARAMETERS: defaultParameters },
      description: 'Tavily remote MCP server connected through mcp-remote.',
    };
  }

  // Default: direct Streamable HTTP — no local child process, lowest overhead.
  return {
    name: SERVER_NAME,
    url: buildTavilyUrl(apiKey),
    headers: { DEFAULT_PARAMETERS: '${DEFAULT_PARAMETERS}' },
    env: { DEFAULT_PARAMETERS: defaultParameters },
    description: 'Tavily remote MCP server connected directly over Streamable HTTP.',
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
    description: 'Collect the Tavily API key via secure form and configure the MCP server. Call this when Tavily is not set up yet.',
    inputSchema: { type: 'object', properties: {} },
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
            label: 'API Key',
            type: 'password',
            secret: true,
            required: true,
            placeholder: 'tvly-…',
            description: t(ctx, 'form.setup.apiKey.description'),
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
      const setup: StoredSetup = { apiKey, mode: selectedMode, defaultParameters: params };
      const server = buildServer(selectedMode, apiKey, params);

      const registration = await saveAndRegister(ctx, setup);
      if (!registration.ok) {
        ctx.logger.error('failed to register Tavily MCP server', registration.error);
        return { content: [{ type: 'text', text: `Saved Tavily setup, but MCP Client did not accept the server: ${registration.error ?? 'unknown error'}.` }], isError: true };
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
          text: `Tavily Search has been registered with MCP Client as server "${SERVER_NAME}" (${serverSummary(server, selectedMode)}). The API key was not returned to the model and is stored in this extension's own storage, so removing Tavily also removes it. ${validation}`,
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
      const configured = Boolean(await readSetup(ctx));

      if (!ctx.capabilities.has('mcp.client')) {
        return { content: [{ type: 'text', text: `MCP Client capability is unavailable. Tavily configured in extension storage: ${configured ? 'yes' : 'no'}.` }], isError: !configured };
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

/** Wait for the mcp.client capability to come online, then register. Extension
 *  activation order is not guaranteed (Finch activates alphabetically by display
 *  name), so if the MCP Client host hasn't provided its capability yet, poll a
 *  few times before giving up. Finch seeds + pushes capability availability, so
 *  has() flips to true as soon as MCP Client is up. */
async function registerWhenReady(ctx: finch.ExtensionContext, setup: StoredSetup): Promise<void> {
  const MAX_ATTEMPTS = 20;
  const INTERVAL_MS = 250;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (ctx.capabilities.has('mcp.client')) {
      const res = await registerRuntimeServer(ctx, setup);
      if (res.ok) return;
      ctx.logger.warn('Tavily runtime server registration failed:', res.error);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
  ctx.logger.warn('Tavily: mcp.client capability never became available; server not registered. Is MCP Client enabled?');
}

export function activate(ctx: finch.ExtensionContext): void {
  ctx.logger.info('Tavily Search extension activated');
  activeCtx = ctx;
  registerSetupTool(ctx);
  registerStatusTool(ctx);
  // Re-register the runtime MCP server from stored setup. Runtime registrations
  // are in-memory on the MCP Client side and lost across restarts, so we restore
  // them on every activation. No-op when Tavily hasn't been set up yet.
  void readSetup(ctx).then((setup) => {
    if (!setup) return;
    return registerWhenReady(ctx, setup);
  }).catch((err) => ctx.logger.error('Tavily activation registration failed', err));
}

export function deactivate(): void {
  const ctx = activeCtx;
  activeCtx = null;
  if (ctx) void unregisterRuntimeServer(ctx);
}
