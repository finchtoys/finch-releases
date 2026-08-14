import type * as finch from 'finch';
import { readFile } from 'node:fs/promises';
import { WecomBridge } from './bridge';
import { errorText, mediaTypeFor, stripBotMention } from './utils';

function textResult(text: string, isError = false): finch.ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export async function activate(ctx: finch.MiniToolContext): Promise<void> {
  const svg = await readFile(new URL('../icons/wecom.svg', import.meta.url), 'utf8');
  ctx.subscriptions.push(ctx.icons.register('wecom-box', { wecom: { svg } }));

  const bridge = new WecomBridge(ctx);
  ctx.subscriptions.push(bridge.registerSessionEvents());
  ctx.subscriptions.push({ dispose: () => bridge.dispose() });

  const showToast = (title: string, description?: string, variant: finch.ToastVariant = 'info') => {
    void ctx.ui.showToast({ title, description, variant, position: 'TR' });
  };

  // ── 配置弹窗：收集 BotID / Secret → ctx.secrets ─────────────────────────────

  const configure = async (): Promise<void> => {
    const result = await ctx.ui.showModalDialog({
      title: '连接企业微信智能机器人',
      message: '在企业微信管理后台开启智能机器人的 API 模式并选择「长连接」，然后填入长连接专用凭证。凭证仅保存在系统安全存储中。',
      actions: [
        { id: 'cancel', label: '取消' },
        { id: 'save', label: '保存并连接', variant: 'primary' },
      ],
      fields: [
        { key: 'botId', label: 'BotID', type: 'text', required: true, width: '2/3' },
        {
          key: 'docs', label: '查看官方配置文档', type: 'link',
          href: 'https://developer.work.weixin.qq.com/document/path/101463', width: '1/3',
        },
        { key: 'secret', label: 'Secret', type: 'password', secret: true, required: true },
      ],
    });
    if (result.action !== 'save') return;
    const botId = String(result.values?.botId ?? '').trim();
    const secret = String(result.values?.secret ?? '').trim();
    if (!botId || !secret) return;
    await bridge.saveCredentials(botId, secret);
    bridge.reconnect();
    showToast('企业微信连接已保存', '正在建立长连接。', 'success');
  };

  // ── 统一设置菜单（容器页头部 + 工具箱） ─────────────────────────────────────

  const menu = ctx.settingsMenu.register({
    async getMenu() {
      const configured = await bridge.hasCredentials();
      const runtime = bridge.runtime;
      const description = runtime.authenticated
        ? `已连接 · 已接收 ${runtime.receivedCount} 条消息`
        : runtime.connecting
          ? '正在连接'
          : runtime.lastError
            ? `连接异常：${runtime.lastError}`
            : configured
              ? '已配置，当前未连接'
              : '尚未配置';
      const items: finch.ComposerActionMenuItem[] = [
        {
          id: 'connection-status',
          label: '连接状态',
          description,
          iconName: runtime.authenticated ? 'toggle-right' : 'toggle-left',
          disabled: true,
        },
        { id: 'connection-divider', label: '', separator: true },
        {
          id: 'configure',
          label: configured ? '更新连接凭证' : '配置连接',
          iconName: 'settings',
          hoverText: '配置企业微信智能机器人的 BotID 与长连接 Secret。',
        },
      ];
      if (configured && !runtime.authenticated) {
        items.push({ id: 'reconnect', label: '重新连接', iconName: 'zap' });
      }
      if (runtime.authenticated || runtime.connecting) {
        items.push({ id: 'disconnect', label: '断开连接', iconName: 'toggle-left' });
      }
      if (configured) {
        items.push({ id: 'clear', label: '清除连接凭证', iconName: 'log-in' });
      }
      return items;
    },

    async execute(_menuContext, itemId) {
      try {
        if (itemId === 'configure') await configure();
        else if (itemId === 'reconnect') bridge.reconnect();
        else if (itemId === 'disconnect') bridge.disconnect();
        else if (itemId === 'clear') {
          const confirmed = await ctx.ui.showConfirmDialog({
            title: '清除企业微信凭证？',
            message: '这会断开当前连接，并从系统安全存储中删除 BotID 与 Secret。',
            confirmLabel: '清除',
            cancelLabel: '取消',
            variant: 'danger',
          });
          const ok = (confirmed as unknown as { confirmed?: boolean } | boolean) === true
            || (typeof confirmed === 'object' && confirmed !== null && (confirmed as { confirmed?: boolean }).confirmed === true);
          if (ok) {
            await bridge.clearCredentials();
            showToast('企业微信凭证已清除', undefined, 'success');
          }
        }
      } catch (error) {
        ctx.logger.error('wecom settings action failed', error);
        showToast('企业微信操作失败', errorText(error), 'error');
      }
    },
  });
  bridge.setMenu(menu);
  ctx.subscriptions.push(menu);

  // ── Agent 工具：wecom_box_session ──────────────────────────────────────────

  ctx.subscriptions.push(ctx.tools.register({
    name: 'wecom_box_session',
    title: '管理企业微信会话',
    description: `Manage WeCom peers and their Finch Sessions.
action:
  list — list known WeCom single and group conversation keys
  new  — start a fresh Finch Session for a known peer (requires peerKey; title optional)`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new'] },
        peerKey: { type: 'string', description: 'Known peer key, userid, or group chatid. Required for new.' },
        title: { type: 'string', description: 'Optional title for the fresh Session.' },
      },
      required: ['action'],
    },
    defaultEnabled: true,
    risk: 'medium',
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { action?: unknown; peerKey?: unknown; title?: unknown };
      const action = typeof input.action === 'string' ? input.action : '';
      if (action === 'list') {
        const peers = await bridge.listPeers();
        if (!peers.length) return textResult('No WeCom conversations are known yet. Receive a message first.');
        return textResult(peers.map((peer) => `${peer.key} · ${peer.chatType} · chatId=${peer.chatId}`).join('\n'));
      }
      if (action !== 'new') return textResult('action must be list or new.', true);
      const peerKey = typeof input.peerKey === 'string' ? input.peerKey.trim() : '';
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!peerKey) return textResult('new requires peerKey.', true);
      try {
        const sessionId = await bridge.createFreshSession(peerKey, title || undefined);
        return textResult(`A fresh WeCom Finch Session is active for ${peerKey}. sessionId: ${sessionId}`);
      } catch (error) {
        return textResult(`Failed to create WeCom Session: ${errorText(error)}`, true);
      }
    },
  }));

  // ── Agent 工具：wecom_box_send ─────────────────────────────────────────────

  ctx.subscriptions.push(ctx.tools.register({
    name: 'wecom_box_send',
    title: '发送企业微信消息',
    description: 'Send a text message or local media file to a known WeCom single or group conversation. Use peerKey from wecom_box_session list. The message is used as a caption when filePath is present.',
    inputSchema: {
      type: 'object',
      properties: {
        peerKey: { type: 'string', description: 'Known peer key, userid, or group chatid.' },
        message: { type: 'string', description: 'Markdown text, or an optional media caption.' },
        filePath: { type: 'string', description: 'Optional local image, MP4, AMR, or file path.' },
      },
      required: ['peerKey'],
    },
    defaultEnabled: true,
    risk: 'medium',
    callDisplay: { inline: { mode: 'single', fields: [{ path: 'peerKey', label: '发送给' }] } },
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { peerKey?: unknown; message?: unknown; filePath?: unknown };
      const peerKey = typeof input.peerKey === 'string' ? input.peerKey.trim() : '';
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : '';
      if (!peerKey || (!message && !filePath)) return textResult('Provide peerKey and message or filePath.', true);
      try {
        if (filePath) await bridge.sendFile(peerKey, filePath, message || undefined);
        else await bridge.sendText(peerKey, message);
        return textResult(`WeCom message sent to ${peerKey}.`);
      } catch (error) {
        return textResult(`Failed to send WeCom message: ${errorText(error)}`, true);
      }
    },
  }));

  // ── 启动 ────────────────────────────────────────────────────────────────────

  if (await bridge.hasCredentials()) bridge.connect();

  ctx.logger.info('WeCom Box activated', {
    configured: await bridge.hasCredentials(),
    botIdStoredSecurely: Boolean(await ctx.secrets.get('wecom.botId')),
    secretStoredSecurely: Boolean(await ctx.secrets.get('wecom.secret')),
  });
}

export function deactivate(): void {
  // 订阅在 ctx.subscriptions 中自动清理；连接在 dispose 中断开。
}

export { mediaTypeFor, stripBotMention };
