import type * as finch from 'finch';
import { readFile } from 'node:fs/promises';
import {
  CONTAINER_ID, wecomIcon,
  KEY_ACTIVE_SESSION, SESSION_MAP_PREFIX, TURN_MAP_PREFIX,
  WAIT_PREFIX, WAIT_INDEX_PREFIX, MSG_DEDUP_PREFIX, MSG_DEDUP_WINDOW_MS,
  WAIT_CODE_BYTES,
  type BotState, type TaskRecord, type PendingWaitRecord, type WeComChatType, type WeComPeerRecord,
} from './types';
import { createBotState } from './types';
import { sleep, randomHex, stripBotMention, sanitizeTitle } from './utils';
import { WeComTransport, type RawInbound, type WsFrameHeaders } from './wecom-client';
import { MediaManager } from './media';
import { TaskManager } from './tasks';

type BotConfig = { botId: string; secret: string; botName: string; autoReply: boolean };

export async function activate(ctx: finch.MiniToolContext): Promise<void> {
  const state = createBotState();
  const appInfo = await ctx.app.getInfo();
  const assistantName = appInfo.assistantName || appInfo.name;
  const waitText = (key: string, values?: finch.TranslationValues): string =>
    ctx.i18n.t(`runtime.wait.${key}`, { assistantName, appName: appInfo.name, ...values });

  const iconNames = ['wecom', 'activity', 'play', 'satellite-dish', 'unplug', 'log-out', 'plug', 'settings'];
  const icons = Object.fromEntries(await Promise.all(iconNames.map(async (id) => [id, {
    svg: await readFile(new URL(`../icons/${id}.svg`, import.meta.url), 'utf8'),
  }] as const)));
  ctx.subscriptions.push(ctx.icons.register('wecom', icons));

  const toast = (title: string, description?: string, variant: finch.ToastVariant = 'info') => {
    void ctx.ui.showToast({ title, description, variant, position: 'TR' });
  };

  const readConfig = (): BotConfig => ({
    botId: (ctx.settings.get<string>('botId') ?? '').trim(),
    secret: (ctx.settings.get<string>('secret') ?? '').trim(),
    botName: (ctx.settings.get<string>('botName') ?? '').trim(),
    autoReply: ctx.settings.get<boolean>('autoReply') ?? true,
  });

  // ── 模块组装 ────────────────────────────────────────────────────────────────

  let transport: WeComTransport | undefined;
  const media = new MediaManager(ctx, () => transport);

  // SDK Logger 适配：把 SDK 日志转发到 Finch logger。
  const sdkLogger = {
    debug: (message: string, ...args: unknown[]) => ctx.logger.debug(message, args.length ? args : undefined),
    info: (message: string, ...args: unknown[]) => ctx.logger.info(message, args.length ? args : undefined),
    warn: (message: string, ...args: unknown[]) => ctx.logger.warn(message, args.length ? args : undefined),
    error: (message: string, ...args: unknown[]) => ctx.logger.error(message, args.length ? args : undefined),
  };

  const connectTransport = (): WeComTransport | undefined => {
    const { botId, secret } = readConfig();
    if (!botId || !secret) return undefined;
    transport = new WeComTransport(ctx, { botId, secret, logger: sdkLogger }, handleInbound, handleTransportEvent);
    transport.connect();
    return transport;
  };

  // ── Session 管理 ────────────────────────────────────────────────────────────

  const formatWeComSessionTitle = (label?: string): string => {
    const createdAt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date()).replace(/\//g, '-');
    return label ? `企微 · ${createdAt} · ${sanitizeTitle(label)}` : `企微 · ${createdAt}`;
  };

  const createWeComSession = async (peer: WeComPeerRecord): Promise<string> => {
    const created = await ctx.sessions.create({
      containerId: CONTAINER_ID,
      title: formatWeComSessionTitle(peer.kind === 'group' ? peer.peerKey : undefined),
      activity: 'background',
      permissionMode: 'acceptCalls',
    });
    await ctx.storage.set(KEY_ACTIVE_SESSION, created.sessionId);
    await ctx.storage.set(`${SESSION_MAP_PREFIX}${created.sessionId}`, peer);
    return created.sessionId;
  };

  const ensureWeComSession = async (peer: WeComPeerRecord): Promise<string> => {
    const active = await ctx.storage.get<string>(KEY_ACTIVE_SESSION);
    if (active) {
      const rec = await ctx.storage.get<WeComPeerRecord>(`${SESSION_MAP_PREFIX}${active}`);
      if (rec?.peerKey === peer.peerKey) return active;
    }
    return createWeComSession(peer);
  };

  // ── 等待状态中继（对齐 wechat-bot 的 #code 机制） ──────────────────────────

  const waitIndexKey = (peerKey: string) => `${WAIT_INDEX_PREFIX}${peerKey}`;

  const removePendingWait = async (pending: PendingWaitRecord): Promise<void> => {
    await ctx.storage.delete(`${WAIT_PREFIX}${pending.code}`);
    const codes = (await ctx.storage.get<string[]>(waitIndexKey(pending.peerKey))) ?? [];
    await ctx.storage.set(waitIndexKey(pending.peerKey), codes.filter((code) => code !== pending.code));
  };

  const listWaitsSafe = async (sessionId: string): Promise<finch.SessionWait[] | undefined> => {
    try {
      return await ctx.sessions.listWaits(sessionId);
    } catch (error) {
      ctx.logger.debug('session for pending wait is no longer accessible', { sessionId, error: String(error) });
      return undefined;
    }
  };

  const getLivePendingWaits = async (peerKey: string): Promise<{ pending: PendingWaitRecord; wait: finch.SessionWait }[]> => {
    const codes = (await ctx.storage.get<string[]>(waitIndexKey(peerKey))) ?? [];
    const live: { pending: PendingWaitRecord; wait: finch.SessionWait }[] = [];
    for (const code of codes) {
      const pending = await ctx.storage.get<PendingWaitRecord>(`${WAIT_PREFIX}${code}`);
      if (!pending || pending.peerKey !== peerKey) {
        await ctx.storage.delete(`${WAIT_PREFIX}${code}`);
        continue;
      }
      const waits = await listWaitsSafe(pending.sessionId);
      const wait = waits?.find((candidate) => candidate.requestId === pending.requestId);
      if (wait) {
        live.push({ pending, wait });
      } else {
        await ctx.storage.delete(`${WAIT_PREFIX}${pending.code}`);
      }
    }
    await ctx.storage.set(waitIndexKey(peerKey), live.map((entry) => entry.pending.code));
    return live;
  };

  const cleanDelegatedAnswer = (value: string): string =>
    value.trim().replace(/^用户回答\s*[：:]\s*/i, '').trim();

  const responseForWait = (
    wait: finch.SessionWait,
    rawValue: string,
  ): { response?: finch.SessionWaitResponse; error?: string } => {
    const value = cleanDelegatedAnswer(rawValue);
    if (wait.kind === 'permission') {
      if (/^(允许|同意|allow|yes|y)(?:[，,：:\s].*)?$/i.test(value)) {
        if (wait.destructive) {
          return { error: waitText('destructive.approveBlocked') };
        }
        return { response: { kind: 'permission', allow: true } };
      }
      if (/^(拒绝|取消|deny|no|n)(?:[，,：:\s].*)?$/i.test(value)) return { response: { kind: 'permission', allow: false } };
      return { error: wait.destructive
        ? waitText('destructive.invalidReply')
        : waitText('permission.invalidReply') };
    }
    if (wait.kind === 'question') {
      const answers: Record<string, string> = {};
      if (wait.questions.length === 1) {
        answers[wait.questions[0].header] = value;
      } else {
        for (const line of value.split(/\n|；|;/)) {
          const item = line.trim().match(/^([^=：:]+)[=：:]\s*(.+)$/);
          if (item && wait.questions.some((question) => question.header === item[1].trim())) {
            answers[item[1].trim()] = item[2].trim();
          }
        }
        const missing = wait.questions.filter((question) => !answers[question.header]);
        if (missing.length) {
          return { error: waitText('question.missingFields', {
            fields: wait.questions.map((question) => `${question.header}=${waitText('question.answerPlaceholder')}`).join(waitText('separator.items')),
          }) };
        }
      }
      return { response: { kind: 'question', answers } };
    }
    if (/^(取消|cancel)$/i.test(value)) return { response: { kind: 'form', submitted: false } };
    const values: Record<string, string | number | boolean | string[]> = {};
    for (const line of value.split(/\n|；|;/)) {
      const item = line.trim().match(/^([^=：:]+)[=：:]\s*(.+)$/);
      if (!item) continue;
      const field = wait.form.fields.find((candidate) => candidate.key === item[1].trim());
      if (!field || field.type === 'link') continue;
      const raw = item[2].trim();
      if (field.type === 'number') values[field.key] = Number(raw);
      else if (field.type === 'boolean') values[field.key] = /^(true|是|yes|y|1)$/i.test(raw);
      else if (field.type === 'multiselect') values[field.key] = raw.split(/[，,]/).map((entry) => entry.trim()).filter(Boolean);
      else values[field.key] = raw;
    }
    if (!Object.keys(values).length) return { error: waitText('form.invalidReply') };
    return { response: { kind: 'form', submitted: true, values } };
  };

  const renderWait = (wait: finch.SessionWait): string | undefined => {
    if (wait.kind === 'permission') {
      const operation = wait.toolTitle ?? wait.toolName;
      return wait.destructive
        ? [waitText('destructive.title'), waitText('operation', { operation }), waitText('destructive.reply')].join('\n')
        : [waitText('permission.title'), waitText('operation', { operation }), waitText('permission.reply')].join('\n');
    }
    if (wait.kind === 'question') {
      const questions = wait.questions.map((question) => {
        const options = question.options.map((option) =>
          `  - ${option.label}${option.description ? waitText('optionDescription', { description: option.description }) : ''}`,
        ).join('\n');
        return `${waitText('fieldLabel', { field: question.header })}${question.question}${options ? `\n${options}` : ''}`;
      }).join('\n');
      const instruction = wait.questions.length === 1
        ? waitText('question.singleReply')
        : waitText('question.multiReply');
      return `${waitText('question.title')}\n${questions}\n${instruction}`;
    }
    const sensitive = wait.form.fields.some((field) => field.secret || field.type === 'password');
    if (sensitive) {
      return waitText('form.sensitive', { title: wait.form.title });
    }
    const fields = wait.form.fields.filter((field) => field.type !== 'link');
    if (!fields.length) return undefined;
    const details = fields.map((field) => {
      const options = field.options?.map((option) => `${option.value}${waitText('optionLabel', { label: option.label })}`).join(waitText('separator.options'));
      return `${waitText('fieldLabel', { field: field.key })}${field.label}${options ? waitText('fieldOptions', { options }) : ''}`;
    }).join('\n');
    return `${waitText('form.title')}\n${wait.form.title}\n${details}\n${waitText('form.reply')}`;
  };

  const summarizeWait = (wait: finch.SessionWait): string => {
    if (wait.kind === 'permission') return wait.toolTitle ?? wait.toolName;
    if (wait.kind === 'question') return wait.questions[0]?.question ?? wait.questions[0]?.header ?? '';
    return wait.form.title;
  };

  const pushWaitToPeer = async (peerKey: string, text: string): Promise<void> => {
    try {
      await transport?.sendText(peerKey, text);
    } catch (error) {
      ctx.logger.warn('push wait card to wecom failed', { peerKey, error: String(error) });
    }
  };

  const relayWait = async (peerKey: string, event: Extract<finch.SessionBridgeEvent, { type: 'turn.waiting' }>) => {
    if (event.wait.kind === 'form' && event.wait.form.fields.some((field) => field.secret || field.type === 'password')) {
      await pushWaitToPeer(peerKey, renderWait(event.wait) ?? waitText('fallback'));
      return;
    }
    if (event.wait.kind === 'form' && !event.wait.form.fields.some((field) => field.type !== 'link')) return;

    const existingCodes = (await ctx.storage.get<string[]>(waitIndexKey(peerKey))) ?? [];
    for (const code of existingCodes) {
      const existing = await ctx.storage.get<PendingWaitRecord>(`${WAIT_PREFIX}${code}`);
      if (existing?.sessionId === event.sessionId && existing.requestId === event.requestId) return;
    }

    const code = randomHex(WAIT_CODE_BYTES);
    const pending: PendingWaitRecord = {
      code, peerKey, sessionId: event.sessionId, requestId: event.requestId, kind: event.wait.kind,
      ...(event.wait.kind === 'question' ? { questionHeaders: event.wait.questions.map((question) => question.header) } : {}),
      ...(event.wait.kind === 'form' ? { formFields: event.wait.form.fields.filter((field) => field.type !== 'link').map((field) => ({ key: field.key, type: field.type })) } : {}),
    };
    await ctx.storage.set(`${WAIT_PREFIX}${code}`, pending);
    await ctx.storage.set(waitIndexKey(peerKey), [...existingCodes, code]);
    await pushWaitToPeer(peerKey, renderWait(event.wait) ?? waitText('fallback'));
  };

  const respondToPendingWait = async (peerKey: string, text: string): Promise<boolean> => {
    const match = text.trim().match(/^#([0-9a-f]{6})\s+([\s\S]+)$/i);
    let pending: PendingWaitRecord | undefined;
    let wait: finch.SessionWait | undefined;
    let value: string;
    if (match) {
      pending = await ctx.storage.get<PendingWaitRecord>(`${WAIT_PREFIX}${match[1].toLowerCase()}`);
      if (!pending || pending.peerKey !== peerKey) return false;
      value = match[2].trim();
      const waits = await listWaitsSafe(pending.sessionId);
      wait = waits?.find((candidate) => candidate.requestId === pending?.requestId);
      if (!wait) {
        await removePendingWait(pending);
        await pushWaitToPeer(peerKey, waitText('expired'));
        return true;
      }
    } else {
      const candidates = await getLivePendingWaits(peerKey);
      if (!candidates.length) return false;
      if (candidates.length > 1) {
        const lines = candidates.map((candidate) =>
          waitText('multiplePendingItem', { code: candidate.pending.code, summary: summarizeWait(candidate.wait) }));
        await pushWaitToPeer(peerKey, `${waitText('multiplePending')}\n${lines.join('\n')}`);
        return true;
      }
      pending = candidates[0].pending;
      wait = candidates[0].wait;
      value = text.trim();
      if (!value) return true;
    }
    const parsed = responseForWait(wait, value);
    if (!parsed.response) {
      await pushWaitToPeer(peerKey, parsed.error ?? waitText('parseFailed'));
      return true;
    }

    const result = await ctx.sessions.respondToWait(pending.sessionId, pending.requestId, parsed.response);
    if (result.state === 'accepted') {
      await removePendingWait(pending);
      await pushWaitToPeer(peerKey, waitText('accepted'));
    } else if (result.state === 'stale') {
      await removePendingWait(pending);
    } else if (result.state === 'forbidden') {
      await removePendingWait(pending);
      ctx.logger.warn('wait response forbidden', { sessionId: pending.sessionId, requestId: pending.requestId, reason: result.reason });
      await pushWaitToPeer(peerKey, waitText('forbidden'));
    } else {
      await removePendingWait(pending);
      await pushWaitToPeer(peerKey, waitText('expired'));
    }
    return true;
  };

  // ── 入站消息处理 ────────────────────────────────────────────────────────────

  // 内存去重：msgid 在窗口内重复回调时忽略（企微可能因网络原因重复推送）。
  const recentMsgids = new Map<string, number>();
  const isDuplicateMsg = (msgid: string): boolean => {
    const now = Date.now();
    const prev = recentMsgids.get(msgid);
    if (prev !== undefined && now - prev < MSG_DEDUP_WINDOW_MS) return true;
    recentMsgids.set(msgid, now);
    if (recentMsgids.size > 1000) {
      const oldest = [...recentMsgids.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) recentMsgids.delete(oldest[0]);
    }
    return false;
  };

  const peerKeyOf = (inbound: RawInbound): string => {
    // 单聊用 userid；群聊用 chatid（缺省时用 userid 兜底）
    return inbound.chattype === 'group' ? (inbound.chatid || inbound.userid) : inbound.userid;
  };

  const handleInbound = async (inbound: RawInbound): Promise<void> => {
    if (!inbound.msgid || isDuplicateMsg(inbound.msgid)) return;
    if (!transport) return;

    const { autoReply, botName } = readConfig();
    const peerKey = peerKeyOf(inbound);

    // 先应答在途等待卡片（#code 或自然语言）
    if (inbound.text && await respondToPendingWait(peerKey, inbound.text)) return;

    // 群聊时剥离 @机器人 前缀，并标注发言人
    let text = stripBotMention(inbound.text, botName);
    if (inbound.chattype === 'group' && inbound.userid) {
      const prefix = `[${inbound.userid}] `;
      text = text ? `${prefix}${text}` : text;
    }

    const attachments = await media.extractAttachments(inbound);
    if (!text && !attachments.length) return;

    const sessionId = await ensureWeComSession({ peerKey, kind: inbound.chattype, userId: inbound.userid });
    const receipt = await ctx.sessions.send(sessionId, {
      text: text || (attachments.length ? `[WeCom ${attachments.map((a) => a.kind).join(', ')}]` : ''),
      idempotencyKey: `wecom:${inbound.msgid}`,
      ...(attachments.length ? { attachments } : {}),
    });
    if (receipt.state === 'rejected') {
      ctx.logger.warn('session queue full', { peerKey, code: receipt.code });
      if (autoReply) await transport.sendText(peerKey, '我现在有点忙，请稍后再试。').catch(() => {});
      return;
    }
    // 记录 turn → 回复目标（含 req_id 透传帧）
    await ctx.storage.set(`${TURN_MAP_PREFIX}${receipt.turnId}`, {
      peerKey,
      kind: inbound.chattype,
      frame: inbound.frame,
    });
    state.deliveredCount += 1;
  };

  const handleTransportEvent = (type: 'connected' | 'authenticated' | 'disconnected' | 'reconnecting' | 'error', detail?: string) => {
    switch (type) {
      case 'connected':
        state.connecting = true;
        state.lastError = undefined;
        break;
      case 'authenticated':
        state.connecting = false;
        state.connected = true;
        state.lastError = undefined;
        state.settingsMenu?.notifyUpdate();
        ctx.logger.info('wecom bot authenticated');
        break;
      case 'disconnected':
        state.connected = false;
        state.settingsMenu?.notifyUpdate();
        if (detail === 'kicked') {
          toast('企微连接被替换', '另一个客户端已建立连接，本连接已断开。', 'warning');
        }
        break;
      case 'reconnecting':
        state.connecting = true;
        state.settingsMenu?.notifyUpdate();
        break;
      case 'error':
        state.connected = false;
        state.connecting = false;
        state.lastError = detail ?? 'unknown';
        state.settingsMenu?.notifyUpdate();
        if (detail?.startsWith('auth_failure')) {
          toast('企微认证失败', 'Bot ID / Secret 可能配置有误，请检查设置。', 'error');
        } else if (detail?.startsWith('reconnect_exhausted')) {
          toast('企微连接失败', '重连次数已用尽，请稍后手动重新连接。', 'error');
        }
        break;
    }
  };

  // ── Session 事件 → 企微回复 ─────────────────────────────────────────────────

  const tasks = new TaskManager(ctx);

  ctx.subscriptions.push(
    ctx.sessions.onDidReceiveEvent(async (event) => {
      if (event.type === 'turn.waiting') {
        const task = await tasks.get(event.sessionId);
        if (task) {
          await tasks.handleEvent(event);
          if (task.notifyPeerKey) {
            await relayWait(task.notifyPeerKey, event).catch((error) => ctx.logger.error('relay task wait failed', error));
          }
          return;
        }
        const peer = await ctx.storage.get<{ peerKey: string }>(`${SESSION_MAP_PREFIX}${event.sessionId}`);
        if (peer?.peerKey) {
          await relayWait(peer.peerKey, event).catch((error) => ctx.logger.error('relay session wait failed', error));
        }
        return;
      }

      if (event.type === 'turn.wait_resolved') {
        const task = await tasks.get(event.sessionId);
        await tasks.handleEvent(event);
        const peerKey = task?.notifyPeerKey
          ?? (await ctx.storage.get<{ peerKey: string }>(`${SESSION_MAP_PREFIX}${event.sessionId}`))?.peerKey;
        if (peerKey) {
          const codes = (await ctx.storage.get<string[]>(waitIndexKey(peerKey))) ?? [];
          for (const code of codes) {
            const pending = await ctx.storage.get<PendingWaitRecord>(`${WAIT_PREFIX}${code}`);
            if (pending?.sessionId === event.sessionId && pending.requestId === event.requestId) {
              await removePendingWait(pending);
              break;
            }
          }
        }
        return;
      }

      // Space 任务优先消费
      if (await tasks.handleEvent(event)) {
        // 终态任务把结果主动推送到企微
        const consumed = await tasks.get(event.sessionId);
        if (consumed && (event.type === 'turn.completed' || event.type === 'turn.failed')
            && (consumed.status === 'completed' || consumed.status === 'failed')) {
          await notifyTaskResult(consumed);
        }
        return;
      }

      if (event.type !== 'turn.completed' && event.type !== 'turn.failed') return;

      const { autoReply } = readConfig();
      const turnKey = `${TURN_MAP_PREFIX}${event.turnId}`;
      let target = await ctx.storage.get<{ peerKey: string; frame?: WsFrameHeaders }>(turnKey);
      await ctx.storage.delete(turnKey);
      if (!target) {
        const bySession = await ctx.storage.get<{ peerKey: string }>(`${SESSION_MAP_PREFIX}${event.sessionId}`);
        if (bySession) target = { peerKey: bySession.peerKey, frame: undefined };
      }
      if (!target?.peerKey || !transport) return;

      if (event.type === 'turn.failed') {
        ctx.logger.warn('turn failed', { peerKey: target.peerKey, code: event.code });
        return;
      }

      const reply = event.outputText.trim();
      if (!reply) return;
      if (!autoReply) {
        ctx.logger.info('autoReply off, not pushing to wecom', { peerKey: target.peerKey });
        return;
      }
      try {
        // 解析输出中的本地图片引用（markdown ![alt](/path)），先发文字再发媒体
        const imagePaths: string[] = [];
        const textWithoutImages = reply.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (_m, url: string) => {
          const trimmed = url.trim().replace(/^<|>$/g, '');
          if (trimmed.startsWith('/')) imagePaths.push(trimmed);
          return '';
        }).trim();

        if (target.frame) {
          // 回复场景：透传 req_id
          if (textWithoutImages) await transport.replyText(target.frame, textWithoutImages);
          for (const imgPath of imagePaths) {
            try {
              const data = await readFile(imgPath);
              await media.replyMedia(target.frame, data, imgPath.split('/').pop() ?? 'image.png');
            } catch (imgError) {
              ctx.logger.warn('failed to send image to wecom', { path: imgPath, error: String(imgError) });
            }
          }
          if (!textWithoutImages && imagePaths.length === 0) await transport.replyText(target.frame, reply);
        } else {
          // 无帧（Session 映射回退）：主动推送
          if (textWithoutImages) await transport.sendText(target.peerKey, textWithoutImages);
          for (const imgPath of imagePaths) {
            try {
              const data = await readFile(imgPath);
              await media.sendMedia(target.peerKey, data, imgPath.split('/').pop() ?? 'image.png');
            } catch (imgError) {
              ctx.logger.warn('failed to send image to wecom', { path: imgPath, error: String(imgError) });
            }
          }
          if (!textWithoutImages && imagePaths.length === 0) await transport.sendText(target.peerKey, reply);
        }
        ctx.logger.info('replied to wecom', { peerKey: target.peerKey, chars: reply.length, images: imagePaths.length });
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        ctx.logger.error('reply to wecom failed', error);
        toast('企微回复失败', '消息暂时无法发送，请稍后重试。', 'error');
      }
    }),
  );

  // ── 主动推送任务结果 ─────────────────────────────────────────────────────────

  const notifyTaskResult = async (task: TaskRecord): Promise<void> => {
    if (!task.notifyPeerKey || !transport) return;
    const label = task.title ? `「${task.title}」` : '任务';
    const body = task.status === 'completed'
      ? `✅ ${label}已完成：\n${(task.lastOutput ?? '').trim() || '（无文本输出）'}`
      : `❌ ${label}执行失败：${task.lastError ?? '未知错误'}`;
    try {
      await transport.sendText(task.notifyPeerKey, body);
      ctx.logger.info('task result pushed to wecom', { sessionId: task.sessionId, status: task.status });
    } catch (error) {
      ctx.logger.error('notify task result failed', error);
    }
  };


  // ── 工具：wecom_new ─────────────────────────────────────────────────────────

  ctx.subscriptions.push(ctx.tools.register({
    name: 'wecom_new',
    title: '开启企微新对话',
    description: 'Start a fresh Finch Session for the logged-in WeCom bot. The previous Session remains in the WeCom inbox, while subsequent messages from the same peer use the new Session.',
    inputSchema: {
      type: 'object',
      properties: {
        peerKey: { type: 'string', description: 'Optional peer key (userid for DM, chatid for group). Defaults to the current active peer.' },
      },
      required: [],
    },
    defaultEnabled: true,
    risk: 'medium',
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { peerKey?: unknown };
      const requested = typeof input.peerKey === 'string' ? input.peerKey.trim() : '';
      const active = await ctx.storage.get<string>(KEY_ACTIVE_SESSION);
      if (!active) return { content: [{ type: 'text', text: 'WeCom bot is not connected or has no active Session.' }], isError: true };
      const peer = requested
        ? { peerKey: requested, kind: 'single' as const, userId: requested }
        : await ctx.storage.get<WeComPeerRecord>(`${SESSION_MAP_PREFIX}${active}`);
      if (!peer) return { content: [{ type: 'text', text: 'No active WeCom peer to start a new conversation for.' }], isError: true };
      try {
        const sessionId = await createWeComSession(peer);
        return { content: [{ type: 'text', text: `A new WeCom Session is active. New sessionId: ${sessionId}.` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Failed to start a new WeCom Session: ${message}` }], isError: true };
      }
    },
  }));

  // ── 工具：wecom_send ────────────────────────────────────────────────────────

  ctx.subscriptions.push(ctx.tools.register({
    name: 'wecom_send',
    title: '发送企微消息',
    description: 'Send a text message, image, or file to WeCom. Provide peerKey (userid for DM, chatid for group). To send media, provide filePath (local file path) or imageUrl (remote URL to download). The message parameter serves as caption when sending media. Note: proactive push works only after the target user has sent the bot at least one message.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text message to send, or caption when sending media.' },
        peerKey: { type: 'string', description: 'WeCom peer key: userid for direct messages, chatid for group chats.' },
        filePath: { type: 'string', description: 'Local file path to send as media. Type is auto-detected from extension.' },
        imageUrl: { type: 'string', description: 'Remote URL to download and send as media.' },
      },
      required: ['peerKey'],
    },
    defaultEnabled: true,
    risk: 'medium',
    callDisplay: { inline: { mode: 'single', fields: [{ path: 'peerKey', label: '发送给' }] } },
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { message?: unknown; peerKey?: unknown; filePath?: unknown; imageUrl?: unknown };
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      const peerKey = typeof input.peerKey === 'string' ? input.peerKey.trim() : '';
      const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : '';
      const imageUrl = typeof input.imageUrl === 'string' ? input.imageUrl.trim() : '';
      if (!peerKey) return { content: [{ type: 'text', text: 'peerKey is required.' }], isError: true };
      if (!transport?.isConnected) return { content: [{ type: 'text', text: 'WeCom bot is not connected. Check Bot ID / Secret settings.' }], isError: true };
      if (!message && !filePath && !imageUrl) return { content: [{ type: 'text', text: 'Provide message, filePath, or imageUrl.' }], isError: true };
      try {
        if (filePath) {
          const data = await readFile(filePath);
          const fileName = filePath.split('/').pop() ?? 'file';
          await transport.sendMedia(peerKey, data, fileName);
          return { content: [{ type: 'text', text: `WeCom media (${fileName}) sent to ${peerKey}.` }] };
        }
        if (imageUrl) {
          const res = await fetch(imageUrl);
          if (!res.ok) return { content: [{ type: 'text', text: `Failed to download media: HTTP ${res.status}` }], isError: true };
          const data = Buffer.from(await res.arrayBuffer());
          const contentType = res.headers.get('content-type') ?? '';
          const urlPath = new URL(imageUrl).pathname;
          const fileName = urlPath.split('/').pop() || (contentType.startsWith('image/') ? 'image.jpg' : 'file');
          await transport.sendMedia(peerKey, data, fileName);
          return { content: [{ type: 'text', text: `WeCom media from URL sent to ${peerKey}.` }] };
        }
        await transport.sendText(peerKey, message);
        return { content: [{ type: 'text', text: `WeCom message sent to ${peerKey}.` }] };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Failed to send WeCom message: ${detail}` }], isError: true };
      }
    },
  }));

  // ── 工具：wecom_space_task ──────────────────────────────────────────────────

  const listWaitsSafeForTask = async (sessionId: string): Promise<finch.SessionWait[] | undefined> => {
    try {
      return await ctx.sessions.listWaits(sessionId);
    } catch (error) {
      ctx.logger.debug('task session no longer accessible', { sessionId, error: String(error) });
      return undefined;
    }
  };

  ctx.subscriptions.push(ctx.tools.register({
    name: 'wecom_space_task',
    title: '管理企微空间任务',
    description: `Manage tasks dispatched from WeCom to Finch Spaces.
action:
  create — create a task in a Space (requires spaceId and message; title and notifyPeerKey are optional)
  send   — send another message to an existing task (requires taskId and message)
  status — inspect one task, or list a compact one-line-per-task index (no output text) that can be
           filtered by spaceId; pass taskId to drill into that task's full detail (including output/error)`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'send', 'status'], description: 'Task operation to perform.' },
        spaceId: { type: 'string', description: 'create: target Space id. status (without taskId): optional filter to only list tasks in this Space.' },
        taskId: { type: 'string', description: 'send/status: task id. For status, provide this to get one task\'s full detail instead of the index.' },
        message: { type: 'string', description: 'create/send: message to send.' },
        title: { type: 'string', description: 'create: optional task title.' },
        notifyPeerKey: { type: 'string', description: 'create: optional WeCom peer key (userid/chatid) for result notifications; defaults to the peer that is associated with the current session.' },
        waitMs: { type: 'number', minimum: 0, maximum: 600000, description: 'status with taskId: optional wait time; returns immediately by default.' },
      },
      required: ['action'],
    },
    defaultEnabled: true,
    risk: 'medium',
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { action?: unknown; spaceId?: unknown; taskId?: unknown; message?: unknown; title?: unknown; notifyPeerKey?: unknown; waitMs?: unknown };
      const taskAction = typeof input.action === 'string' ? input.action : '';
      const spaceId = typeof input.spaceId === 'string' ? input.spaceId.trim() : '';
      const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const requestedNotify = typeof input.notifyPeerKey === 'string' ? input.notifyPeerKey.trim() : '';
      const waitMs = typeof input.waitMs === 'number' && Number.isFinite(input.waitMs) ? Math.max(0, input.waitMs) : 0;

      const defaultNotifyPeerKey = async (): Promise<string | undefined> => {
        const active = await ctx.storage.get<string>(KEY_ACTIVE_SESSION);
        if (active) return (await ctx.storage.get<WeComPeerRecord>(`${SESSION_MAP_PREFIX}${active}`))?.peerKey;
        return undefined;
      };

      if (taskAction === 'send') {
        if (!taskId || !message) return { content: [{ type: 'text', text: 'send requires taskId and message.' }], isError: true };
        const task = await tasks.get(taskId);
        if (!task) return { content: [{ type: 'text', text: `Task not found: ${taskId}` }], isError: true };

        const waits = await listWaitsSafeForTask(task.sessionId);
        if (waits === undefined) {
          await tasks.remove(taskId);
          return { content: [{ type: 'text', text: `Task ${taskId} no longer exists (its Session was deleted or completed elsewhere); the task record was removed.` }], isError: true };
        }
        if (waits.length > 0) {
          if (waits.length > 1) {
            return { content: [{ type: 'text', text: `Task ${taskId} has multiple pending questions. Answer from the WeCom prompt with its #code.` }], isError: true };
          }
          const parsed = responseForWait(waits[0], message);
          if (!parsed.response) {
            return { content: [{ type: 'text', text: parsed.error ?? 'Invalid answer.' }], isError: true };
          }
          const result = await ctx.sessions.respondToWait(task.sessionId, waits[0].requestId, parsed.response);
          if (result.state === 'accepted') {
            return { content: [{ type: 'text', text: `Answer submitted to waiting task ${taskId}; no new turn was created.` }] };
          }
          if (result.state === 'stale') {
            return { content: [{ type: 'text', text: `The wait in task ${taskId} was already resolved by ${result.resolvedBy}.` }] };
          }
          const reason = result.state === 'forbidden' ? result.reason : 'The wait no longer exists.';
          return { content: [{ type: 'text', text: `Could not answer task ${taskId}: ${reason}` }], isError: true };
        }

        const receipt = await ctx.sessions.send(task.sessionId, {
          text: message,
          idempotencyKey: TaskManager.idempotencyKey(`wecom-task:${taskId}`),
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
        const scoped = await tasks.list(spaceId ? { spaceId } : undefined);
        if (!scoped.length) {
          return { content: [{ type: 'text', text: spaceId ? `There are no Space tasks in ${spaceId}.` : 'There are no Space tasks.' }] };
        }
        const header = spaceId ? `${scoped.length} task(s) in Space ${spaceId}:` : `${scoped.length} task(s) across all Spaces:`;
        const lines = scoped.map(TaskManager.formatTaskSummary);
        return { content: [{ type: 'text', text: [header, ...lines, '', 'Pass taskId for full detail, or spaceId to filter.'].join('\n') }] };
      }

      if (taskAction !== 'create') return { content: [{ type: 'text', text: 'action must be create, send, or status.' }], isError: true };
      if (!spaceId || !message) return { content: [{ type: 'text', text: 'create requires spaceId and message.' }], isError: true };
      try {
        const notifyPeerKey = requestedNotify || (await defaultNotifyPeerKey()) || '';
        const session = await ctx.sessions.create({
          space: { spaceId },
          ...(title ? { title } : {}),
          permissionMode: 'acceptCalls',
        });
        const now = Date.now();
        const task: TaskRecord = {
          sessionId: session.sessionId, spaceId,
          title: title || undefined, notifyPeerKey: notifyPeerKey || undefined,
          status: 'running', createdAt: now, updatedAt: now,
        };
        await tasks.save(task);
        const receipt = await ctx.sessions.send(session.sessionId, {
          text: message,
          idempotencyKey: TaskManager.idempotencyKey(`wecom-space:${spaceId}`),
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
        ctx.logger.info('created space task session', { spaceId, sessionId: session.sessionId, notifyPeerKey });
        const note = notifyPeerKey ? `\nThe result will be sent to WeCom peer ${notifyPeerKey}.` : '';
        return { content: [{ type: 'text', text: `Task created in Space ${spaceId}.\ntaskId: ${session.sessionId}${note}` }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.logger.error('create space session failed', error);
        return { content: [{ type: 'text', text: `Failed to create task: ${msg}` }], isError: true };
      }
    },
  }));

  // ── 设置菜单 ────────────────────────────────────────────────────────────────

  state.settingsMenu = ctx.sessionContainers.registerSettingsMenu(CONTAINER_ID, {
    async getMenu() {
      const { botId, secret } = readConfig();
      const configured = Boolean(botId && secret);
      const items: finch.ComposerActionMenuItem[] = [{
        id: 'status',
        label: '连接状态',
        description: !configured
          ? '未配置 Bot ID / Secret'
          : state.connected
            ? '已连接'
            : state.connecting
              ? '连接中…'
              : state.lastError
                ? `连接异常：${state.lastError}`
                : '已配置，等待连接',
        iconName: wecomIcon(state.connected ? 'satellite-dish' : state.connecting ? 'activity' : 'unplug'),
      }];

      if (configured && !state.connected && !state.connecting) {
        items.push({
          id: 'reconnect', label: '重新连接',
          iconName: wecomIcon('plug'),
          hoverText: '使用现有 Bot ID / Secret 重新建立企微长连接。',
        });
      }
      items.push(
        { id: 'conn-divider', label: '', separator: true },
        {
          id: 'guide',
          label: '配置说明',
          iconName: wecomIcon('settings'),
          hoverText: '如何在企微管理后台创建智能机器人并获取 Bot ID / Secret。',
        },
        {
          id: 'disconnect',
          label: state.connected ? '断开连接' : '清除配置',
          iconName: wecomIcon('log-out'),
          hoverText: state.connected ? '断开企微长连接（保留配置）。' : 'Bot ID / Secret 需在扩展设置中修改；此处仅提示。',
        },
      );
      return items;
    },

    async execute(_menuContext, itemId) {
      if (itemId === 'reconnect') {
        if (transport?.isConnected) return;
        connectTransport();
        return;
      }
      if (itemId === 'disconnect') {
        transport?.disconnect();
        state.connected = false;
        state.settingsMenu?.notifyUpdate();
        return;
      }
      if (itemId === 'guide') {
        ctx.ui.notify(
          '1. 企微管理后台 → 安全与管理 → 管理工具 → 智能机器人 → 创建机器人（选择"使用 API 创建"）\n'
          + '2. 编辑机器人 → 开启 API 模式 → 选择"长连接" → 复制 Bot ID 与 Secret\n'
          + '3. 在扩展设置中填入 Bot ID / Secret，然后从菜单选择"重新连接"。',
          'info',
        );
        return;
      }
      if (itemId === 'status') {
        const { botId } = readConfig();
        const masked = botId ? `${botId.slice(0, 4)}…${botId.slice(-4)}` : '';
        ctx.ui.notify(
          state.connected
            ? `企微已连接（Bot ${masked}），已接收 ${state.deliveredCount} 条消息。`
            : state.connecting
              ? '企微连接中…'
              : state.lastError
                ? `企微连接异常：${state.lastError}`
                : botId
                  ? `已配置 Bot ${masked}，但尚未连接。`
                  : '尚未配置 Bot ID / Secret。',
          state.connected ? 'info' : 'warning',
        );
      }
    },
  });
  ctx.subscriptions.push(state.settingsMenu);

  // ── 停用时清理 ──────────────────────────────────────────────────────────────

  ctx.subscriptions.push({
    dispose: () => {
      transport?.disconnect();
      transport = undefined;
    },
  });

  // 启动时若已配置且未连接，自动恢复接收。
  const { botId, secret } = readConfig();
  if (botId && secret) {
    connectTransport();
  } else {
    ctx.logger.info('WeCom Bot activated without credentials; waiting for settings.');
  }

  ctx.logger.info('WeCom Bot activated', {
    app: appInfo.versionDisplay,
    configured: Boolean(botId && secret),
  });
}

export function deactivate(): void {
  // 订阅在 ctx.subscriptions 中自动清理；连接在 dispose 中断开。
}
