import type * as finch from 'finch';

const INACTIVE_ICON = 'clipboard';
const ACTIVE_ICON = 'clipboard-check';

const REMINDER =
  'You are in Planning Mode: investigate first, then plan. ' +
  'Allowed this turn — read-only work: read files, grep/glob, list directories, ' +
  'read-only commands (git status/log/diff, ls, cat) and web search or page fetch. ' +
  'Not allowed — writing or editing files, running anything with side effects ' +
  '(installs, git commit, migrations, sending anything out), or changing anything outside this conversation. ' +
  'Do the investigation now. Do NOT output a list of steps you would take to investigate: ' +
  'report what you actually found, citing the exact file paths, symbols and line numbers you read. ' +
  'Then give a concrete plan grounded in those findings, and list the open questions and risks the user must decide. ' +
  'Wait for the user to confirm before executing.';

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

/**
 * 取某个 session 的计划态：内存 → storage → 全新 session 才继承 home 的一次性计划态。
 * 「全新」的判据是 storage 里没这个 key，而不是「内存里没见过」——后者会让 reload
 * 后所有 session 都被当成新的，把 pending 消费到错误的 session 上。
 */
async function resolveEnabled(
  ctx: finch.ExtensionContext,
  sessionId: string | undefined,
): Promise<boolean> {
  if (!sessionId) return false;
  if (sessionState.has(sessionId)) return sessionState.get(sessionId) === true;

  const stored = await ctx.storage.get<boolean>(storageKey(sessionId)).catch(() => undefined);
  if (stored === true || stored === false) {
    sessionState.set(sessionId, stored);
    return stored;
  }

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

// ── Activation ────────────────────────────────────────────────────────────────
export function activate(ctx: finch.ExtensionContext): void {
  // 拉取助手名称，缓存在内存里，fallback 到 'Finch'
  let assistantName = 'Finch';
  void ctx.app.getInfo().then((info) => { assistantName = info.assistantName; }).catch(() => undefined);

  const t = (key: string, extra?: Record<string, string>) =>
    ctx.i18n.t(key, { assistantName, ...extra });

  const action = ctx.composerActions.register('plan-mode', {

    // ── Badge ─────────────────────────────────────────────────────────────
    async getBadge({ surface, sessionId, cwd }) {
      ctx.logger.info('getBadge', { surface, sessionId, cwd });
      if (surface === 'home') {
        return homePlanningEnabled ? { text: t('badge.active'), active: true } : undefined;
      }
      // 首次见到这个 sessionId：从 storage 回读，或继承 home 的一次性计划态。
      return (await resolveEnabled(ctx, sessionId)) ? { text: t('badge.active'), active: true } : undefined;
    },

    // ── Icon ──────────────────────────────────────────────────────────────
    async getIcon({ surface, sessionId }) {
      if (surface === 'home') {
        return homePlanningEnabled ? ACTIVE_ICON : INACTIVE_ICON;
      }
      return (await resolveEnabled(ctx, sessionId)) ? ACTIVE_ICON : INACTIVE_ICON;
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
    async getReminder({ surface, sessionId }) {
      if (surface === 'home') {
        if (!homePlanningEnabled) return undefined;
        homePlanningEnabled = false;
        // pendingNewSessionPlan 已在 onClick 时提前设好，此处只需清 home 高亮
        queueMicrotask(() => action.notifyUpdate());
        return REMINDER;
      }
      return (await resolveEnabled(ctx, sessionId)) ? REMINDER : undefined;
    },

    // ── onTurnEnd ─────────────────────────────────────────────────────────
    async onTurnEnd({ surface, sessionId }, actions) {
      ctx.logger.info('onTurnEnd', { surface, sessionId });
      if (surface !== 'session' || !(await resolveEnabled(ctx, sessionId))) return;

      const result = await actions.composer.confirm({
        text: t('confirm.text'),
        confirmLabel: t('confirm.label'),
        cancelLabel: t('confirm.cancel'),
      });

      if (result === 'confirm') {
        setEnabled(sessionId!, false);
        action.notifyUpdate();
        void ctx.storage.set(storageKey(sessionId!), false).catch(() => undefined);
        await actions.composer.fill(t('execute.prompt'));
      }
    },
  });

  ctx.subscriptions.push(action);
  notifyBadge = () => action.notifyUpdate();
  ctx.logger.info('plan-mode activated');
}

export function deactivate(): void {}
