import type * as finch from 'finch';
import { readFile } from 'node:fs/promises';
import {
  CONTAINER_ID, wechatIcon,
  SESSION_MAP_PREFIX, TURN_MAP_PREFIX,
  WAIT_PREFIX, WAIT_INDEX_PREFIX, RECONNECT_BACKOFF_MS,
  type AccountLoopState, type BotState, type PeerTarget, type TaskRecord, type PendingWaitRecord,
  type WeChatAccount, type WeixinInboundMessage, type GetUpdatesResponse,
} from './types';
import { createBotState } from './types';
import { formatChinaDateTime, sleep, randomHex } from './utils';
import { IlinkClient, type BotConfig, type IlinkAccount } from './ilink-client';
import { AccountStore, activeSessionKey, cursorKey } from './accounts';
import { ContextStore } from './context';
import { MediaManager } from './media';
import { executeWechatSend } from './send-tool';
import { AuthManager } from './auth';
import { TaskManager } from './tasks';

export async function activate(ctx: finch.MiniToolContext): Promise<void> {
  const state = createBotState();
  const appInfo = await ctx.app.getInfo();
  const assistantName = appInfo.assistantName || appInfo.name;
  const waitText = (key: string, values?: finch.TranslationValues): string =>
    ctx.i18n.t(`runtime.wait.${key}`, { assistantName, appName: appInfo.name, ...values });

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

  const accounts = new AccountStore(ctx);
  const ilink = new IlinkClient(ctx, appInfo.userAgent);
  const contexts = new ContextStore(ctx, accounts);
  // 旧单账号数据迁移成主账号记录，再清理历史无主上下文。
  const migrated = await accounts.migrateLegacy();
  await contexts.discardLegacy();
  if (migrated) await contexts.adoptLegacyScope({ botId: migrated.botId, botToken: migrated.botToken });
  await accounts.ensurePrimary();
  const media = new MediaManager(ctx, ilink, contexts, accounts);

  // 前向声明：消息循环启动函数（auth 和 menu 都要调）
  let startMessageLoop: (accountId: string) => void;

  const auth = new AuthManager(ctx, ilink, contexts, accounts, state, toast, (accountId) => startMessageLoop(accountId));

  const tasks = new TaskManager(ctx, media, accounts);

  // ── Session 管理 ────────────────────────────────────────────────────────────

  const formatWechatSessionTitle = (accountLabel: string, label?: string): string => {
    const createdAt = formatChinaDateTime();
    const suffix = label ? ` · ${label}` : '';
    return `微信 · ${accountLabel} · ${createdAt}${suffix}`;
  };

  const createWechatSession = async (
    account: WeChatAccount, ownerUserId: string, label?: string,
  ): Promise<string> => {
    const created = await ctx.sessions.create({
      containerId: CONTAINER_ID,
      title: formatWechatSessionTitle(account.label, label),
      activity: 'background',
      permissionMode: 'acceptCalls',
    });
    await ctx.storage.set(activeSessionKey(account.id), created.sessionId);
    const target: PeerTarget = { peerId: ownerUserId, accountId: account.id };
    await ctx.storage.set(`${SESSION_MAP_PREFIX}${created.sessionId}`, target);
    return created.sessionId;
  };

  const ensureActiveWechatSession = async (
    account: WeChatAccount, ownerUserId: string, nickname: string | undefined,
  ): Promise<string> => {
    const key = activeSessionKey(account.id);
    const active = await ctx.storage.get<string>(key);
    if (active && (await ctx.sessions.get(active))) return active;
    return createWechatSession(account, ownerUserId, nickname);
  };

  // ── 等待状态中继 ────────────────────────────────────────────────────────────

  const waitIndexKey = (accountId: string, peerId: string) => `${WAIT_INDEX_PREFIX}${accountId}:${peerId}`;

  const removePendingWait = async (pending: PendingWaitRecord): Promise<void> => {
    await ctx.storage.delete(`${WAIT_PREFIX}${pending.code}`);
    const codes = (await ctx.storage.get<string[]>(waitIndexKey(pending.accountId, pending.peerId))) ?? [];
    await ctx.storage.set(waitIndexKey(pending.accountId, pending.peerId), codes.filter((code) => code !== pending.code));
  };

  /** Safe wrapper: the session backing a pending wait may have been deleted,
   * completed, or reassigned elsewhere (e.g. task removed after finishing).
   * listWaits() throws in that case ("not owned by mini tool ..."); treat any
   * such failure as "the session is gone", not as a transient error to retry. */
  const listWaitsSafe = async (sessionId: string): Promise<finch.SessionWait[] | undefined> => {
    try {
      return await ctx.sessions.listWaits(sessionId);
    } catch (error) {
      ctx.logger.debug('session for pending wait is no longer accessible', { sessionId, error: String(error) });
      return undefined;
    }
  };

  /**
   * Remove mappings whose cards have already settled in Finch, or whose
   * backing session no longer exists. Without this, stale/deleted tasks make
   * every future natural-language answer look ambiguous, or worse, crash the
   * inbound handler when listWaits() throws for a gone session.
   */
  const getLivePendingWaits = async (accountId: string, peerId: string): Promise<{ pending: PendingWaitRecord; wait: finch.SessionWait }[]> => {
    const codes = (await ctx.storage.get<string[]>(waitIndexKey(accountId, peerId))) ?? [];
    const live: { pending: PendingWaitRecord; wait: finch.SessionWait }[] = [];
    for (const code of codes) {
      const pending = await ctx.storage.get<PendingWaitRecord>(`${WAIT_PREFIX}${code}`);
      if (!pending || pending.peerId !== peerId || pending.accountId !== accountId) {
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
    await ctx.storage.set(waitIndexKey(accountId, peerId), live.map((entry) => entry.pending.code));
    return live;
  };

  const cleanDelegatedAnswer = (value: string): string =>
    value.trim().replace(/^用户回答\s*[：:]\s*/i, '').trim();

  /** Parse one human reply against the actual live card, never as a new turn. */
  const responseForWait = (
    wait: finch.SessionWait,
    rawValue: string,
  ): { response?: finch.SessionWaitResponse; error?: string } => {
    const value = cleanDelegatedAnswer(rawValue);
    if (wait.kind === 'permission') {
      if (/^(允许|同意|allow|yes|y)(?:[，,：:\s].*)?$/i.test(value)) {
        // An irreversible action is approvable from WeChat because this mini tool
        // holds permissions.destructiveInteractions and the human on the other end
        // is the one replying — the relayed message always shows the exact command
        // being approved. Finch still audits every such approval.
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
      const detail = describePermissionInput(wait);
      const deadline = deadlineLine(wait, 'permission');
      return [
        wait.destructive ? waitText('destructive.title') : waitText('permission.title'),
        waitText('operation', { operation }),
        ...(detail ? [detail] : []),
        wait.destructive ? waitText('destructive.reply') : waitText('permission.reply'),
        ...(deadline ? [deadline] : []),
      ].join('\n');
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
    const formDeadline = deadlineLine(wait, 'form');
    return [
      waitText('form.title'),
      wait.form.title,
      details,
      waitText('form.reply'),
      ...(formDeadline ? [formDeadline] : []),
    ].join('\n');
  };

  /**
   * Tool input can be a whole file body (Write/Edit), so never relay it unbounded.
   */
  const clipDetail = (value: string, max = 400): string =>
    value.length > max ? `${value.slice(0, max)}…` : value;

  /**
   * What the permission request would actually run. A human cannot decide from a
   * tool name alone: Bash is the common case and the command is the part that
   * matters, so anything else falls back to a compact, clipped view of the
   * arguments (a file path, a server URL, …).
   */
  const describePermissionInput = (wait: Extract<finch.SessionWait, { kind: 'permission' }>): string | undefined => {
    const input = wait.toolInput;
    if (!input || typeof input !== 'object') return undefined;
    const record = input as Record<string, unknown>;
    const command = record.command;
    if (typeof command === 'string' && command.trim()) {
      return waitText('command', { command: clipDetail(command) });
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(record);
    } catch {
      return undefined;
    }
    if (!serialized || serialized === '{}') return undefined;
    return waitText('arguments', { arguments: clipDetail(serialized) });
  };

  /**
   * Minutes left before Finch settles an unanswered wait on its own (permission
   * cards are auto-denied, forms auto-cancelled). Undefined when there is no
   * deadline or it already passed — the resolved event covers that case.
   */
  const deadlineLine = (wait: finch.SessionWait, kind: 'permission' | 'form'): string | undefined => {
    if (!wait.expiresAt) return undefined;
    const remainingMs = Date.parse(wait.expiresAt) - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return undefined;
    return waitText(`${kind}.deadline`, { minutes: String(Math.max(1, Math.round(remainingMs / 60_000))) });
  };

  /** One-line summary used when listing several pending waits to choose from. */
  const summarizeWait = (wait: finch.SessionWait): string => {
    if (wait.kind === 'permission') {
      const base = wait.toolTitle ?? wait.toolName;
      const detail = describePermissionInput(wait);
      // Two cards for the same tool would otherwise be indistinguishable in the list.
      return detail ? `${base} · ${clipDetail(detail.split('\n')[0], 60)}` : base;
    }
    if (wait.kind === 'question') return wait.questions[0]?.question ?? wait.questions[0]?.header ?? '';
    return wait.form.title;
  };

  const relayWait = async (accountId: string, peerId: string, event: Extract<finch.SessionBridgeEvent, { type: 'turn.waiting' }>) => {
    if (event.wait.kind === 'form' && event.wait.form.fields.some((field) => field.secret || field.type === 'password')) {
      await media.sendText(accountId, peerId, renderWait(event.wait) ?? waitText('fallback'));
      return;
    }
    if (event.wait.kind === 'form' && !event.wait.form.fields.some((field) => field.type !== 'link')) return;

    const existingCodes = (await ctx.storage.get<string[]>(waitIndexKey(accountId, peerId))) ?? [];
    for (const code of existingCodes) {
      const existing = await ctx.storage.get<PendingWaitRecord>(`${WAIT_PREFIX}${code}`);
      if (existing?.sessionId === event.sessionId && existing.requestId === event.requestId) return;
    }

    const code = randomHex(3);
    const pending: PendingWaitRecord = {
      code, peerId, accountId, sessionId: event.sessionId, requestId: event.requestId, kind: event.wait.kind,
      ...(event.wait.kind === 'question' ? { questionHeaders: event.wait.questions.map((question) => question.header) } : {}),
      ...(event.wait.kind === 'form' ? { formFields: event.wait.form.fields.filter((field) => field.type !== 'link').map((field) => ({ key: field.key, type: field.type })) } : {}),
    };
    await ctx.storage.set(`${WAIT_PREFIX}${code}`, pending);
    await ctx.storage.set(waitIndexKey(accountId, peerId), [...existingCodes, code]);
    await media.sendText(accountId, peerId, renderWait(event.wait) ?? waitText('fallback'));
  };

  const respondToPendingWait = async (accountId: string, peerId: string, text: string): Promise<boolean> => {
    const match = text.trim().match(/^#([0-9a-f]{6})\s+([\s\S]+)$/i);
    let pending: PendingWaitRecord | undefined;
    let wait: finch.SessionWait | undefined;
    let value: string;
    if (match) {
      pending = await ctx.storage.get<PendingWaitRecord>(`${WAIT_PREFIX}${match[1].toLowerCase()}`);
      if (!pending || pending.peerId !== peerId || pending.accountId !== accountId) return false;
      value = match[2].trim();
      const waits = await listWaitsSafe(pending.sessionId);
      wait = waits?.find((candidate) => candidate.requestId === pending?.requestId);
      if (!wait) {
        await removePendingWait(pending);
        await media.sendText(accountId, peerId, waitText('expired'));
        return true;
      }
    } else {
      // Natural-language replies are safe only when exactly one real card is
      // outstanding for this WeChat contact. Stale mappings are pruned first.
      const candidates = await getLivePendingWaits(accountId, peerId);
      if (!candidates.length) return false;
      if (candidates.length > 1) {
        const lines = candidates.map((candidate) =>
          waitText('multiplePendingItem', { code: candidate.pending.code, summary: summarizeWait(candidate.wait) }));
        await media.sendText(accountId, peerId, `${waitText('multiplePending')}\n${lines.join('\n')}`);
        return true;
      }
      pending = candidates[0].pending;
      wait = candidates[0].wait;
      value = text.trim();
      if (!value) return true;
    }
    const parsed = responseForWait(wait, value);
    if (!parsed.response) {
      await media.sendText(accountId, peerId, parsed.error ?? waitText('parseFailed'));
      return true;
    }

    const result = await ctx.sessions.respondToWait(pending.sessionId, pending.requestId, parsed.response);
    if (result.state === 'accepted') {
      await removePendingWait(pending);
      await media.sendText(accountId, peerId, waitText('accepted'));
    } else if (result.state === 'stale') {
      // 用户已在桌面端、超时或结束会话时，静默清理旧映射。
      await removePendingWait(pending);
    } else if (result.state === 'forbidden') {
      await removePendingWait(pending);
      ctx.logger.warn('wait response forbidden', { sessionId: pending.sessionId, requestId: pending.requestId, reason: result.reason });
      await media.sendText(accountId, peerId, waitText('forbidden'));
    } else {
      await removePendingWait(pending);
      await media.sendText(accountId, peerId, waitText('expired'));
    }
    return true;
  };

  // ── 入站消息处理 ────────────────────────────────────────────────────────────

  const handleInbound = async (msg: WeixinInboundMessage, account: WeChatAccount) => {
    const peerId = msg.from_user_id;
    if (!peerId) return;
    const identity: IlinkAccount = { baseUrl: account.baseUrl, botId: account.botId, botToken: account.botToken };
    if (!(await contexts.isCurrent(identity))) return;

    const { autoReply } = readConfig();
    if (account.ownerUserId && peerId !== account.ownerUserId) {
      ctx.logger.debug('message is not from the account owner, skip', { accountId: account.id, peerId });
      return;
    }
    if (!account.ownerUserId) {
      account.ownerUserId = peerId;
      account.label = AccountStore.labelFor(peerId, account.label);
      await accounts.save(account);
    }
    await contexts.capture(peerId, msg.context_token, identity);

    let text = media.extractText(msg);
    const attachments = await media.extractAttachments(msg);
    if (!text && attachments.length) {
      const kinds = attachments.map((a) => a.kind === 'image' ? 'image' : 'file').join(', ');
      text = `[WeChat ${kinds}]`;
    }
    if (!text && !attachments.length) return;

    if (text && await respondToPendingWait(account.id, peerId, text)) return;

    const sessionId = await ensureActiveWechatSession(account, peerId, msg.from_nickname);
    const idempotencyKey = `wx:${account.id}:${peerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const receipt = await ctx.sessions.send(sessionId, {
      text, idempotencyKey,
      ...(attachments.length ? { attachments } : {}),
    });

    if (receipt.state === 'rejected') {
      ctx.logger.warn('session queue full', { accountId: account.id, peerId, code: receipt.code });
      if (autoReply) await media.sendText(account.id, peerId, '我现在有点忙，请稍后再试。').catch(() => {});
      return;
    }
    const turnTarget: PeerTarget = { peerId, accountId: account.id };
    await ctx.storage.set(`${TURN_MAP_PREFIX}${receipt.turnId}`, turnTarget);
    if (autoReply) void auth.startTyping(account.id, peerId, msg.context_token);
    state.deliveredCount += 1;
  };

  /** 解析一个会话/任务应回复到哪个账号与联系人；任务优先，回退会话映射。 */
  const resolveTarget = async (sessionId: string, task?: TaskRecord): Promise<PeerTarget | undefined> => {
    const bySession = await ctx.storage.get<PeerTarget>(`${SESSION_MAP_PREFIX}${sessionId}`);
    if (task?.notifyPeerId) {
      const accountId = task.notifyAccountId ?? bySession?.accountId ?? (await accounts.primary())?.id;
      return accountId ? { peerId: task.notifyPeerId, accountId } : undefined;
    }
    return bySession;
  };

  // ── Session 事件 → 微信回复 ─────────────────────────────────────────────────

  ctx.subscriptions.push(
    ctx.sessions.onDidReceiveEvent(async (event) => {
      if (event.type === 'turn.waiting') {
        const task = await tasks.get(event.sessionId);
        if (task) {
          await tasks.handleEvent(event);
          if (task.notifyPeerId) {
            const target = await resolveTarget(event.sessionId, task);
            if (target) await relayWait(target.accountId, target.peerId, event).catch((error) => ctx.logger.error('relay task wait failed', error));
          }
          return;
        }
        const target = await ctx.storage.get<PeerTarget>(`${SESSION_MAP_PREFIX}${event.sessionId}`);
        if (target?.peerId && target.accountId) {
          await relayWait(target.accountId, target.peerId, event).catch((error) => ctx.logger.error('relay session wait failed', error));
        }
        return;
      }

      if (event.type === 'turn.wait_resolved') {
        const task = await tasks.get(event.sessionId);
        await tasks.handleEvent(event);
        const target = await resolveTarget(event.sessionId, task?.notifyPeerId ? task : undefined);
        if (target?.peerId && target.accountId) {
          // 已在其他渠道（桌面端/超时）结算，立即清理映射，避免误判为多个待处理事项。
          const codes = (await ctx.storage.get<string[]>(waitIndexKey(target.accountId, target.peerId))) ?? [];
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

      // Space 任务优先
      if (await tasks.handleEvent(event)) return;

      if (event.type !== 'turn.completed' && event.type !== 'turn.failed') return;
      const { autoReply } = readConfig();
      const turnKey = `${TURN_MAP_PREFIX}${event.turnId}`;
      let target = await ctx.storage.get<PeerTarget>(turnKey);
      await ctx.storage.delete(turnKey);
      if (!target) target = await ctx.storage.get<PeerTarget>(`${SESSION_MAP_PREFIX}${event.sessionId}`);
      if (!target?.peerId || !target.accountId) return;
      const accountId = target.accountId;
      const peerId = target.peerId;

      await auth.stopTyping(accountId, peerId);

      if (event.type === 'turn.failed') {
        ctx.logger.warn('turn failed', { accountId, peerId, code: event.code });
        return;
      }

      const reply = event.outputText.trim();
      if (!reply) return;
      if (!autoReply) {
        ctx.logger.info('autoReply off, not pushing to wechat', { accountId, peerId });
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
          await media.sendText(accountId, peerId, textWithoutImages);
        }

        for (const imgPath of imagePaths) {
          try {
            const data = await readFile(imgPath);
            const fileName = imgPath.split('/').pop() ?? 'image.png';
            await media.sendMediaByMime(accountId, peerId, data, fileName);
            ctx.logger.info('sent image to wechat', { accountId, peerId, path: imgPath });
          } catch (imgError) {
            ctx.logger.warn('failed to send image to wechat', { path: imgPath, error: String(imgError) });
          }
        }

        if (!textWithoutImages && imagePaths.length === 0) {
          await media.sendText(accountId, peerId, reply);
        }
        ctx.logger.info('replied to wechat', { accountId, peerId, chars: reply.length, images: imagePaths.length });
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        ctx.logger.error('reply to wechat failed', error);
        toast('微信回复失败', '消息暂时无法发送，请稍后重试。', 'error');
      }
    }),
  );

  // ── 长轮询收消息 ────────────────────────────────────────────────────────────

  const messageLoop = async (accountId: string, loop: AccountLoopState) => {
    ctx.logger.info('wechat message loop started', { accountId });

    while (!loop.stop) {
      try {
        const account = await accounts.get(accountId);
        if (!account) {
          ctx.logger.info('account no longer logged in, stopping message loop', { accountId });
          break;
        }
        const identity: IlinkAccount = { baseUrl: account.baseUrl, botId: account.botId, botToken: account.botToken };
        const cursor = (await ctx.storage.get<string>(cursorKey(accountId))) ?? '';
        const resp = await ilink.post<GetUpdatesResponse>(account.baseUrl, 'ilink/bot/getupdates', {
          get_updates_buf: cursor, base_info: ilink.buildBaseInfo(),
        }, account.botToken);
        if (loop.stop || !(await contexts.isCurrent(identity))) continue;

        const failed = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
        if (failed) {
          if (resp.errcode === -14 || resp.ret === -14) {
            ctx.logger.warn('session expired (-14), require re-login', { accountId });
            toast('微信登录已失效', `账号「${account.label}」需要重新扫码登录。`, 'warning');
            stopMessageLoop(accountId);
            await auth.logout(accountId);
            break;
          }
          throw new Error(`getUpdates ret=${resp.ret ?? '-'} errcode=${resp.errcode ?? '-'} ${resp.errmsg ?? ''}`);
        }

        if (resp.get_updates_buf !== undefined) await ctx.storage.set(cursorKey(accountId), resp.get_updates_buf);
        for (const msg of resp.msgs ?? []) {
          try {
            await handleInbound(msg, account);
          } catch (error) {
            await ctx.storage.delete(activeSessionKey(accountId));
            const detail = error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { value: String(error) };
            ctx.logger.error('handle inbound failed', { accountId, peerId: msg.from_user_id, detail });
          }
        }
        loop.backoffIndex = 0;
        loop.lastError = undefined;
      } catch (error) {
        loop.lastError = error instanceof Error ? error.message : String(error);
        ctx.logger.warn('getUpdates failed, backing off', { accountId, error: loop.lastError });
        const delay = RECONNECT_BACKOFF_MS[Math.min(loop.backoffIndex, RECONNECT_BACKOFF_MS.length - 1)];
        loop.backoffIndex += 1;
        await sleep(delay, () => loop.stop);
      }
    }

    loop.running = false;
    ctx.logger.info('wechat message loop stopped', { accountId });
  };

  startMessageLoop = (accountId: string) => {
    const existing = state.loops.get(accountId);
    if (existing?.running) return;
    const loop: AccountLoopState = { running: true, stop: false, backoffIndex: 0, lastError: undefined };
    state.loops.set(accountId, loop);
    void messageLoop(accountId, loop);
  };

  function stopMessageLoop(accountId: string): void {
    const loop = state.loops.get(accountId);
    if (!loop) return;
    loop.stop = true;
    state.loops.delete(accountId);
  }

  // ── 微信 inbox SessionView 菜单 ─────────────────────────────────────────────

  state.settingsMenu = ctx.sessionContainers.registerSettingsMenu(CONTAINER_ID, {
    async getMenu() {
      const list = await accounts.list();
      const items: finch.ComposerActionMenuItem[] = [];
      items.push({
        id: 'status',
        label: '连接状态',
        description: state.loginRunning
          ? state.loginPhase === 'verify' ? '等待输入配对码' : state.loginPhase === 'scanned' ? '已扫码，等待手机确认' : '等待扫码'
          : !list.length
            ? (state.lastError ? '连接异常，请重新登录' : '未登录')
            : `${list.length} 个账号`,
        iconName: wechatIcon(list.some((account) => state.loops.get(account.id)?.running) ? 'satellite-dish' : 'unplug'),
      });

      items.push({ id: 'divider-top', label: '', separator: true });

      if (!list.length) {
        items.push({
          id: 'login', label: '登录微信',
          iconName: wechatIcon('scan-qr-code'),
          hoverText: '扫码登录第一个微信账号，它会成为主账号。',
        });
        return items;
      }

      const accountStatus = (account: WeChatAccount): string => {
        if (state.loginRunning && state.loginTargetAccountId === account.id) {
          return state.loginPhase === 'scanned' ? '已扫码，等待手机确认' : '等待扫码';
        }
        const loop = state.loops.get(account.id);
        if (loop?.running) return '已连接';
        if (loop?.lastError) return '连接异常，可重新连接';
        return '已登录，未在接收';
      };

      for (const account of list) {
        const running = Boolean(state.loops.get(account.id)?.running);
        const children: finch.ComposerActionMenuItem[] = [
          { id: `relogin:${account.id}`, label: '重新登录', iconName: wechatIcon('scan-qr-code') },
        ];
        if (!running) children.push({ id: `reconnect:${account.id}`, label: '重新连接', iconName: wechatIcon('play') });
        children.push({ id: `logout:${account.id}`, label: '登出', iconName: wechatIcon('log-out') });
        items.push({
          id: `account:${account.id}`,
          label: `${account.role === 'primary' ? '主账号' : '子账号'} · ${account.label}`,
          description: accountStatus(account),
          iconName: wechatIcon('wechat'),
          children,
        });
      }

      items.push({ id: 'divider-accounts', label: '', separator: true });
      items.push({
        id: 'add-account', label: '添加子账号',
        iconName: wechatIcon('qr-code'),
        hoverText: '再扫码登录一个微信 Bot 作为子账号；各账号独立收发，互不影响。',
      });
      return items;
    },

    async execute(_menuContext, itemId) {
      try {
        if (itemId === 'status') {
          const list = await accounts.list();
          if (!list.length) {
            ctx.ui.notify(state.lastError ? '微信连接异常，请重新登录。' : '微信尚未登录。', state.lastError ? 'warning' : 'info');
            return;
          }
          const lines = list.map((account) => {
            const running = state.loops.get(account.id)?.running;
            return `${account.role === 'primary' ? '主账号' : '子账号'} ${account.label}：${running ? '已连接' : state.loops.get(account.id)?.lastError ? '连接异常' : '未在接收'}`;
          });
          ctx.ui.notify(`已接收 ${state.deliveredCount} 条消息。\n${lines.join('\n')}`, 'info');
          return;
        }
        if (itemId === 'login' || itemId === 'add-account') return void (await auth.showLoginDialog(undefined));

        const [action, accountId] = itemId.split(':');
        if (!accountId) return;
        if (action === 'relogin') return void (await auth.showLoginDialog(accountId));
        if (action === 'reconnect') return startMessageLoop(accountId);
        if (action === 'logout') {
          stopMessageLoop(accountId);
          const account = await accounts.get(accountId);
          await auth.logout(accountId);
          toast('已登出微信账号', account?.label, 'info');
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
    description: 'Start a fresh Finch Session for a logged-in WeChat account. The previous Session remains in the WeChat inbox, while subsequent WeChat messages for that account use the new Session. Defaults to the primary account.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional title for the new Session.' },
        account: { type: 'string', description: 'Optional account id or label. Defaults to the primary account.' },
      },
    },
    defaultEnabled: true,
    risk: 'medium',
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { title?: unknown; account?: unknown };
      const requestedTitle = typeof input.title === 'string' ? input.title.trim() : '';
      const requestedAccount = typeof input.account === 'string' ? input.account.trim() : '';
      const list = await accounts.list();
      const account = requestedAccount
        ? list.find((a) => a.id === requestedAccount || a.label === requestedAccount)
        : (list.find((a) => a.role === 'primary') ?? list[0]);
      if (!account || !account.ownerUserId) {
        return { content: [{ type: 'text', text: 'No logged-in WeChat account is available.' }], isError: true };
      }
      try {
        const previousSessionId = await ctx.storage.get<string>(activeSessionKey(account.id));
        const sessionId = await createWechatSession(account, account.ownerUserId, requestedTitle || undefined);
        ctx.logger.info('created fresh wechat session', { accountId: account.id, previousSessionId, sessionId });
        return {
          content: [{
            type: 'text',
            text: `A new WeChat Session is active for account ${account.label}. New sessionId: ${sessionId}. The previous Session remains in the inbox.`,
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
    description: 'Send a text message, image, or file to WeChat. Omit account to use the primary account; omit recipient to use that account the QR login completed with. Provide account as an account id or label to send from a specific account, and a known WeChat userId as recipient. To send media, provide filePath (local file path) or imageUrl (remote URL to download). The message parameter serves as caption when sending media. The recipient must first message that same bot to establish message context. QR login alone does not establish send readiness.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text message to send, or caption when sending media.' },
        recipient: { type: 'string', description: 'Optional WeChat userId. Defaults to the account that completed QR login.' },
        account: { type: 'string', description: 'Optional account id or label to send from. Defaults to the primary account.' },
        filePath: { type: 'string', description: 'Local file path to send as media (image/video/file). Type is auto-detected from extension.' },
        imageUrl: { type: 'string', description: 'Remote URL to download and send as media. Type is auto-detected from Content-Type or URL.' },
      },
      required: [],
    },
    defaultEnabled: true,
    risk: 'medium',
    callDisplay: { inline: { mode: 'single', fields: [{ path: 'recipient', label: '发送给' }] } },
    async execute(rawInput, exec): Promise<finch.ToolResult> {
      return executeWechatSend(ctx, media, accounts, rawInput, exec.signal);
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
        notifyPeerId: { type: 'string', description: 'create: optional WeChat userId for result/wait notifications; defaults to the primary account\'s owner.' },
        account: { type: 'string', description: 'create: optional account id or label whose owner receives notifications; defaults to the primary account.' },
        waitMs: { type: 'number', minimum: 0, maximum: 600000, description: 'status with taskId: optional wait time; returns immediately by default.' },
      },
      required: ['action'],
    },
    defaultEnabled: true,
    risk: 'medium',
    async execute(rawInput): Promise<finch.ToolResult> {
      const input = rawInput as { action?: unknown; spaceId?: unknown; taskId?: unknown; message?: unknown; title?: unknown; notifyPeerId?: unknown; account?: unknown; waitMs?: unknown };
      const taskAction = typeof input.action === 'string' ? input.action : '';
      const spaceId = typeof input.spaceId === 'string' ? input.spaceId.trim() : '';
      const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const requestedNotifyPeerId = typeof input.notifyPeerId === 'string' ? input.notifyPeerId.trim() : '';
      const requestedAccount = typeof input.account === 'string' ? input.account.trim() : '';
      const accountList = await accounts.list();
      const notifier = requestedAccount
        ? accountList.find((account) => account.id === requestedAccount || account.label === requestedAccount)
        : (accountList.find((account) => account.role === 'primary') ?? accountList[0]);
      const notifyPeerId = requestedNotifyPeerId || notifier?.ownerUserId || '';
      const notifyAccountId = notifier?.id || '';
      const waitMs = typeof input.waitMs === 'number' && Number.isFinite(input.waitMs) ? Math.max(0, input.waitMs) : 0;

      if (taskAction === 'send') {
        if (!taskId || !message) return { content: [{ type: 'text', text: 'send requires taskId and message.' }], isError: true };
        const task = await tasks.get(taskId);
        if (!task) return { content: [{ type: 'text', text: `Task not found: ${taskId}` }], isError: true };

        // A waiting card owns the current turn. Sending a new Session message
        // here would only create a pending turn behind it and leave the card
        // unresolved. Treat this tool action as an answer first.
        const waits = await listWaitsSafe(task.sessionId);
        if (waits === undefined) {
          await tasks.remove(taskId);
          return { content: [{ type: 'text', text: `Task ${taskId} no longer exists (its Session was deleted or completed elsewhere); the task record was removed.` }], isError: true };
        }
        if (waits.length > 0) {
          if (waits.length > 1) {
            return {
              content: [{ type: 'text', text: `Task ${taskId} has multiple pending questions. Answer from the WeChat prompt with its #code.` }],
              isError: true,
            };
          }
          const parsed = responseForWait(waits[0], message);
          if (!parsed.response) {
            return { content: [{ type: 'text', text: parsed.error ?? 'Invalid answer.' }], isError: true };
          }
          const result = await ctx.sessions.respondToWait(
            task.sessionId,
            waits[0].requestId,
            parsed.response,
          );
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
        // No taskId: return a compact index only (no output text), optionally
        // scoped to one Space. Pass taskId in a follow-up call for full detail.
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
        const session = await ctx.sessions.create({
          space: { spaceId },
          ...(title ? { title } : {}),
          permissionMode: 'acceptCalls',
        });
        const now = Date.now();
        const task: TaskRecord = {
          sessionId: session.sessionId, spaceId,
          title: title || undefined, notifyPeerId: notifyPeerId || undefined,
          notifyAccountId: notifyAccountId || undefined,
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
      for (const loop of state.loops.values()) loop.stop = true;
      state.loops.clear();
      auth.clearTypingTimers();
    },
  });

  // 启动时若已有账号，自动恢复每个账号的接收。
  const startupAccounts = await accounts.list();
  for (const account of startupAccounts) startMessageLoop(account.id);

  ctx.logger.info('WeChat Bot activated', {
    app: appInfo.versionDisplay,
    accounts: startupAccounts.length,
  });
}

export function deactivate(): void {
  // 订阅在 ctx.subscriptions 中自动清理；循环标志会终止轮询。
}
