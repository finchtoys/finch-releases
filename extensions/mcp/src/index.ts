/**
 * @finch/extension-mcp — official Model Context Protocol bridge.
 *
 * Connects to MCP servers from two sources, exposes a small dynamic gateway
 * toolset to the Agent, and provides an `mcp.client` capability so other
 * extensions can talk to MCP servers without bundling their own client:
 *   - `<extensionData>/servers.json`            — user / local config file
 *   - `ctx.extensions.listContributions('mcpServers')` — servers contributed by
 *      enabled extensions via `contributes.mcpServers`.
 *
 * Supported server shapes (transport inferred from field presence):
 *   - stdio:      { name, command, args?, env?, cwd? }      — command presence → stdio
 *   - httpStream: { name, url, headers?, env? }             — url presence → httpStream
 */
import type * as finch from 'finch';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpClient, isHttpConfig, type McpClient, type McpHttpStreamServerConfig, type McpServerConfig, type McpTool, type McpToolResult } from './client.js';

type ManagedMcpServerConfig = McpServerConfig & {
  ownerExtensionId?: string;
  qualifiedName?: string;
  toolMeta?: {
    titles?: Record<string, string>;
  };
  toolDisplay?: {
    tools?: Record<string, finch.ToolCallDisplay>;
  };
};

interface ServersFile {
  servers?: ManagedMcpServerConfig[];
}

/** Connection state for each configured server. */
export type ServerStatus = 'pending' | 'connecting' | 'connected' | 'failed' | 'reconnecting';

/** All configured MCP servers (populated on activate, requires no connection). */
const configs = new Map<string, ManagedMcpServerConfig>();
/** Live connected clients (populated lazily on first use). */
const clients = new Map<string, McpClient>();
/** Cached tool lists for connected servers. */
const serverTools = new Map<string, McpTool[]>();
/** In-flight connection promises — prevents duplicate parallel connects. */
const connecting = new Map<string, Promise<void>>();
/** Current connection status for each configured server. */
const serverStatus = new Map<string, ServerStatus>();
/** Last user-visible connection error for each configured server. */
const serverLastError = new Map<string, string>();
/** Pending reconnect timers (stdio only, exponential backoff). */
const reconnectTimers = new Map<string, NodeJS.Timeout>();
/**
 * Disposables for dynamically registered mcp__<server>__<tool> tools.
 * Keyed by server name → (model-facing tool name → disposable). The inner map
 * lets us diff against a fresh tool list and register/dispose only what changed,
 * instead of unregister-all-then-readd (which transiently empties the host
 * registry and races with mid-run dynamic-tool injection).
 */
const registeredTools = new Map<string, Map<string, finch.Disposable>>();
/** Active ExtensionContext — stored so module-level helpers can register tools dynamically. */
let activeCtx: finch.ExtensionContext | null = null;

// Reconnection constants (stdio only — httpStream heals naturally per-request).
const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const LIST_TOOLS_TIMEOUT_MS = 20_000;

/**
 * Sanitize a raw string to a valid Finch tool name segment (lowercase a-z, 0-9, _).
 * Used to derive `mcp__<server>__<tool>` names from arbitrary server/tool names.
 */
function sanitizeSegment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function titleCase(value: string): string {
  return value.split(/\s+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

function humanizeMcpToolName(name: string): string {
  const exact: Record<string, string> = {
    issue_read: 'Get Issue',
    issue_write: 'Write Issue',
    sub_issue_write: 'Write Sub-Issue',
    pull_request_read: 'Get Pull Request',
    pull_request_review_write: 'Write Pull Request Review',
    discussion_comment_write: 'Write Discussion Comment',
    label_write: 'Write Label',
    actions_get: 'Get Actions Resource',
    actions_list: 'List Actions Workflows',
    actions_run_trigger: 'Run Actions Workflow',
    get_job_logs: 'Get Job Logs',
    github_support_docs_search: 'Search GitHub Support Docs',
  };
  if (exact[name]) return exact[name];
  return titleCase(name.replace(/_/g, ' '))
    .replace(/\bPr\b/g, 'PR')
    .replace(/\bPrs\b/g, 'PRs')
    .replace(/\bGithub\b/g, 'GitHub')
    .replace(/\bCopilot\b/g, 'Copilot');
}

function isGitHubServer(serverName: string): boolean {
  const value = serverName.trim().toLowerCase();
  return value === 'github' || value.startsWith('github-') || value.startsWith('github_');
}

function githubInlineDisplay(): finch.ToolInlineDisplaySpec {
  return {
    mode: 'join',
    fields: [
      { path: 'owner' },
      { path: 'repo' },
      { path: 'issueNumber' },
      { path: 'pullNumber' },
      { path: 'number' },
      { path: 'path', format: 'truncate', maxLength: 40 },
      { path: 'branch', maxLength: 24 },
      { path: 'base', maxLength: 24 },
      { path: 'head', maxLength: 24 },
      { path: 'tag', maxLength: 24 },
      { path: 'perPage' },
      { path: 'state', maxLength: 20 },
      { path: 'query', format: 'truncate', maxLength: 50 },
      { path: 'q', format: 'truncate', maxLength: 50 },
      { path: 'resource_id' },
      { path: 'workflow_id' },
    ],
    template: '{owner}/{repo} #{issueNumber} #{pullNumber} #{number} path:{path} branch:{branch} base:{base} head:{head} tag:{tag} perPage:{perPage} state:{state} query:{query} q:{q} id:{resource_id} workflow:{workflow_id}',
  };
}

function buildMcpToolTitle(serverName: string, toolName: string): string | undefined {
  const config = configs.get(serverName);
  if (!config?.ownerExtensionId) return undefined;
  return config.toolMeta?.titles?.[toolName]
    ?? (isGitHubServer(serverName) ? humanizeMcpToolName(toolName) : undefined);
}

function buildMcpToolCallDisplay(serverName: string, toolName: string): finch.ToolCallDisplay | undefined {
  const config = configs.get(serverName);
  const ownerExtensionId = config?.ownerExtensionId;
  if (!ownerExtensionId) return undefined;
  const declared = config?.toolDisplay?.tools?.[toolName];
  if (declared) return declared;
  if (isGitHubServer(serverName)) {
    return {
      inline: githubInlineDisplay(),
    };
  }
  return undefined;
}

/**
 * Heuristic: does this error mean the httpStream session/transport is dead and
 * the client must be re-initialized? Tool-level failures (bad arguments, server
 * 4xx for the call itself, validation errors) should NOT drop the cached client —
 * dropping it forces a full MCP `initialize` handshake on the very next call,
 * which is the "reconnects every time" behavior we want to avoid. We only reset
 * on transport/session-level signals.
 */
function isSessionDeadError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('not running') ||
    msg.includes('session') ||
    msg.includes('transport') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('terminated') ||
    msg.includes('closed')
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Dispose and remove all registered mcp__<server>__* tools for a server. */
function unregisterServerTools(name: string): void {
  const byTool = registeredTools.get(name);
  if (byTool) {
    for (const d of byTool.values()) d.dispose();
    registeredTools.delete(name);
  }
}

/** Build the Finch tool registration for one MCP tool of a server. */
function buildServerToolRegistration(serverName: string, toolName: string, tool: McpTool): finch.ToolDefinition {
  const seg = sanitizeSegment(serverName);
  const toolSeg = sanitizeSegment(tool.name);
  const title = buildMcpToolTitle(serverName, tool.name);
  const callDisplay = buildMcpToolCallDisplay(serverName, tool.name);
  // Attribute the tool to the extension that contributed this server (if any), so
  // its provenance, permission gatekeeping, and UI count follow that extension
  // rather than the MCP bridge itself. User-defined servers (no contribution
  // owner) stay attributed to the bridge.
  const ownerExtensionId = configs.get(serverName)?.ownerExtensionId;
  return {
    name: `mcp__${seg}__${toolSeg}`,
    title: title ?? tool.name,
    description: tool.description ?? `${tool.name} tool from MCP server "${serverName}"`,
    inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as finch.JsonSchema,
    risk: 'medium',
    ...(ownerExtensionId ? { owner: { extensionId: ownerExtensionId } } : {}),
    ...(callDisplay ? { callDisplay } : {}),
    // MCP server tools can be numerous and are discovered on demand via Finch ToolSearch.
    // Keep them out of new sessions' startup schema and inject them into active
    // runs only after the server connects.
    exposure: 'dynamic',
    async execute(input): Promise<finch.ToolResult> {
      // Ensure connected; handles httpStream auto-heal on error.
      if (!clients.has(serverName)) {
        try {
          await connectIfNeeded(serverName, activeCtx!.logger);
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Failed to connect to MCP server "${serverName}": ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
      const client = clients.get(serverName)!;
      try {
        const result = await client.callTool(toolName, (input ?? {}) as Record<string, unknown>);
        return toToolResult(result);
      } catch (callErr) {
        // For httpStream: only drop the cached client when the session/transport
        // is actually dead. Tool-level failures keep the connection so the next
        // call reuses the existing MCP session instead of re-initializing it.
        const cfg = configs.get(serverName);
        if (cfg && isHttpConfig(cfg) && clients.has(serverName) && isSessionDeadError(callErr)) {
          clients.delete(serverName);
          serverTools.delete(serverName);
          serverStatus.set(serverName, 'pending');
        }
        return {
          content: [{ type: 'text', text: `Tool call failed: ${callErr instanceof Error ? callErr.message : String(callErr)}` }],
          isError: true,
        };
      }
    },
  };
}

/**
 * Reconcile the registered `mcp__<server>__<tool>` tools against a fresh tool
 * list using a diff: dispose only tools that disappeared, register only new
 * ones, and leave unchanged tools registered untouched.
 *
 * This intentionally avoids the previous unregister-all-then-readd approach.
 * That approach briefly removed every tool from the host registry on each
 * `tools/list_changed` refresh; a refresh arriving right after ToolSearch had
 * injected the tools into an active run would push an empty/partial tool set to
 * pi and clobber the just-injected schema, making the model see "Tool not found".
 */
function registerServerTools(serverName: string, tools: McpTool[]): void {
  if (!activeCtx) return;

  const seg = sanitizeSegment(serverName);
  const existing = registeredTools.get(serverName) ?? new Map<string, finch.Disposable>();
  const desired = new Map<string, McpTool>();
  for (const tool of tools) {
    desired.set(`mcp__${seg}__${sanitizeSegment(tool.name)}`, tool);
  }

  // Dispose tools that no longer exist on the server.
  for (const [modelName, disposable] of existing) {
    if (!desired.has(modelName)) {
      disposable.dispose();
      existing.delete(modelName);
    }
  }

  // Register tools that are new since the last reconcile.
  for (const [modelName, tool] of desired) {
    if (existing.has(modelName)) continue;
    existing.set(modelName, activeCtx.tools.register(buildServerToolRegistration(serverName, tool.name, tool)));
  }

  if (existing.size > 0) registeredTools.set(serverName, existing);
  else registeredTools.delete(serverName);
}

/**
 * Disconnect a server: cancel timers, close client, unregister tools, clear caches.
 * Safe to call even if the server is not currently connected or connecting.
 */
function disconnectServer(name: string): void {
  const timer = reconnectTimers.get(name);
  if (timer) { clearTimeout(timer); reconnectTimers.delete(name); }
  const client = clients.get(name);
  if (client) {
    client.onclose = undefined; // prevent auto-reconnect on deliberate close
    try { client.close(); } catch { /* ignore */ }
    clients.delete(name);
  }
  connecting.delete(name);
  serverTools.delete(name);
  serverLastError.delete(name);
  unregisterServerTools(name);
  serverStatus.delete(name);
}

/**
 * Soft-apply an add/upsert: update in-memory config and eagerly start connecting.
 * Called by MCP action=add/edit after writing servers.json,
 * so the new server is available immediately without a host-process restart.
 */
function applyServerUpsert(
  oldName: string | null,
  server: ManagedMcpServerConfig,
  logger: finch.Logger,
): void {
  // If renaming, tear down the old connection first.
  if (oldName && oldName !== server.name) {
    disconnectServer(oldName);
    configs.delete(oldName);
  } else if (oldName) {
    // Same name but config changed — reconnect.
    disconnectServer(oldName);
  }
  configs.set(server.name, server);
  serverStatus.set(server.name, 'pending');
  serverLastError.delete(server.name);
  void connectIfNeeded(server.name, logger);
}

/**
 * Soft-apply a removal: tear down the connection and remove from config map.
 * Called by MCP action=remove after writing servers.json.
 */
function applyServerRemove(name: string): void {
  disconnectServer(name);
  configs.delete(name);
}

/** Split a whitespace/newline-separated argument string into an args array. */
function parseArgs(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Fixed env key that holds the httpStream auth secret. Headers reference it via
 * the `${MCP_AUTH_TOKEN}` placeholder, expanded at connect time (see client.ts
 * `expandHeaders`). Keeping the key fixed means the model never has to invent
 * env names or hand-write an `Authorization` header — the secret flows only
 * through the secure form into `env`, never through the chat / ToolResult.
 */
const AUTH_TOKEN_ENV = 'MCP_AUTH_TOKEN';

/**
 * Inspect an existing httpStream config and report its auth header (the one
 * referencing `${MCP_AUTH_TOKEN}`) and whether a token is already stored. Used
 * to prefill the edit form. Defaults to the standard `Authorization` header.
 */
function describeHttpAuth(config: McpHttpStreamServerConfig): { headerName: string; hasToken: boolean } {
  const hasToken = Boolean(config.env?.[AUTH_TOKEN_ENV]);
  const entry = Object.entries(config.headers ?? {}).find(([, value]) => value.includes(`\${${AUTH_TOKEN_ENV}}`));
  return { headerName: entry?.[0] ?? 'Authorization', hasToken };
}

/**
 * Build the `{ headers, env }` pair for an httpStream server from a single token
 * plus an optional header name. The secret is stored in `env[AUTH_TOKEN_ENV]`
 * and the header carries the `${MCP_AUTH_TOKEN}` placeholder, expanded at connect
 * time. For the standard `Authorization` header we emit the canonical
 * `Bearer <token>` scheme; any other header carries the raw token value.
 * When `token` is blank an existing stored token is preserved (edit case).
 */
function buildHttpAuth(
  headerName: string,
  token: string,
  existingToken: string | undefined,
): { headers?: Record<string, string>; env?: Record<string, string> } {
  const secret = token || existingToken || '';
  if (!secret) return {};
  const name = (headerName || 'Authorization').trim() || 'Authorization';
  const value = name.toLowerCase() === 'authorization' ? `Bearer \${${AUTH_TOKEN_ENV}}` : `\${${AUTH_TOKEN_ENV}}`;
  return { headers: { [name]: value }, env: { [AUTH_TOKEN_ENV]: secret } };
}

/** Read all user-defined servers from servers.json (unfiltered). */
function readUserServers(storagePath: string): ManagedMcpServerConfig[] {
  const file = join(storagePath, 'servers.json');
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ServersFile;
    return (parsed.servers ?? []).filter((s): s is ManagedMcpServerConfig => Boolean(s && typeof s.name === 'string'));
  } catch {
    return [];
  }
}

/** Read servers.json and upsert one server by name, then write it back. */
function upsertServer(storagePath: string, server: ManagedMcpServerConfig): void {
  const servers = readUserServers(storagePath).filter((s) => s.name !== server.name);
  servers.push(server);
  mkdirSync(storagePath, { recursive: true });
  writeFileSync(join(storagePath, 'servers.json'), JSON.stringify({ servers }, null, 2), 'utf-8');
}

/** Remove a user-defined server by name. Returns true when a server was removed. */
function removeServer(storagePath: string, name: string): boolean {
  const servers = readUserServers(storagePath);
  const next = servers.filter((s) => s.name !== name);
  if (next.length === servers.length) return false;
  mkdirSync(storagePath, { recursive: true });
  writeFileSync(join(storagePath, 'servers.json'), JSON.stringify({ servers: next }, null, 2), 'utf-8');
  return true;
}

function isServerConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== 'object' || typeof (value as { name?: unknown }).name !== 'string') return false;
  if (typeof (value as { url?: unknown }).url === 'string') return (value as { url: string }).url.length > 0;
  return typeof (value as { command?: unknown }).command === 'string' && (value as { command: string }).command.length > 0;
}

function readServersFile(file: string, logger: finch.Logger): ManagedMcpServerConfig[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ServersFile;
    return (parsed.servers ?? []).filter(isServerConfig);
  } catch (err) {
    logger.error(`failed to read ${file}`, err);
    return [];
  }
}

function readContributedServers(ctx: finch.ExtensionContext): ManagedMcpServerConfig[] {
  return ctx.extensions.listContributions<unknown>('mcpServers').flatMap((contribution) => {
    const values = Array.isArray(contribution.value) ? contribution.value : [];
    return values.filter(isServerConfig).map((server) => ({
      ...server,
      toolMeta: (server as ManagedMcpServerConfig).toolMeta,
      toolDisplay: (server as ManagedMcpServerConfig).toolDisplay,
      ownerExtensionId: contribution.extensionId,
      qualifiedName: `${contribution.extensionId}.${server.name}`,
    }));
  });
}

/**
 * Merge user file config and extension-contributed servers. On name collision later
 * sources win; user-defined names take priority over contributed ones. Server
 * runtime names and model-facing tool names are an MCP Bridge policy.
 */
function loadServerConfigs(ctx: finch.ExtensionContext): ManagedMcpServerConfig[] {
  const storagePath = ctx.storagePath;
  const fileServers = readServersFile(join(storagePath, 'servers.json'), ctx.logger);
  const contributed = readContributedServers(ctx);
  const byName = new Map<string, ManagedMcpServerConfig>();
  for (const s of contributed) byName.set(s.name, s);
  for (const s of fileServers) byName.set(s.name, s);
  return [...byName.values()];
}

function refreshServerConfigs(ctx: finch.ExtensionContext): void {
  const next = new Map(loadServerConfigs(ctx).map((config) => [config.name, config]));
  for (const name of [...configs.keys()]) {
    if (!next.has(name)) {
      disconnectServer(name);
      configs.delete(name);
    }
  }
  for (const [name, config] of next) {
    const prev = configs.get(name);
    if (!prev) {
      configs.set(name, config);
      serverStatus.set(name, 'pending');
      continue;
    }
    if (JSON.stringify(prev) !== JSON.stringify(config)) {
      disconnectServer(name);
      configs.set(name, config);
      serverStatus.set(name, 'pending');
    }
  }
}

/**
 * Schedule an automatic reconnect for a stdio MCP server using exponential backoff.
 * httpStream servers heal naturally since each callTool is an independent HTTP request.
 */
function scheduleReconnect(name: string, attempt: number, logger: finch.Logger): void {
  const config = configs.get(name);
  if (!config || isHttpConfig(config)) return; // httpStream heals naturally per-request, no reconnect needed

  if (attempt > MAX_RECONNECT_ATTEMPTS) {
    serverStatus.set(name, 'failed');
    serverLastError.set(name, `permanently failed after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
    logger.error(`MCP server "${name}" permanently failed after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
    return;
  }

  const delay = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
  serverStatus.set(name, 'reconnecting');
  logger.info(`MCP server "${name}": reconnect attempt ${attempt} in ${delay}ms`);

  const timer = setTimeout(() => {
    reconnectTimers.delete(name);
    connecting.delete(name); // clear any stale in-flight entry so connectIfNeeded can proceed
    void connectIfNeeded(name, logger, attempt).catch(() => {
      // connectIfNeeded failed to connect (e.g. process couldn't start).
      // Schedule the next attempt — onclose won't fire since no process started.
      scheduleReconnect(name, attempt + 1, logger);
    });
  }, delay);
  reconnectTimers.set(name, timer);
}

/**
 * Lazily connect to an MCP server by name. If a connection is already live,
 * returns immediately. If a connection is in progress, awaits the existing
 * promise (no duplicate spawn). On failure, removes the in-flight entry so
 * the next call can retry.
 *
 * @param reconnectAttempt Pass > 0 when called from scheduleReconnect so status shows 'reconnecting'.
 */
async function connectIfNeeded(name: string, logger: finch.Logger, reconnectAttempt = 0): Promise<void> {
  if (clients.has(name)) return;

  const existing = connecting.get(name);
  if (existing) return existing;

  const config = configs.get(name);
  if (!config) throw new Error(`Unknown MCP server: "${name}"`);

  serverStatus.set(name, reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

  const promise = (async () => {
    const client = createMcpClient(config);
    try {
      await withTimeout(client.connect(CONNECT_TIMEOUT_MS), CONNECT_TIMEOUT_MS + 1_000, `MCP server "${name}" connect`);
      const tools = await withTimeout(client.listTools(LIST_TOOLS_TIMEOUT_MS), LIST_TOOLS_TIMEOUT_MS + 1_000, `MCP server "${name}" listTools`);

      // Register notification handler for dynamic tool list updates (stdio only).
      if (client.capabilities.tools?.listChanged) {
        client.onNotification('notifications/tools/list_changed', () => {
          void client.listTools().then((newTools) => {
            serverTools.set(name, newTools);
            registerServerTools(name, newTools); // re-register with updated tool list
            logger.info(`MCP server "${name}" tools refreshed: ${newTools.length} tools`);
          }).catch((err) => {
            logger.error(`MCP server "${name}": failed to refresh tools after list_changed`, err);
          });
        });
      }

      // For stdio: detect unexpected disconnects, clean up registered tools, then auto-reconnect.
      // httpStream has no persistent connection so onclose never fires.
      client.onclose = () => {
        unregisterServerTools(name); // remove mcp__server__* tools while disconnected
        clients.delete(name);
        serverTools.delete(name);
        logger.warn(`MCP server "${name}" disconnected unexpectedly`);
        scheduleReconnect(name, 1, logger);
      };

      clients.set(name, client);
      serverTools.set(name, tools);
      serverStatus.set(name, 'connected');
      serverLastError.delete(name);
      registerServerTools(name, tools); // register mcp__<server>__<tool> tools
      logger.info(`MCP server "${name}" connected with ${tools.length} tools`);
    } catch (err) {
      client.close();
      const message = err instanceof Error ? err.message : String(err);
      serverStatus.set(name, 'failed');
      serverLastError.set(name, message);
      logger.error(`MCP server "${name}" failed to connect: ${message}`);
      connecting.delete(name);
      throw err;
    }
    connecting.delete(name);
  })();

  connecting.set(name, promise);
  return promise;
}

/** Convert an MCP tool result into a Finch ToolResult. */
function toToolResult(result: McpToolResult): finch.ToolResult {
  const content: finch.ToolContent[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && block.data && block.mimeType) {
      content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '(no content)' });
  return { content, isError: result.isError };
}

export async function activate(ctx: finch.ExtensionContext): Promise<void> {
  activeCtx = ctx;

  // User-facing form strings are localized via ctx.i18n; the dictionary lives in
  // extensions/mcp/i18n/<locale>.json. Tool-result text stays English on purpose —
  // it is model-facing guidance, not user UI.
  const t = (key: string, values?: Record<string, string | number | boolean>): string => ctx.i18n.t(key, values);

  // Load server configs and register them.
  // Connections are established lazily the first time a server is actually used
  // (ToolSearch or the mcp.client capability). Individual mcp__server__tool tools
  // are registered dynamically after each server connects.
  refreshServerConfigs(ctx);

  // Eagerly connect httpStream servers in the background so their tools are
  // registered and injected into active sessions without the model first having
  // to call ToolSearch. httpStream has no child process (no zombie risk) and a
  // single cheap handshake, so prewarming is safe. stdio servers stay lazy —
  // eagerly spawning every stdio process at startup risks orphaned processes.
  for (const [name, config] of configs) {
    if (isHttpConfig(config)) {
      void connectIfNeeded(name, ctx.logger).catch(() => {
        // Status map + extension logs retain the user-visible error; lazy retry on use.
      });
    }
  }

  // Clean up all live connections on deactivate.
  ctx.subscriptions.push({
    dispose: () => {
      activeCtx = null;
      // Cancel all pending reconnect timers first to prevent new connections.
      for (const timer of reconnectTimers.values()) clearTimeout(timer);
      reconnectTimers.clear();
      // Dispose all dynamically registered mcp__server__tool tools.
      for (const byTool of registeredTools.values()) {
        for (const d of byTool.values()) d.dispose();
      }
      registeredTools.clear();
      for (const client of clients.values()) client.close();
      clients.clear();
      serverTools.clear();
      configs.clear();
      connecting.clear();
      serverStatus.clear();
      serverLastError.clear();
    },
  });

  async function listMcpServers(): Promise<finch.ToolResult> {
    refreshServerConfigs(ctx);
    const servers = [...configs.keys()].map((name) => ({
      name,
      status: serverStatus.get(name) ?? 'pending',
      toolCount: serverTools.get(name)?.length ?? 0,
      connected: clients.has(name),
      error: serverLastError.get(name),
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ servers }, null, 2) }] };
  }

  async function addMcpServer(input: Record<string, unknown>, exec: finch.ToolExecutionContext): Promise<finch.ToolResult> {
    const args = input as {
      name?: string;
      command?: string;
      args?: string;
      url?: string;
      authHeader?: string;
      secretEnvKeys?: string[];
      plainEnvKeys?: string[];
    };
    // Infer transport from provided fields: url → httpStream, command → stdio
    const isHttp = typeof args.url === 'string' && args.url.length > 0;
    const secretKeys = (args.secretEnvKeys ?? []).filter((k) => typeof k === 'string' && k.length > 0);
    const plainKeys = (args.plainEnvKeys ?? []).filter((k) => typeof k === 'string' && k.length > 0);

    // httpStream auth: optional custom header name (rare); defaults to the
    // standard Authorization: Bearer scheme. Provided by the model only when a
    // server needs a non-standard header (e.g. X-Api-Key).
    const httpHeaderName = (args.authHeader ?? '').trim() || 'Authorization';
    const isBearer = httpHeaderName.toLowerCase() === 'authorization';

    const fields: finch.ExtensionFormField[] = [];
    if (isHttp) {
      // HTTP: name (1/3) + URL (2/3) on one row; token below full-width.
      fields.push(
        { key: 'name', label: t('field.name'), type: 'text', required: true, default: args.name ?? '', width: '1/3' },
        { key: 'url', label: t('field.url'), type: 'text', required: true, placeholder: 'https://…', default: args.url ?? '', width: '2/3' },
        {
          key: 'authToken',
          label: isBearer ? t('field.token.bearer') : t('field.token.customValue', { header: httpHeaderName }),
          type: 'password',
          secret: true,
          description: isBearer
            ? t('field.token.desc.bearerAdd')
            : t('field.token.desc.customAdd', { header: httpHeaderName }),
        },
      );
    } else {
      // stdio: name (1/2) + command (1/2) on one row; args textarea below.
      fields.push(
        { key: 'name', label: t('field.name'), type: 'text', required: true, default: args.name ?? '', width: '1/2' },
        { key: 'command', label: t('field.command'), type: 'text', required: true, placeholder: 'npx', default: args.command ?? '', width: '1/2' },
        { key: 'args', label: t('field.args'), type: 'textarea', placeholder: '-y @modelcontextprotocol/server-filesystem /path', default: args.args ?? '' },
      );
      // env-key fields: plain keys (1/2 each, paired) then secret keys (full, sensitive).
      for (let i = 0; i < plainKeys.length; i++) {
        const key = plainKeys[i];
        fields.push({ key: `env:${key}`, label: key, type: 'text', width: plainKeys.length > 1 ? '1/2' : 'full' });
      }
      for (const key of secretKeys) {
        fields.push({ key: `env:${key}`, label: key, type: 'password', secret: true });
      }
    }

    const result = await exec.ui.requestForm({
      title: t('form.add.title'),
      description: t('form.add.description', { name: args.name ?? t('form.defaultName') }),
      submitLabel: t('form.add.submit'),
      fields,
    });

    if (!result.submitted) {
      return { content: [{ type: 'text', text: 'User cancelled MCP server setup. No server was added.' }] };
    }

    const v = result.values;
    const name = String(v.name ?? args.name ?? '').trim();
    if (!name) {
      return { content: [{ type: 'text', text: 'No server name provided; nothing was saved.' }], isError: true };
    }

    let server: McpServerConfig;
    let summary: string;
    if (isHttp) {
      const url = String(v.url ?? '').trim();
      if (!url) return { content: [{ type: 'text', text: 'No URL provided; nothing was saved.' }], isError: true };
      const auth = buildHttpAuth(httpHeaderName, String(v.authToken ?? ''), undefined);
      server = {
        name,
        url,
        ...(auth.headers ? { headers: auth.headers } : {}),
        ...(auth.env ? { env: auth.env } : {}),
      };
      summary = `httpStream → ${url}${auth.headers ? ' (authenticated)' : ''}`;
    } else {
      // env-key fields apply to stdio servers only.
      const env: Record<string, string> = {};
      for (const key of [...plainKeys, ...secretKeys]) {
        const value = v[`env:${key}`];
        if (value !== undefined && value !== null && String(value).length > 0) env[key] = String(value);
      }
      const command = String(v.command ?? '').trim();
      if (!command) return { content: [{ type: 'text', text: 'No command provided; nothing was saved.' }], isError: true };
      const argList = parseArgs(String(v.args ?? ''));
      server = { name, command, ...(argList.length ? { args: argList } : {}), ...(Object.keys(env).length ? { env } : {}) };
      summary = `stdio → ${command}${argList.length ? ' ' + argList.join(' ') : ''}`;
    }

    try {
      upsertServer(ctx.storagePath, server);
    } catch (err) {
      ctx.logger.error('failed to write servers.json', err);
      return { content: [{ type: 'text', text: `Failed to save server config: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }

    const secretNote = !isHttp && secretKeys.length ? ` Secret values for ${secretKeys.join(', ')} were stored locally and not shared.` : '';
    ctx.logger.info(`saved MCP server "${name}" (${summary}); connecting in background`);
    applyServerUpsert(null, server, ctx.logger);
    return {
      content: [{
        type: 'text',
        text: `The user already submitted the setup form for MCP server "${name}" (${summary}). Now connecting in background — its tools will appear shortly.${secretNote}`,
      }],
    };
  }

  async function editMcpServer(input: Record<string, unknown>, exec: finch.ToolExecutionContext): Promise<finch.ToolResult> {
    const args = input as {
      name?: string;
      newName?: string;
      command?: string;
      args?: string;
      url?: string;
      authHeader?: string;
      secretEnvKeys?: string[];
      plainEnvKeys?: string[];
    };
    const name = String(args.name ?? '').trim();
    if (!name) return { content: [{ type: 'text', text: 'No server name provided.' }], isError: true };
    // Rename target, if the model was told to rename the server. Prefilled into
    // the form's "Server name" field so the form doesn't just default back to
    // the current name on a rename request.
    const requestedNewName = String(args.newName ?? '').trim();

    const existing = readUserServers(ctx.storagePath).find((s) => s.name === name);
    if (!existing) {
      return {
        content: [{ type: 'text', text: `No user-configured MCP server named "${name}". Use MCP action=list to see editable servers (extension-injected servers cannot be edited).` }],
        isError: true,
      };
    }

    const existingIsHttp = isHttpConfig(existing);
    // Transport can change if AI provides url (→ http) or command (→ stdio); otherwise keep existing
    const isHttp = typeof args.url === 'string' && args.url.length > 0
      ? true
      : typeof args.command === 'string' && args.command.length > 0
        ? false
        : existingIsHttp;
    const existingEnv = existing.env ?? {};
    const secretKeys = (args.secretEnvKeys ?? []).filter((k) => typeof k === 'string' && k.length > 0);
    const plainKeys = (args.plainEnvKeys ?? []).filter((k) => typeof k === 'string' && k.length > 0);
    const existingAuth = existingIsHttp ? describeHttpAuth(existing as McpHttpStreamServerConfig) : { headerName: 'Authorization', hasToken: false };
    // Keep the prior header unless the model explicitly overrides it.
    const httpHeaderName = (args.authHeader ?? '').trim() || existingAuth.headerName || 'Authorization';
    const isBearer = httpHeaderName.toLowerCase() === 'authorization';

    const existingCmd = !existingIsHttp ? (existing as { command: string }).command : '';
    const existingArgs = !existingIsHttp ? ((existing as { args?: string[] }).args ?? []).join(' ') : '';

    const fields: finch.ExtensionFormField[] = [];
    if (isHttp) {
      // HTTP: name (1/3) + URL (2/3) on one row; token below full-width.
      fields.push(
        { key: 'name', label: t('field.name'), type: 'text', required: true, default: requestedNewName || name, width: '1/3' },
        { key: 'url', label: t('field.url'), type: 'text', required: true, placeholder: 'https://…', default: args.url ?? (existingIsHttp ? (existing as { url: string }).url : ''), width: '2/3' },
        {
          key: 'authToken',
          label: isBearer ? t('field.token.bearer') : t('field.token.customValue', { header: httpHeaderName }),
          type: 'password',
          secret: true,
          description: existingAuth.hasToken
            ? t('field.token.desc.keep')
            : isBearer
              ? t('field.token.desc.bearerEdit')
              : t('field.token.desc.customEdit', { header: httpHeaderName }),
        },
      );
    } else {
      // stdio: name (1/2) + command (1/2) on one row; args textarea below.
      fields.push(
        { key: 'name', label: t('field.name'), type: 'text', required: true, default: requestedNewName || name, width: '1/2' },
        { key: 'command', label: t('field.command'), type: 'text', required: true, placeholder: 'npx', default: args.command ?? existingCmd, width: '1/2' },
        { key: 'args', label: t('field.args'), type: 'textarea', placeholder: '-y @modelcontextprotocol/server-filesystem /path', default: args.args ?? existingArgs },
      );
      // env-key fields: plain keys (1/2 each, paired) then secret keys (full, sensitive).
      const envKeys = new Set<string>([...Object.keys(existingEnv), ...plainKeys, ...secretKeys]);
      const plainEnvKeys = [...envKeys].filter((k) => !secretKeys.includes(k));
      const secretEnvKeys = [...envKeys].filter((k) => secretKeys.includes(k));
      for (const key of plainEnvKeys) {
        fields.push({
          key: `env:${key}`,
          label: key,
          type: 'text',
          default: existingEnv[key] ?? '',
          width: plainEnvKeys.length > 1 ? '1/2' : 'full',
        });
      }
      for (const key of secretEnvKeys) {
        fields.push({
          key: `env:${key}`,
          label: key,
          type: 'password',
          secret: true,
          default: '',
        });
      }
    }

    const result = await exec.ui.requestForm({
      title: t('form.edit.title', { name }),
      description: t('form.edit.description'),
      submitLabel: t('form.edit.submit'),
      fields,
    });
    if (!result.submitted) {
      return { content: [{ type: 'text', text: 'User cancelled the edit. No changes were saved.' }] };
    }

    const v = result.values;
    const nextName = String(v.name ?? name).trim() || name;

    let server: McpServerConfig;
    let summary: string;
    if (isHttp) {
      const url = String(v.url ?? '').trim();
      if (!url) return { content: [{ type: 'text', text: 'No URL provided; nothing was saved.' }], isError: true };
      const auth = buildHttpAuth(httpHeaderName, String(v.authToken ?? ''), existingEnv[AUTH_TOKEN_ENV]);
      server = {
        name: nextName,
        url,
        ...(auth.headers ? { headers: auth.headers } : {}),
        ...(auth.env ? { env: auth.env } : {}),
      };
      summary = `httpStream → ${url}${auth.headers ? ' (authenticated)' : ''}`;
    } else {
      // Rebuild stdio env from the rendered env fields, preserving prior values
      // when the user leaves a field blank.
      const env: Record<string, string> = {};
      const envKeys = new Set<string>([...Object.keys(existingEnv), ...plainKeys, ...secretKeys]);
      for (const key of envKeys) {
        const value = v[`env:${key}`];
        if (value !== undefined && value !== null && String(value).length > 0) {
          env[key] = String(value);
        } else if (existingEnv[key] !== undefined) {
          // Keep the previous value (including secrets) when left blank.
          env[key] = existingEnv[key];
        }
      }
      const command = String(v.command ?? '').trim();
      if (!command) return { content: [{ type: 'text', text: 'No command provided; nothing was saved.' }], isError: true };
      const argList = parseArgs(String(v.args ?? ''));
      server = { name: nextName, command, ...(argList.length ? { args: argList } : {}), ...(Object.keys(env).length ? { env } : {}) };
      summary = `stdio → ${command}${argList.length ? ' ' + argList.join(' ') : ''}`;
    }

    try {
      if (nextName !== name) removeServer(ctx.storagePath, name);
      upsertServer(ctx.storagePath, server);
    } catch (err) {
      ctx.logger.error('failed to write servers.json', err);
      return { content: [{ type: 'text', text: `Failed to save server config: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }

    ctx.logger.info(`updated MCP server "${nextName}" (${summary}); reconnecting in background`);
    applyServerUpsert(name, server, ctx.logger);
    return {
      content: [{
        type: 'text',
        text: `The user already submitted the edit form for MCP server "${nextName}" (${summary}). Now reconnecting in background.`,
      }],
    };
  }

  async function removeMcpServer(input: Record<string, unknown>): Promise<finch.ToolResult> {
    const name = String(input.name ?? '').trim();
    if (!name) return { content: [{ type: 'text', text: 'No server name provided.' }], isError: true };

    let removed = false;
    try {
      removed = removeServer(ctx.storagePath, name);
    } catch (err) {
      ctx.logger.error('failed to write servers.json', err);
      return { content: [{ type: 'text', text: `Failed to update server config: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }

    if (!removed) {
      return {
        content: [{ type: 'text', text: `No user-configured MCP server named "${name}" was found. Extension-injected servers cannot be removed here.` }],
        isError: true,
      };
    }

    ctx.logger.info(`removed MCP server "${name}"; disconnecting`);
    applyServerRemove(name);
    return {
      content: [{ type: 'text', text: `Removed MCP server "${name}" and disconnected.` }],
    };
  }

  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'MCP',
      title: 'MCP',
      callDisplay: {
        inline: {
          mode: 'join',
          fields: [
            { path: 'action' },
            { path: 'name', format: 'quoted', maxLength: 24 },
          ],
          separator: ' ',
        },
      },
      description:
        'Manage Model Context Protocol (MCP) server connections with action=list/add/edit/remove. ' +
        'Use action=list to inspect configured services before ToolSearch or before edit/remove. ' +
        'Use action=add when the user wants to connect a new MCP server. For an HTTP (url) server just pass name+url — the secure form shows ONE "API token" field that auto-creates a standard "Authorization: Bearer <token>" header; you never pass, see, or hand-edit the token or any header. Only set authHeader if the server needs a NON-standard header (e.g. "X-Api-Key"). ' +
        'For stdio (command) servers, pass secretEnvKeys/plainEnvKeys for the env vars the user should fill. Never ask the user to paste secrets in chat. ' +
        'Use action=edit/remove only for user-configured servers in the local servers.json; extension-injected servers cannot be edited or removed. ' +
        'To rename a server, call action=edit with name=<current name> and newName=<desired name> — this prefills the confirmation form with the new name so the user just has to hit save. ' +
        'TIMING: action=add/edit open a secure form and this tool call BLOCKS until the user submits or cancels it. By the time you receive the tool result, the user has ALREADY filled in and submitted the form (including any token) — never tell the user "you should see a form" or "please fill in the token" after this returns; describe the outcome in past tense using the returned status instead. ' +
        'To use actual MCP server tools, call Finch ToolSearch with source:"mcp" first, then call the injected mcp__<server>__<tool> function.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add', 'edit', 'remove'],
            description: 'MCP management action to perform.',
          },
          name: { type: 'string', description: 'Server name. Required for add/edit/remove; for edit/remove use the exact name from action=list.' },
          newName: { type: 'string', description: 'action=edit only. New name to rename the server to. Prefills the "Server name" field in the confirmation form; the server keeps its current name if omitted.' },
          command: { type: 'string', description: 'For stdio servers: executable, e.g. "npx". Presence implies stdio transport for add/edit.' },
          args: { type: 'string', description: 'For stdio: whitespace-separated arguments, e.g. "-y @modelcontextprotocol/server-filesystem /path".' },
          url: { type: 'string', description: 'For HTTP servers: the MCP endpoint URL. Presence implies httpStream transport for add/edit.' },
          authHeader: {
            type: 'string',
            description: 'HTTP servers only. Optional. Omit for the normal case — the form collects a token and sends "Authorization: Bearer <token>". Set this ONLY for a non-standard auth header name, e.g. "X-Api-Key", and the token is then sent as that header\'s raw value.',
          },
          secretEnvKeys: {
            type: 'array',
            items: { type: 'string' },
            description: 'stdio servers only. Names of env vars holding secrets the user must enter securely, e.g. ["API_KEY"]. Values are never shown to the model. (HTTP auth uses authHeader instead.)',
          },
          plainEnvKeys: {
            type: 'array',
            items: { type: 'string' },
            description: 'stdio servers only. Names of non-sensitive env vars the user should fill, e.g. ["BASE_URL"].',
          },
        },
        required: ['action'],
      },
      risk: 'high',
      async execute(input, exec): Promise<finch.ToolResult> {
        const action = String((input as { action?: string }).action ?? '').trim();
        const payload = (input ?? {}) as Record<string, unknown>;
        if (action === 'list') return listMcpServers();
        if (action === 'add') return addMcpServer(payload, exec);
        if (action === 'edit') return editMcpServer(payload, exec);
        if (action === 'remove') return removeMcpServer(payload);
        return {
          content: [{ type: 'text', text: 'Unknown MCP action. Use one of: list, add, edit, remove.' }],
          isError: true,
        };
      },
    }),
  );

  ctx.subscriptions.push(
    ctx.tools.registerSearchProvider({
      id: 'mcp',
      description: 'Discover MCP server tools and activate matching mcp__server__tool functions.',
      async search(input): Promise<finch.ToolSearchResult[]> {
        refreshServerConfigs(ctx);
        const query = String(input.query ?? '').trim().toLowerCase();
        const queryTerms = query.split(/\s+/).filter(Boolean);
        // limit applies across servers to prevent flooding, but a server whose
        // name is directly matched returns ALL its tools so the caller gets the
        // complete capability set, not an arbitrary first-N slice.
        const limit = Math.max(1, Math.min(Number(input.limit ?? 10) || 10, 200));
        const results: finch.ToolSearchResult[] = [];
        for (const server of configs.keys()) {
          if (results.length >= limit) break;
          // Server matches if the query is empty OR any individual query term
          // appears in the server name. Using the full query string would fail
          // for multi-word queries like "filesystem MCP tools read write".
          const serverMatches = queryTerms.length === 0 || queryTerms.some((term) => server.toLowerCase().includes(term));
          try {
            await connectIfNeeded(server, ctx.logger);
          } catch (err) {
            ctx.logger.warn(`ToolSearch failed to connect MCP server "${server}":`, err);
            continue;
          }
          const seg = sanitizeSegment(server);
          for (const tool of serverTools.get(server) ?? []) {
            // When the server itself matched by name, return ALL its tools so the
            // caller activates the full capability set. Only apply the cross-server
            // limit when filtering by individual tool content (serverMatches=false).
            if (!serverMatches && results.length >= limit) break;
            const haystack = `${server} ${tool.name} ${tool.description ?? ''}`.toLowerCase();
            // Include the tool if the server name matched (broad match) OR if
            // at least one query term appears anywhere in the tool's haystack.
            if (!serverMatches && queryTerms.length > 0 && !queryTerms.some((term) => haystack.includes(term))) continue;
            const toolName = `mcp__${seg}__${sanitizeSegment(tool.name)}`;
            const title = buildMcpToolTitle(server, tool.name);
            const callDisplay = buildMcpToolCallDisplay(server, tool.name);
            results.push({
              toolName,
              title: title ?? tool.name,
              description: tool.description ?? `${tool.name} tool from MCP server "${server}"`,
              source: `mcp:${server}`,
            });
          }
        }
        return results;
      },
    }),
  );

  // Expose a capability so other extensions can drive MCP servers directly.
  ctx.subscriptions.push(
    ctx.capabilities.provide('mcp.client', {
      async listServers(): Promise<string[]> {
        refreshServerConfigs(ctx);
        return [...configs.keys()];
      },
      /** Returns rich status info for all configured servers and starts pending connections in the background. */
      async getServerStatuses(): Promise<Array<{ name: string; status: string; toolCount: number; ownerExtensionId?: string; qualifiedName?: string }>> {
        refreshServerConfigs(ctx);
        return [...configs.entries()].map(([name, config]) => {
          const status = serverStatus.get(name) ?? 'pending';
          if (status === 'pending' || status === 'failed') {
            void connectIfNeeded(name, ctx.logger).catch(() => {
              // The status map and extension logs keep the user-visible error.
            });
          }
          return {
            name,
            status,
            toolCount: serverTools.get(name)?.length ?? 0,
            ownerExtensionId: config.ownerExtensionId,
            qualifiedName: config.qualifiedName,
          };
        });
      },
      async listTools(server: string): Promise<Array<McpTool & { title?: string }>> {
        refreshServerConfigs(ctx);
        await connectIfNeeded(server, ctx.logger);
        return (serverTools.get(server) ?? []).map((tool) => ({
          ...tool,
          title: buildMcpToolTitle(server, tool.name),
        }));
      },
      async callTool(server: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
        refreshServerConfigs(ctx);
        await connectIfNeeded(server, ctx.logger);
        const client = clients.get(server)!;
        return client.callTool(name, args ?? {});
      },
    }),
  );
}

export function deactivate(): void {
  activeCtx = null;
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();
  for (const byTool of registeredTools.values()) {
    for (const d of byTool.values()) d.dispose();
  }
  registeredTools.clear();
  for (const client of clients.values()) client.close();
  clients.clear();
  serverTools.clear();
  configs.clear();
  connecting.clear();
  serverStatus.clear();
}
