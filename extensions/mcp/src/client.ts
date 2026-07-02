/**
 * MCP (Model Context Protocol) clients backed by the official TypeScript SDK.
 *
 * Finch keeps a small wrapper interface so the bridge extension can own server
 * status, dynamic tool registration, retries, and user-facing errors while the
 * SDK owns transports, framing, JSON-RPC, and process lifecycle details.
 */
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

export type McpServerConfig = McpStdioServerConfig | McpHttpStreamServerConfig;

export interface McpStdioServerConfig {
  /** Unique server name (used to namespace its tools). */
  name: string;
  /** Executable to launch, e.g. "npx" or an absolute path. */
  command: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Extra environment variables for the server process. */
  env?: Record<string, string>;
  /** Working directory for the server process. */
  cwd?: string;
}

export interface McpHttpStreamServerConfig {
  /** Unique server name (used to namespace its tools). */
  name: string;
  /** Streamable HTTP / SSE endpoint that accepts MCP JSON-RPC requests.
   *  Presence of this field (vs. `command`) is the discriminator for httpStream. */
  url: string;
  /** HTTP headers. Values may contain `${ENV_NAME}` placeholders. */
  headers?: Record<string, string>;
  /** Values used to expand header placeholders; merged with process.env. */
  env?: Record<string, string>;
}

/** Type guard: true when config describes an httpStream server (has `url`). */
export function isHttpConfig(config: McpServerConfig): config is McpHttpStreamServerConfig {
  return 'url' in config && typeof (config as McpHttpStreamServerConfig).url === 'string';
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** Capabilities advertised by the MCP server in its initialize response. */
export type McpCapabilities = ServerCapabilities;

export interface McpClient {
  readonly name: string;
  /** Server capabilities populated after a successful connect(). */
  readonly capabilities: McpCapabilities;
  /**
   * Called when the connection drops unexpectedly (process exit, network error).
   * NOT called when close() is invoked intentionally.
   */
  onclose?: () => void;
  connect(timeoutMs?: number): Promise<void>;
  listTools(timeoutMs?: number): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult>;
  /**
   * Register a handler for server-sent notifications.
   * `method` is the full notification method name, e.g. "notifications/tools/list_changed".
   */
  onNotification(method: string, handler: () => void): void;
  close(): void;
}

export function createMcpClient(config: McpServerConfig): McpClient {
  if (isHttpConfig(config)) return new SdkBackedMcpClient(config);
  return new SdkBackedMcpClient(config as McpStdioServerConfig);
}

class SdkBackedMcpClient implements McpClient {
  private readonly notificationHandlers = new Map<string, (() => void)[]>();
  private sdkClient?: SdkClient;
  private transport?: Transport;
  private closing = false;
  private connected = false;
  private _capabilities: McpCapabilities = {};

  /** Called when the connection drops unexpectedly (not via close()). */
  onclose?: () => void;

  constructor(private readonly config: McpServerConfig) {}

  get name(): string {
    return this.config.name;
  }

  get capabilities(): McpCapabilities {
    return this._capabilities;
  }

  onNotification(method: string, handler: () => void): void {
    const existing = this.notificationHandlers.get(method);
    if (existing) existing.push(handler);
    else this.notificationHandlers.set(method, [handler]);
  }

  async connect(timeoutMs = 15_000): Promise<void> {
    if (this.connected) return;

    this.closing = false;
    const client = new SdkClient(
      { name: 'finch', version: '1.0.0' },
      { capabilities: {} },
    );
    client.fallbackNotificationHandler = async (notification) => {
      const handlers = this.notificationHandlers.get(notification.method);
      if (!handlers) return;
      for (const handler of handlers) handler();
    };
    const transport = this.createTransport();

    client.onerror = (error) => {
      // Surface transport/protocol failures as connection drops after a
      // successful connection. During connect(), the thrown promise rejection is
      // handled by the caller so we avoid double-notifying here.
      if (this.connected && !this.closing) {
        this.connected = false;
        this.onclose?.();
      }
      // Keep the SDK error observable for dev logs without crashing ExtensionHost.
      void error;
    };
    client.onclose = () => {
      const wasUnexpected = this.connected && !this.closing;
      this.connected = false;
      this.sdkClient = undefined;
      this.transport = undefined;
      if (wasUnexpected) this.onclose?.();
    };

    try {
      await client.connect(transport, { timeout: timeoutMs, maxTotalTimeout: timeoutMs });
      this.sdkClient = client;
      this.transport = transport;
      this._capabilities = client.getServerCapabilities() ?? {};
      this.connected = true;
    } catch (err) {
      this.closing = true;
      await this.safeClose(client, transport);
      this.sdkClient = undefined;
      this.transport = undefined;
      this.connected = false;
      throw err;
    } finally {
      this.closing = false;
    }
  }

  async listTools(timeoutMs = 15_000): Promise<McpTool[]> {
    const client = this.requireClient();
    const result = await client.listTools(undefined, { timeout: timeoutMs, maxTotalTimeout: timeoutMs });
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<McpToolResult> {
    const client = this.requireClient();
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutMs, maxTotalTimeout: timeoutMs },
    );
    if ('toolResult' in result) {
      return {
        content: [{ type: 'text', text: JSON.stringify(result.toolResult) }],
      };
    }
    return {
      content: result.content as McpToolResult['content'],
      isError: result.isError,
      structuredContent: result.structuredContent,
    };
  }

  /** Terminate the SDK client / transport. Fire-and-forget because Finch disposables are sync. */
  close(): void {
    this.closing = true;
    this.connected = false;
    const client = this.sdkClient;
    const transport = this.transport;
    this.sdkClient = undefined;
    this.transport = undefined;
    void this.safeClose(client, transport).finally(() => {
      this.closing = false;
    });
  }

  private createTransport(): Transport {
    if (isHttpConfig(this.config)) {
      return new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: {
          headers: expandHeaders(this.config.headers, this.config.env),
        },
      });
    }

    return new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env: { ...definedEnv(process.env), ...this.config.env },
      cwd: this.config.cwd,
      // Capture stderr instead of inheriting it into ExtensionHost stderr. The SDK
      // still keeps process lifecycle control and will SIGTERM/SIGKILL on close.
      stderr: 'pipe',
    });
  }

  private requireClient(): SdkClient {
    if (!this.sdkClient || !this.connected) {
      throw new Error(`MCP server "${this.config.name}" is not running`);
    }
    return this.sdkClient;
  }

  private async safeClose(client: SdkClient | undefined, transport: Transport | undefined): Promise<void> {
    try {
      if (client) await client.close();
      else if (transport) await transport.close();
    } catch {
      // Closing is best-effort; callers should not fail because cleanup failed.
    }
  }
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function expandHeaders(headers: Record<string, string> | undefined, env: Record<string, string> | undefined): Record<string, string> {
  const values = { ...definedEnv(process.env), ...env };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => values[name] ?? '');
  }
  return out;
}
