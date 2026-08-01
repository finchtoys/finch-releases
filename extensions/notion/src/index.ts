import type * as finch from 'finch';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'Notion';
const SERVER_URL = 'https://mcp.notion.com/mcp';
const PACK_ID = 'notion';
const ICON = (name: string) => `ext:${PACK_ID}/${name}`;

interface McpTool {
  name: string;
  description?: string;
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface McpClientCapability {
  registerServer(config: unknown): Promise<{ ok: boolean; error?: string }>;
  unregisterServer(name: string): Promise<{ ok: boolean }>;
  connectServer(name: string): Promise<{ ok: boolean }>;
  disconnectServerOAuth(name: string): Promise<{ ok: boolean }>;
  listTools(name: string): Promise<McpTool[]>;
  callTool(name: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

function readIconSvg(name: string): string {
  return readFileSync(new URL(`../icons/${name}.svg`, import.meta.url), 'utf-8');
}

function serverConfig(ctx: finch.ExtensionContext): Record<string, unknown> {
  return {
    name: SERVER_NAME,
    url: SERVER_URL,
    oauth: {
      id: 'notion-mcp',
      providerName: 'Notion MCP',
      clientName: 'Finch',
      clientUri: 'https://finchwork.app',
    },
    ownerExtensionId: ctx.extension.id,
    ownerExtensionName: ctx.extension.displayName,
  };
}

function text(value: string, isError = false): finch.ToolResult {
  return { content: [{ type: 'text', text: value }], isError };
}

let activeCtx: finch.ExtensionContext | undefined;

async function registerWhenReady(ctx: finch.ExtensionContext): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (ctx.capabilities.has('mcp.client')) {
      const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');
      const result = await mcp.registerServer(serverConfig(ctx));
      if (!result.ok) ctx.logger.warn(`Unable to register Notion MCP: ${result.error ?? 'unknown error'}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  ctx.logger.warn('MCP Client capability did not become available.');
}

export function activate(ctx: finch.ExtensionContext): void {
  activeCtx = ctx;
  // OAuth credentials are intentionally opaque to extensions. Until an explicit
  // connect/disconnect succeeds, keep the state unknown instead of probing MCP.
  let connectionState: 'unknown' | 'connecting' | 'connected' | 'disconnected' = 'unknown';
  let notifyAction: () => void = () => {};
  void registerWhenReady(ctx);

  ctx.subscriptions.push({
    dispose: () => {
      if (ctx.capabilities.has('mcp.client')) {
        void ctx.capabilities.get<McpClientCapability>('mcp.client').unregisterServer(SERVER_NAME).catch(() => undefined);
      }
    },
  });

  // ── Icon pack ──────────────────────────────────────────────
  ctx.subscriptions.push(ctx.icons.register(PACK_ID, {
    notion: { svg: readIconSvg('notion'), description: 'Notion' },
    link: { svg: readIconSvg('link'), description: 'Connect Notion' },
    search: { svg: readIconSvg('search'), description: 'Search pages' },
    database: { svg: readIconSvg('database'), description: 'Browse databases' },
    'log-out': { svg: readIconSvg('log-out'), description: 'Disconnect Notion' },
  }));

  // ── Agent tool: notion_login ───────────────────────────────
  ctx.subscriptions.push(ctx.tools.register({
    name: 'notion_login',
    title: 'Connect Notion',
    description: `Connect or reauthorize Notion MCP via OAuth. Starts Finch's native OAuth flow immediately. Call this when the user wants to connect Notion, or when Notion MCP tools return authentication/permission errors.`,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    risk: 'high',
    async execute() {
      if (!ctx.capabilities.has('mcp.client')) {
        return text('MCP Client is unavailable. Enable the MCP Client extension first.', true);
      }
      const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');

      try {
        connectionState = 'connecting';
        notifyAction();
        await mcp.connectServer(SERVER_NAME);
        const tools = await mcp.listTools(SERVER_NAME);
        connectionState = 'connected';
        notifyAction();
        return text(`Notion MCP connected successfully.\n\nAvailable tools (${tools.length}):\n${tools.map((t) => `- ${t.name}`).join('\n')}`);
      } catch (error) {
        connectionState = 'unknown';
        notifyAction();
        return text(`无法连接 Notion MCP：${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  }));

  // ── ComposerAction ─────────────────────────────────────────
  // Keep menu rendering local. MCP probing may create or await a remote connection,
  // so it must never block a click on the toolbar button.
  const action = ctx.composerActions.register('notion', {
    async getBadge() {
      return connectionState === 'connecting' ? { text: '连接中', active: true } : undefined;
    },

    async getMenu() {
      if (!ctx.capabilities.has('mcp.client')) {
        return [{ id: 'connect', label: '连接 Notion', iconName: ICON('link') }];
      }
      if (connectionState === 'unknown' || connectionState === 'disconnected') {
        // Start OAuth from the toolbar click, but return immediately so the menu never
        // waits on network or browser authorization.
        connectionState = 'connecting';
        action.notifyUpdate();
        const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');
        void mcp.connectServer(SERVER_NAME).then(async () => {
          connectionState = 'connected';
          action.notifyUpdate();
          await ctx.ui.showToast({ title: 'Notion 已连接', variant: 'success' });
        }).catch(async (error) => {
          connectionState = 'unknown';
          action.notifyUpdate();
          await ctx.ui.showToast({
            title: '连接失败',
            description: error instanceof Error ? error.message : String(error),
            variant: 'error',
          });
        });
        return [{ id: 'connecting', label: '正在连接 Notion…', iconName: ICON('link'), disabled: true }];
      }
      if (connectionState === 'connecting') {
        return [{ id: 'connecting', label: '正在连接 Notion…', iconName: ICON('link'), disabled: true }];
      }

      return [
        { id: 'search', label: '搜索页面', iconName: ICON('search') },
        { id: 'databases', label: '浏览数据库', iconName: ICON('database') },
        { id: '__sep__', label: '', separator: true },
        { id: 'disconnect', label: '断开连接', iconName: ICON('log-out') },
      ];
    },

    async execute(_context, itemId, actions) {
      if (!ctx.capabilities.has('mcp.client')) {
        await ctx.ui.showToast({ title: 'MCP Client 不可用', variant: 'error' });
        return;
      }
      const mcp = ctx.capabilities.get<McpClientCapability>('mcp.client');

      if (itemId === 'connect') {
        connectionState = 'connecting';
        action.notifyUpdate();
        await ctx.ui.showToast({ title: '正在连接 Notion…', variant: 'info' });
        try {
          await mcp.connectServer(SERVER_NAME);
          connectionState = 'connected';
          action.notifyUpdate();
          await ctx.ui.showToast({ title: 'Notion 已连接', variant: 'success' });
        } catch (error) {
          connectionState = 'unknown';
          action.notifyUpdate();
          await ctx.ui.showToast({
            title: '连接失败',
            description: error instanceof Error ? error.message : String(error),
            variant: 'error',
          });
        }
        return;
      }

      if (itemId === 'disconnect') {
        const confirmation = await ctx.ui.showConfirmDialog({
          title: '断开 Notion 连接',
          description: '将移除本地保存的 Notion OAuth 凭证。之后需要重新授权才能使用。',
          confirmLabel: '确认断开',
          cancelLabel: '取消',
          variant: 'danger',
        });
        if (!confirmation.confirmed) return;

        try {
          await mcp.disconnectServerOAuth(SERVER_NAME);
          connectionState = 'disconnected';
          action.notifyUpdate();
          await ctx.ui.showToast({ title: 'Notion 已断开', variant: 'info' });
        } catch (error) {
          await ctx.ui.showToast({
            title: '断开失败',
            description: error instanceof Error ? error.message : String(error),
            variant: 'error',
          });
        }
        return;
      }

      if (itemId === 'search') {
        await actions.composer.fill('搜索我的 Notion 页面：');
        return;
      }

      if (itemId === 'databases') {
        await actions.composer.fill('浏览我的 Notion 数据库');
        return;
      }
    },
  });
  ctx.subscriptions.push(action);
  notifyAction = () => action.notifyUpdate();

}

export function deactivate(): void {
  const ctx = activeCtx;
  activeCtx = undefined;
  if (ctx?.capabilities.has('mcp.client')) {
    void ctx.capabilities.get<McpClientCapability>('mcp.client').unregisterServer(SERVER_NAME).catch(() => undefined);
  }
}
