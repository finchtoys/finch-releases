import type * as finch from 'finch';

const INACTIVE_ICON = 'clipboard';
const ACTIVE_ICON = 'clipboard-check';

const REMINDER =
  'You are in Planning Mode. This turn: output a structured plan only. ' +
  'Do NOT execute any tools, write any files, or perform side effects. ' +
  'Wait for the user to confirm before acting.';

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
const knownSessions = new Set<string>();

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
      // 首次见到这个 sessionId：如果 home 有未消费的计划态，继承给这个新 session
      if (sessionId && !knownSessions.has(sessionId)) {
        knownSessions.add(sessionId);
        if (pendingNewSessionPlan) {
          pendingNewSessionPlan = false;
          setEnabled(sessionId, true);
          void ctx.storage.set(storageKey(sessionId), true).catch(() => undefined);
          queueMicrotask(() => action.notifyUpdate());
        }
      }
      return isEnabled(sessionId) ? { text: t('badge.active'), active: true } : undefined;
    },

    // ── Icon ──────────────────────────────────────────────────────────────
    async getIcon({ surface, sessionId }) {
      if (surface === 'home') {
        return homePlanningEnabled ? ACTIVE_ICON : INACTIVE_ICON;
      }
      return isEnabled(sessionId) ? ACTIVE_ICON : INACTIVE_ICON;
    },

    // ── Click ─────────────────────────────────────────────────────────────
    async onClick({ surface, sessionId }) {
      // Home: one-shot
      if (surface === 'home') {
        homePlanningEnabled = !homePlanningEnabled;
        action.notifyUpdate();
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
      action.notifyUpdate();

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
        pendingNewSessionPlan = true;
        queueMicrotask(() => action.notifyUpdate());
        return REMINDER;
      }
      return isEnabled(sessionId) ? REMINDER : undefined;
    },

    // ── onTurnEnd ─────────────────────────────────────────────────────────
    async onTurnEnd({ surface, sessionId }, actions) {
      ctx.logger.info('onTurnEnd', { surface, sessionId });
      if (surface !== 'session' || !isEnabled(sessionId)) return;

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
  ctx.logger.info('plan-mode activated');
}

export function deactivate(): void {}
