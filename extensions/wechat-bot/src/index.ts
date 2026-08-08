import type * as finch from 'finch';
import { readFile } from 'node:fs/promises';
import {
  CONTAINER_ID, wechatIcon,
  KEY_TOKEN, KEY_BASE_URL, KEY_OWNER_USER, KEY_CURSOR, KEY_ACTIVE_SESSION,
  LEGACY_PEER_MAP_PREFIX, SESSION_MAP_PREFIX, TURN_MAP_PREFIX, CTOKEN_PREFIX,
  RECONNECT_BACKOFF_MS,
  type BotState, type TaskRecord, type WeixinInboundMessage, type GetUpdatesResponse,
} from './types';
import { createBotState } from './types';
import { sleep, randomHex } from './utils';
import { IlinkClient, type BotConfig } from './ilink-client';
import { MediaManager } from './media';
import { AuthManager } from './auth';
import { TaskManager } from './tasks';

export async function activate(ctx: finch.MiniToolContext): Promise<void> {
  const state = createBotState();
  const appInfo = await ctx.app.getInfo();

  const iconNames = ['wechat', 'activity', 'play', 'satellite-dish', 'unplug', 'log-out', 'qr-code', 'scan-qr-code'];
  const icons = Object.fromEntries(await Promise.all(iconNames.map(async (id) => [id, {
    svg: await readFile(new URL(`../icons/${id}.svg`, import.meta.url), 'utf8'),
  }] as const)));
  ctx.subscriptions.push(ctx.icons.register('wechat', icons));

  const toast = (title: string, description?: string, variant: finch.ToastVariant = 'info') => {
    void ctx.ui.showToast({ title, description, variant, position: 'TR' });
  };

  const readConfig = (): BotConfig => ({
    autoReply: ctx.settings.get<boolean>('autoReply') ?? true,
  });

  // ── 组装模块 ────────────────────────────────────────────────────────────────

  const ilink = new IlinkClient(ctx, appInfo.userAgent);
  const media = new MediaManager(ctx, ilink);

  // 前向声明：消息循环启动函数（auth 和 menu 都要调）
  let startMessageLoop: () => void;

  const auth = new AuthManager(ctx, ilink, state, toast, () => startMessageLoop());

  const tasks = new TaskManager(ctx, media);

  // ── Session 管理 ────────────────────────────────────────────────────────────

  const formatWechatSessionTitle = (label?: string): string => {
    const createdAt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date()).replace(/\//g, '-');
    return label ? `微信 · ${createdAt} · ${label}` : `微信 · ${createdAt}`;
  };

  const createWechatSession = async (
    ownerUserId: string, contextToken: string | undefined, label?: string,
  ): Promise<string> => {
    const created = await ctx.sessions.create({
      containerId: CONTAINER_ID,
      title: formatWechatSessionTitle(label),
      activity: 'background',
      permissionMode: 'acceptCalls',
    });
    await ctx.storage.set(KEY_ACTIVE_SESSION, created.sessionId);
    await ctx.storage.set(`${SESSION_MAP_PREFIX}${created.sessionId}`, { peerId: ownerUserId, contextToken });
    return created.sessionId;
  };

  const ensureActiveWechatSession = async (
    ownerUserId: string, nickname: string | undefined, contextToken: string | undefined,
  ): Promise<string> => {
    const active = await ctx.storage.get<string>(KEY_ACTIVE_SESSION);
    if (active && (await ctx.sessions.get(active))) return active;
    const legacy = await ctx.storage.get<string>(`${LEGACY_PEER_MAP_PREFIX}${ownerUserId}`);
    if (legacy && (await ctx.sessions.get(legacy))) {
      await ctx.storage.set(KEY_ACTIVE_SESSION, legacy);
      return legacy;
    }
    return createWechatSession(ownerUserId, contextToken, nickname);
  };

  // ── 入站消息处理 ────────────────────────────────────────────────────────────

  const handleInbound = async (msg: WeixinInboundMessage) => {
    const peerId = msg.from_user_id;
    if (!peerId) return;

    if (msg.context_token) {
      await ctx.storage.set(`${CTOKEN_PREFIX}${peerId}`, msg.context_token);
    }

    const { autoReply } = readConfig();
    const owner = await ctx.storage.get<string>(KEY_OWNER_USER);
    if (owner && peerId !== owner) {
      ctx.logger.debug('message is not from the logged-in owner, skip', { peerId });
      return;
    }
    if (!owner) await ctx.storage.set(KEY_OWNER_USER, peerId);

    let text = media.extractText(msg);
    const attachments = await media.extractAttachments(msg);
    if (!text && attachments.length) {
      const kinds = attachments.map((a) => a.kind === 'image' ? 'image' : 'file').join(', ');
      text = `[WeChat ${kinds}]`;
    }
    if (!text && !attachments.length) return;

    const sessionId = await ensureActiveWechatSession(peerId, msg.from_nickname, msg.context_token);
    const idempotencyKey = `wx:${peerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const receipt = await ctx.sessions.send(sessionId, {
      text, idempotencyKey,
      ...(attachments.length ? { attachments } : {}),
    });

    if (receipt.state === 'rejected') {
      ctx.logger.warn('session queue full', { peerId, code: receipt.code });
      if (autoReply) await media.sendText(peerId, msg.context_token, '我现在有点忙，请稍后再试。').catch(() => {});
      return;
    }
    await ctx.storage.set(`${TURN_MAP_PREFIX}${receipt.turnId}`, { peerId, contextToken: msg.context_token });
    if (autoReply) void auth.startTyping(peerId, msg.context_token);
    state.deliveredCount += 1;
  };

  // ── Session 事件 → 微信回复 ─────────────────────────────────────────────────

  ctx.subscriptions.push(
    ctx.sessions.onDidReceiveEvent(async (event) => {
      // Space 任务优先
      if (await tasks.handleEvent(event)) return;

      if (event.type !== 'turn.completed' && event.type !== 'turn.failed') return;
      const { autoReply } = readConfig();
      const turnKey = `${TURN_MAP_PREFIX}${event.turnId}`;
      let target = await ctx.storage.get<{ peerId: string; contextToken?: string }>(turnKey);
      await ctx.storage.delete(turnKey);
      if (!target) {
        const bySession = await ctx.storage.get<{ peerId: string; contextToken?: string }>(
          `${SESSION_MAP_PREFIX}${event.sessionId}`,
        );
        if (bySession) target = bySession;
      }
      if (!target?.peerId) return;

      await auth.stopTyping(target.peerId);

      if (event.type === 'turn.failed') {
        ctx.logger.warn('turn failed', { peerId: target.peerId, code: event.code });
        return;
      }

      const reply = event.outputText.trim();
      if (!reply) return;
      if (!autoReply) {
        ctx.logger.info('autoReply off, not pushing to wechat', { peerId: target.peerId });
        return;
      }
      try {
        // 解析输出中的本地图片引用（markdown ![alt](/path) ），上传到微信 CDN 发送。
        const imagePaths: string[] = [];
        const textWithoutImages = reply.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (_m, url: string) => {
          const trimmed = url.trim().replace(/^<|>$/g, '');
          if (trimmed.startsWith('/')) imagePaths.push(trimmed);
          return '';
        }).trim();

        if (textWithoutImages) {
          await media.sendText(target.peerId, target.contextToken, textWithoutImages);
        }

        for (const imgPath of imagePaths) {
          try {
            const data = await readFile(imgPath);
            const fileName = imgPath.split('/').pop() ?? 'image.png';
            await media.sendMediaByMime(target.peerId, target.contextToken, data, fileName);
            ctx.logger.info('sent image to wechat', { peerId: target.peerId, path: imgPath });
          } catch (imgError) {
            ctx.logger.warn('failed to send image to wechat', { path: imgPath, error: String(imgError) });
          }
        }

        if (!textWithoutImages && imagePaths.length === 0) {
          await media.sendText(target.peerId, target.contextToken, reply);
        }
        ctx.logger.info('replied to wechat', { peerId: target.peerId, chars: reply.length, images: imagePaths.length });
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        ctx.logger.error('reply to wechat failed', error);
        toast('微信回复失败', '消息暂时无法发送，请稍后重试。', 'error');
      }
    }),
  );

  // ── 长轮询收消息 ────────────────────────────────────────────────────────────

  const messageLoop = async () => {
    if (state.messageRunning) return;
    state.messageRunning = true;
    state.stopMessageLoop = false;
    state.lastError = undefined;
    ctx.logger.info('wechat message loop started');

    while (!state.stopMessageLoop) {
      try {
        const baseUrl = await ilink.getBaseUrl();
        const token = await ilink.getToken();
        if (!baseUrl || !token) {
          ctx.logger.info('not logged in, stopping message loop');
          break;
        }
        const cursor = (await ctx.storage.get<string>(KEY_CURSOR)) ?? '';
        const resp = await ilink.post<GetUpdatesResponse>(baseUrl, 'ilink/bot/getupdates', {
          get_updates_buf: cursor, base_info: ilink.buildBaseInfo(),
        }, token);

        const failed = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
        if (failed) {
          if (resp.errcode === -14 || resp.ret === -14) {
            ctx.logger.warn('session expired (-14), require re-login');
            toast('微信登录已失效', '请重新扫码登录。', 'warning');
            await auth.logout();
            break;
          }
          throw new Error(`getUpdates ret=${resp.ret ?? '-'} errcode=${resp.errcode ?? '-'} ${resp.errmsg ?? ''}`);
        }

        if (resp.get_updates_buf !== undefined) await ctx.storage.set(KEY_CURSOR, resp.get_updates_buf);
        for (const msg of resp.msgs ?? []) {
          try {
            await handleInbound(msg);
          } catch (error) {
            await ctx.storage.delete(KEY_ACTIVE_SESSION);
            const detail = error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { value: String(error) };
            ctx.logger.error('handle inbound failed', { peerId: msg.from_user_id, detail });
          }
        }
        state.backoffIndex = 0;
        state.lastError = undefined;
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        ctx.logger.warn('getUpdates failed, backing off', { error: state.lastError });
        const delay = RECONNECT_BACKOFF_MS[Math.min(state.backoffIndex, RECONNECT_BACKOFF_MS.length - 1)];
        state.backoffIndex += 1;
        await sleep(delay, () => state.stopMessageLoop);
      }
    }

    state.messageRunning = false;
    ctx.logger.info('wechat message loop stopped');
  };

  startMessageLoop = () => {
    if (state.messageRunning) return;
    void messageLoop();
  };

  // ── 微信 inbox SessionView 菜单 ─────────────────────────────────────────────

  state.settingsMenu = ctx.sessionContainers.registerSettingsMenu(CONTAINER_ID, {
    async getMenu() {
      const loggedIn = await ilink.isLoggedIn();
      const items: finch.ComposerActionMenuItem[] = [{
        id: 'status',
        label: '连接状态',
        description: state.loginPhase === 'verify'
          ? '等待输入配对码'
          : state.loginRunning
            ? state.loginPhase === 'scanned' ? '已扫码，等待手机确认' : '等待扫码'
            : loggedIn && state.messageRunning
              ? '已连接'
              : loggedIn
                ? '已登录，等待重新连接'
                : state.lastError ? '连接异常，请重新登录' : '未登录',
        iconName: wechatIcon(loggedIn && state.messageRunning ? 'satellite-dish' : 'unplug'),
      }];

      items.push(
        { id: 'connection-divider', label: '', separator: true },
        {
          id: 'login',
          label: state.loginPhase === 'verify' ? '重新获取二维码' : state.loginRunning ? '再次显示二维码' : loggedIn ? '重新登录' : '登录微信',
          iconName: wechatIcon('scan-qr-code'),
          hoverText: '直接打开微信扫码登录弹窗；已登录时会先清除旧连接。',
        },
      );

      if (loggedIn) {
        if (!state.messageRunning) {
          items.push({
            id: 'reconnect', label: '重新连接',
            iconName: wechatIcon('scan-qr-code'),
            hoverText: '使用现有登录状态恢复接收微信消息。',
          });
        }
        items.push({
          id: 'logout', label: '退出登录',
          iconName: wechatIcon('log-out'),
          hoverText: '清除登录状态并停止接收微信消息。',
        });
      }
      return items;
    },

    async execute(_menuContext, itemId) {
      try {
        if (itemId === 'login') {
          if (await ilink.isLoggedIn()) await auth.logout();
          return void (await auth.showLoginDialog());
        }
        if (itemId === 'logout') return void (await auth.logout());
        if (itemId === 'reconnect') return startMessageLoop();
        if (itemId === 'status') {
          const loggedIn = await ilink.isLoggedIn();
          ctx.ui.notify(
            state.messageRunning
              ? `微信已连接，已接收 ${state.deliveredCount} 条消息。`
              : loggedIn
                ? '登录状态仍然有效，但当前未在接收消息。'
                : state.lastError ? '微信连接异常，请重新登录。' : '微信尚未登录。',
            state.lastError ? 'warning' : 'info',
          );
        }
      } catch (error) {
        ctx.logger.error('wechat SessionView menu failed', itemId, error);
        toast('操作失败', '请稍后重试。', 'error');
      }
    },
  });
  ctx.subscriptions.push(state.settingsMenu);

  // ── Agent 工具：wechat_new ──────────────────────────────────────────────────

  ctx.subscriptions.push(ctx.tools.register({
    name: 'wechat_new',
    title: '开启微信新对话',
    description: 'Start a fresh Finch Session for the logged-in WeChat account. The previous Session remains in the WeChat inbox, while subsequent WeChat messages use the new Session.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional title for the new Session.' },
      },
    },
    defaultEnabled: true,
    risk: 'medium',
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { title?: unknown };
      const requestedTitle = typeof input.title === 'string' ? input.title.trim() : '';
      const ownerUserId = await ctx.storage.get<string>(KEY_OWNER_USER);
      if (!ownerUserId || !(await ilink.isLoggedIn())) {
        return { content: [{ type: 'text', text: 'WeChat is not logged in.' }], isError: true };
      }
      try {
        const previousSessionId = await ctx.storage.get<string>(KEY_ACTIVE_SESSION);
        const contextToken = await ctx.storage.get<string>(`${CTOKEN_PREFIX}${ownerUserId}`);
        const sessionId = await createWechatSession(ownerUserId, contextToken, requestedTitle || undefined);
        ctx.logger.info('created fresh wechat session', { previousSessionId, sessionId });
        return {
          content: [{
            type: 'text',
            text: `A new WeChat Session is active. New sessionId: ${sessionId}. The previous Session remains in the inbox.`,
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Failed to start a new WeChat Session: ${message}` }], isError: true };
      }
    },
  }));

  // ── Agent 工具：wechat_send ─────────────────────────────────────────────────

  ctx.subscriptions.push(ctx.tools.register({
    name: 'wechat_send',
    title: '发送微信消息',
    description: 'Send a text message, image, or file to WeChat. Omit recipient to use the account that completed QR login, or provide a known WeChat userId. To send media, provide filePath (local file path) or imageUrl (remote URL to download). The message parameter serves as caption when sending media.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text message to send, or caption when sending media.' },
        recipient: { type: 'string', description: 'Optional WeChat userId. Defaults to the account that completed QR login.' },
        filePath: { type: 'string', description: 'Local file path to send as media (image/video/file). Type is auto-detected from extension.' },
        imageUrl: { type: 'string', description: 'Remote URL to download and send as media. Type is auto-detected from Content-Type or URL.' },
      },
      required: [],
    },
    defaultEnabled: true,
    risk: 'medium',
    callDisplay: { inline: { mode: 'single', fields: [{ path: 'recipient', label: '发送给' }] } },
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { message?: unknown; recipient?: unknown; filePath?: unknown; imageUrl?: unknown };
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : '';
      const imageUrl = typeof input.imageUrl === 'string' ? input.imageUrl.trim() : '';
      const requestedRecipient = typeof input.recipient === 'string' ? input.recipient.trim() : '';
      if (!message && !filePath && !imageUrl) return { content: [{ type: 'text', text: 'Provide message, filePath, or imageUrl.' }], isError: true };
      const recipient = requestedRecipient || await ctx.storage.get<string>(KEY_OWNER_USER) || '';
      if (!recipient) return { content: [{ type: 'text', text: 'No recipient is known. Log in to WeChat first or provide recipient.' }], isError: true };
      try {
        const contextToken = await ctx.storage.get<string>(`${CTOKEN_PREFIX}${recipient}`);

        if (filePath) {
          const data = await readFile(filePath);
          const fileName = filePath.split('/').pop() ?? 'file';
          await media.sendMediaByMime(recipient, contextToken, data, fileName, message || undefined);
          return { content: [{ type: 'text', text: `WeChat media (${fileName}) sent to ${requestedRecipient ? recipient : 'the logged-in account'}.` }] };
        }
        if (imageUrl) {
          const res = await fetch(imageUrl);
          if (!res.ok) return { content: [{ type: 'text', text: `Failed to download media: HTTP ${res.status}` }], isError: true };
          const data = Buffer.from(await res.arrayBuffer());
          const contentType = res.headers.get('content-type') ?? '';
          const urlPath = new URL(imageUrl).pathname;
          const fileName = urlPath.split('/').pop() || (contentType.startsWith('image/') ? 'image.jpg' : 'file');
          await media.sendMediaByMime(recipient, contextToken, data, fileName, message || undefined);
          return { content: [{ type: 'text', text: `WeChat media from URL sent to ${requestedRecipient ? recipient : 'the logged-in account'}.` }] };
        }

        await media.sendText(recipient, contextToken, message);
        return { content: [{ type: 'text', text: `WeChat message sent to ${requestedRecipient ? recipient : 'the logged-in account'}.` }] };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Failed to send WeChat message: ${detail}` }], isError: true };
      }
    },
  }));

  // ── Agent 工具：wechat_space_task ───────────────────────────────────────────

  ctx.subscriptions.push(ctx.tools.register({
    name: 'wechat_space_task',
    title: '管理微信空间任务',
    description: `Manage tasks dispatched from WeChat to Finch Spaces.
action:
  create — create a task in a Space (requires spaceId and message; title and notifyPeerId are optional)
  send   — send another message to an existing task (requires taskId and message)
  status — inspect one task or list all tasks (taskId and waitMs are optional)`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'send', 'status'], description: 'Task operation to perform.' },
        spaceId: { type: 'string', description: 'create: target Space id.' },
        taskId: { type: 'string', description: 'send/status: task id.' },
        message: { type: 'string', description: 'create/send: message to send.' },
        title: { type: 'string', description: 'create: optional task title.' },
        notifyPeerId: { type: 'string', description: 'create: optional WeChat userId to notify when the task finishes.' },
        waitMs: { type: 'number', minimum: 0, maximum: 600000, description: 'status: optional wait time; returns immediately by default.' },
      },
      required: ['action'],
    },
    defaultEnabled: true,
    risk: 'medium',
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { action?: unknown; spaceId?: unknown; taskId?: unknown; message?: unknown; title?: unknown; notifyPeerId?: unknown; waitMs?: unknown };
      const taskAction = typeof input.action === 'string' ? input.action : '';
      const spaceId = typeof input.spaceId === 'string' ? input.spaceId.trim() : '';
      const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const notifyPeerId = typeof input.notifyPeerId === 'string' ? input.notifyPeerId.trim() : '';
      const waitMs = typeof input.waitMs === 'number' && Number.isFinite(input.waitMs) ? Math.max(0, input.waitMs) : 0;

      if (taskAction === 'send') {
        if (!taskId || !message) return { content: [{ type: 'text', text: 'send requires taskId and message.' }], isError: true };
        const task = await tasks.get(taskId);
        if (!task) return { content: [{ type: 'text', text: `Task not found: ${taskId}` }], isError: true };
        const receipt = await ctx.sessions.send(task.sessionId, {
          text: message,
          idempotencyKey: TaskManager.idempotencyKey(`wx-task:${taskId}`),
        });
        if (receipt.state === 'rejected') return { content: [{ type: 'text', text: `The task queue rejected the message. Retry after ${receipt.retryAfterMs}ms.` }], isError: true };
        task.status = 'running';
        task.lastTurnId = receipt.turnId;
        task.updatedAt = Date.now();
        await tasks.save(task);
        return { content: [{ type: 'text', text: `Message sent to task ${taskId}.` }] };
      }

      if (taskAction === 'status') {
        if (taskId) {
          const stored = await tasks.get(taskId);
          if (!stored) return { content: [{ type: 'text', text: `Task not found: ${taskId}` }], isError: true };
          const task = waitMs > 0 ? await tasks.waitFor(stored, waitMs) : stored;
          return { content: [{ type: 'text', text: TaskManager.formatTask(task) }] };
        }
        const allTasks = await tasks.list();
        return { content: [{ type: 'text', text: allTasks.length ? allTasks.map(TaskManager.formatTask).join('\n\n') : 'There are no Space tasks.' }] };
      }

      if (taskAction !== 'create') return { content: [{ type: 'text', text: 'action must be create, send, or status.' }], isError: true };
      if (!spaceId || !message) return { content: [{ type: 'text', text: 'create requires spaceId and message.' }], isError: true };
      try {
        const session = await ctx.sessions.create({
          space: { spaceId },
          ...(title ? { title } : {}),
          activity: 'background',
          permissionMode: 'acceptCalls',
        });
        const now = Date.now();
        const task: TaskRecord = {
          sessionId: session.sessionId, spaceId,
          title: title || undefined, notifyPeerId: notifyPeerId || undefined,
          status: 'running', createdAt: now, updatedAt: now,
        };
        await tasks.save(task);
        const receipt = await ctx.sessions.send(session.sessionId, {
          text: message,
          idempotencyKey: TaskManager.idempotencyKey(`wx-space:${spaceId}`),
        });
        if (receipt.state === 'rejected') {
          task.status = 'failed';
          task.lastError = receipt.code;
          task.updatedAt = Date.now();
          await tasks.save(task);
          throw new Error(`The initial message was rejected (${receipt.code})`);
        }
        task.lastTurnId = receipt.turnId;
        task.updatedAt = Date.now();
        await tasks.save(task);
        ctx.logger.info('created space task session', { spaceId, sessionId: session.sessionId, notifyPeerId });
        const note = notifyPeerId ? `\nThe result will be sent to WeChat user ${notifyPeerId}.` : '';
        return { content: [{ type: 'text', text: `Task created in Space ${spaceId}.\ntaskId: ${session.sessionId}${note}` }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.logger.error('create space session failed', error);
        return { content: [{ type: 'text', text: `Failed to create task: ${msg}` }], isError: true };
      }
    },
  }));

  // ── 停用时清理 ────────────────────────────────────────────────────────────────

  ctx.subscriptions.push({
    dispose: () => {
      state.loginAttempt += 1;
      state.loginCancel = true;
      void state.activeLoginDialog?.close('disposed');
      state.activeLoginDialog = undefined;
      state.stopMessageLoop = true;
      auth.clearTypingTimers();
    },
  });

  // 启动时若已登录，自动恢复接收。
  if (await ilink.isLoggedIn()) startMessageLoop();

  ctx.logger.info('WeChat Bot activated', {
    app: appInfo.versionDisplay,
    loggedIn: await ilink.isLoggedIn(),
  });
}

export function deactivate(): void {
  // 订阅在 ctx.subscriptions 中自动清理；循环标志会终止轮询。
}
