import type * as finch from 'finch';

const INACTIVE_ICON = 'clipboard';
const ACTIVE_ICON = 'clipboard-check';

const REMINDER =
  'You are in Planning Mode: this turn is for planning, not for acting. ' +
  'Allowed — read-only work: read files, grep/glob, list directories, ' +
  'read-only commands (git status/log/diff, ls, cat) and web search or page fetch. ' +
  'Not allowed — writing or editing files, running anything with side effects ' +
  '(installs, git commit, migrations, sending anything out). ' +
  'Do the investigation now and ground the plan in what you actually found: cite the exact ' +
  'file paths, symbols and line numbers you read. Do NOT output a list of steps you would ' +
  'take to investigate. ' +
  'When the plan is complete, call the finish_plan tool to ask the user to approve it. ' +
  'Do not ask "shall I proceed?" in plain text, and never start executing on your own — ' +
  'if the user approves, carry the plan out in this same turn; if not, keep refining it.';

// ── Per-session state (in-memory, keyed by sessionId) ────────────────────────
const sessionState = new Map<string, boolean>();

function isEnabled(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return sessionState.get(sessionId) === true;
}

function setEnabled(sessionId: string, enabled: boolean): void {
  sessionState.set(sessionId, enabled);
}

function storageKey(sessionId: string): string {
  return `enabled:${sessionId}`;
}

// ── Home one-shot flag ────────────────────────────────────────────────────────
let homePlanningEnabled = false;

// 当 home 发出计划态消息后，下一个全新 session 应继承计划态。
// getBadge 遇到首次出现的 sessionId 时消费此 flag。
let pendingNewSessionPlan = false;

let notifyBadge: (() => void) | undefined;

// 本轮已经弹过「计划可以执行吗」的会话，避免工具与 onTurnEnd 重复弹两次。
const askedThisTurn = new Set<string>();

/**
 * `confirmAndSend` / `isNewSession` 是较新主程序才有的能力，对应的 SDK 版本尚未
 * 发布。这里用结构类型探测而不是直接依赖新字段，否则按 package.json 装旧 SDK
 * 的人 `npm ci` 后编译不过，旧版 Finch 上也会因为字段不存在而报错。
 */
type ConfirmAndSendResult = {
  choice: 'confirm' | 'cancel' | 'dismissed';
  sent: boolean;
  reason?: string;
};
type ConfirmAndSendCapable = {
  confirmAndSend?: (options: Record<string, unknown>) => Promise<ConfirmAndSendResult>;
};

/** 旧版主程序不会传这个字段，统一从结构类型里取。 */
function isNewSessionOf(ctxArg: unknown): boolean | undefined {
  return (ctxArg as { isNewSession?: boolean } | undefined)?.isNewSession;
}

/**
 * 取某个 session 的计划态：内存 → storage → 全新 session 才继承 home 的一次性计划态。
 * 「全新」的判据是 storage 里没这个 key，而不是「内存里没见过」——后者会让 reload
 * 后所有 session 都被当成新的，把 pending 消费到错误的 session 上。
 */
async function resolveEnabled(
  ctx: finch.MiniToolContext,
  sessionId: string | undefined,
  isNewSession?: boolean,
): Promise<boolean> {
  if (!sessionId) return false;
  if (sessionState.has(sessionId)) return sessionState.get(sessionId) === true;

  const stored = await ctx.storage.get<boolean>(storageKey(sessionId)).catch(() => undefined);
  if (stored === true || stored === false) {
    sessionState.set(sessionId, stored);
    return stored;
  }

  if (isNewSession === false) {
    // 已存在的会话（恢复 / 续跑 / 切回）且没有计划态记录：就是关。
    // 故意不写缓存——乐观 id 可能先以 isNewSession:false 被查一次，
    // 真正绑定后还要再判一遍，缓存会把交接机会吃掉。
    return false;
  }

  // isNewSession === true：主程序明确告诉我们会话刚建出来；
  // undefined 是旧版主程序，没这个字段，只能按「storage 里没这个 key」猜。
  const inherited = pendingNewSessionPlan;
  sessionState.set(sessionId, inherited);
  if (inherited) {
    // 一次性计划态在这里落地：home 的高亮要一起灭，否则会留下
    // 「home 显示计划开、session 却是关」的错觉。
    pendingNewSessionPlan = false;
    homePlanningEnabled = false;
    void ctx.storage.set(storageKey(sessionId), true).catch(() => undefined);
    queueMicrotask(() => notifyBadge?.());
  }
  return inherited;
}

// Composer 点击可能由嵌套元素重复派发；同一 surface 的短时间重复事件只处理一次。
let lastClickKey: string | undefined;
let lastClickAt = 0;
const CLICK_DEDUP_MS = 300;

function isDuplicateClick(surface: string, sessionId: string | undefined): boolean {
  const key = `${surface}:${sessionId ?? ''}`;
  const now = Date.now();
  const duplicate = key === lastClickKey && now - lastClickAt < CLICK_DEDUP_MS;
  lastClickKey = key;
  lastClickAt = now;
  return duplicate;
}

// ── finish_plan tool ──────────────────────────────────────────────────────
/**
 * 模型自己判断「计划写完了」，调这个工具请用户确认。
 *
 * 为什么不用 onTurnEnd：那个事件只在同一 sessionId 内 runStatus 从
 * running|waiting 跳到 done|error 时才发，本轮结束时如果还卡在权限/提问卡上、
 * 或视图挂载时回复已经跑完，就一次都不会弹；反过来它又会在每一轮计划后都弹，
 * 包括模型只是反问了一句澄清的轮次。用工具把「计划就绪」这个意图显式化。
 *
 * 用 requestForm 而不是 composer confirm：工具上下文里拿不到 composer 的
 * confirm 入口（register() 只返回 notifyUpdate），而 requestForm 是现成的原生
 * 确认面。用户点「执行」后工具直接返回「开始执行」，模型同一轮就动手，不需要
 * 再补一条消息。
 */
function registerFinishPlanTool(
  ctx: finch.MiniToolContext,
  t: (key: string, extra?: Record<string, string>) => string,
): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'finish_plan',
      title: t('tool.finishPlan.title'),
      description: t('tool.finishPlan.description'),
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: t('tool.finishPlan.summaryHint'),
          },
        },
      },
      risk: 'low',
      exposure: 'startup',
      defaultEnabled: true,
      async execute(input, toolCtx) {
        const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
        const sessionId = toolCtx.sessionId;

        if (!isEnabled(sessionId)) {
          return text(t('tool.finishPlan.notActive'));
        }
        if (askedThisTurn.has(sessionId)) {
          return text(t('tool.finishPlan.alreadyAsked'));
        }
        askedThisTurn.add(sessionId);

        const raw = (input as { summary?: unknown })?.summary;
        const summary = typeof raw === 'string' ? raw.trim() : '';

        const form = await toolCtx.ui.requestForm({
          title: t('confirm.text'),
          description: summary || undefined,
          submitLabel: t('confirm.label'),
          cancelLabel: t('confirm.cancel'),
          fields: [],
        });

        if (form.submitted) {
          setEnabled(sessionId, false);
          void ctx.storage.set(storageKey(sessionId), false).catch(() => undefined);
          queueMicrotask(() => notifyBadge?.());
          return text(t('tool.finishPlan.approved'));
        }

        askedThisTurn.delete(sessionId);
        if (form.reason === 'background') {
          return text(t('tool.finishPlan.noAnswer', { reason: form.reason }));
        }
        if (form.reason && form.reason !== 'cancelled') {
          return text(t('tool.finishPlan.noAnswer', { reason: form.reason }));
        }
        return text(t('tool.finishPlan.declined'));
      },
    }),
  );
}

// ── Activation ────────────────────────────────────────────────────────────────
export function activate(ctx: finch.MiniToolContext): void {
  // 拉取助手名称，缓存在内存里，fallback 到 'Finch'
  let assistantName = 'Finch';
  void ctx.app.getInfo().then((info) => { assistantName = info.assistantName; }).catch(() => undefined);

  const t = (key: string, extra?: Record<string, string>) =>
    ctx.i18n.t(key, { assistantName, ...extra });

  registerFinishPlanTool(ctx, t);

  const action = ctx.composerActions.register('plan-mode', {

    // ── Badge ─────────────────────────────────────────────────────────────
    async getBadge(ctxArg) {
      const { surface, sessionId, cwd } = ctxArg;
      const isNewSession = isNewSessionOf(ctxArg);
      ctx.logger.info('getBadge', { surface, sessionId, cwd, isNewSession });
      if (surface === 'home') {
        return homePlanningEnabled ? { text: t('badge.active'), active: true } : undefined;
      }
      // 从 storage 回读；新会话由 isNewSession 决定要不要继承 home 的一次性计划态。
      return (await resolveEnabled(ctx, sessionId, isNewSession)) ? { text: t('badge.active'), active: true } : undefined;
    },

    // ── Icon ──────────────────────────────────────────────────────────────
    async getIcon(ctxArg) {
      const { surface, sessionId } = ctxArg;
      const isNewSession = isNewSessionOf(ctxArg);
      if (surface === 'home') {
        return homePlanningEnabled ? ACTIVE_ICON : INACTIVE_ICON;
      }
      return (await resolveEnabled(ctx, sessionId, isNewSession)) ? ACTIVE_ICON : INACTIVE_ICON;
    },

    // ── Click ─────────────────────────────────────────────────────────────
    async onClick({ surface, sessionId }) {
      if (isDuplicateClick(surface, sessionId)) {
        ctx.logger.info('ignored duplicate plan-mode click', { surface, sessionId });
        return;
      }

      // Home: one-shot
      if (surface === 'home') {
        homePlanningEnabled = !homePlanningEnabled;
        // 提前同步 pending flag：确保后续任何时序的 getBadge 都能拿到正确状态
        // 用户若再次点击关闭，同步清掉
        pendingNewSessionPlan = homePlanningEnabled;
        void ctx.ui.showToast({
          title: homePlanningEnabled ? t('toast.enter.title') : t('toast.home.exit.title'),
          description: homePlanningEnabled ? t('toast.home.enter.desc') : t('toast.home.exit.desc'),
          variant: homePlanningEnabled ? 'info' : 'default',
          position: 'TC',
        }).catch(() => undefined);
        return;
      }

      // Session: per-session persistent
      if (!sessionId) return;
      const next = !isEnabled(sessionId);
      setEnabled(sessionId, next);

      void ctx.storage.set(storageKey(sessionId), next).catch((err) => {
        ctx.logger.warn('failed to persist plan mode state', err);
      });

      void ctx.ui.showToast({
        title: next ? t('toast.enter.title') : t('toast.exit.title'),
        description: next ? t('toast.enter.desc') : undefined,
        variant: next ? 'info' : 'default',
        position: 'TC',
      }).catch(() => undefined);
    },

    // ── Reminder ──────────────────────────────────────────────────────────
    async getReminder(ctxArg) {
      const { surface, sessionId } = ctxArg;
      const isNewSession = isNewSessionOf(ctxArg);
      // 新一轮开始：清掉「本轮已问过」标记，允许这一轮再问一次。
      if (sessionId) askedThisTurn.delete(sessionId);
      if (surface === 'home') {
        if (!homePlanningEnabled) return undefined;
        homePlanningEnabled = false;
        // pendingNewSessionPlan 已在 onClick 时提前设好，此处只需清 home 高亮
        queueMicrotask(() => action.notifyUpdate());
        return REMINDER;
      }
      return (await resolveEnabled(ctx, sessionId, isNewSession)) ? REMINDER : undefined;
    },

    // ── onTurnEnd ─────────────────────────────────────────────────────────
    async onTurnEnd({ surface, sessionId }, actions) {
      ctx.logger.info('onTurnEnd', { surface, sessionId });
      if (surface !== 'session' || !(await resolveEnabled(ctx, sessionId))) return;
      // finish_plan 已经问过了就别再弹一遍。
      if (sessionId && askedThisTurn.has(sessionId)) return;

      const turnOff = () => {
        setEnabled(sessionId!, false);
        action.notifyUpdate();
        void ctx.storage.set(storageKey(sessionId!), false).catch(() => undefined);
      };

      const options = {
        text: t('confirm.text'),
        confirmLabel: t('confirm.label'),
        cancelLabel: t('confirm.cancel'),
      };

      // 新版主程序：点「执行」直接开跑，不经过输入框、也不清用户已打的草稿。
      const composer = actions.composer as unknown as ConfirmAndSendCapable;
      const send = composer.confirmAndSend;
      if (typeof send === 'function') {
        const r = await send.call(composer, { ...options, submitText: t('execute.prompt') });
        if (r.sent) {
          turnOff();
          return;
        }
        if (r.choice !== 'confirm') return; // 取消或收起：保持计划模式
        // 用户想执行但宿主拒了（无模型 / 输入被交互卡占用 / 会话不在屏 / 文案非法）。
        // 主程序已经弹过原因，这里退回旧行为：关掉计划模式并把文案填进输入框。
        ctx.logger.warn('plan-mode auto send refused, falling back to fill', { reason: r.reason });
        turnOff();
        await actions.composer.fill(t('execute.prompt'));
        return;
      }

      // 旧版主程序没有 confirmAndSend，只能填进输入框让用户自己按发送。
      const result = await actions.composer.confirm(options);
      if (result === 'confirm') {
        turnOff();
        await actions.composer.fill(t('execute.prompt'));
      }
    },
  });

  ctx.subscriptions.push(action);
  notifyBadge = () => action.notifyUpdate();
  ctx.logger.info('plan-mode activated');
}

export function deactivate(): void {}
