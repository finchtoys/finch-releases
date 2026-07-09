import type * as finch from 'finch';

const ACTIVE_BADGE = '计划中';
const INACTIVE_ICON = 'clipboard';
const ACTIVE_ICON = 'clipboard-check';
const REMINDER = 'Planning only — output a plan, do not execute any tools or side effects this turn.';

// Per-session enabled state (in-memory, keyed by sessionId).
const sessionState = new Map<string, boolean>();

// Home page: one-shot planning flag.
let homePlanningEnabled = false;

// Last known sessionId from any callback that receives one reliably.
// Used as a fallback when getBadge/getIcon are called without sessionId.
// When a sessionId IS provided to getBadge/getIcon, it overrides this value,
// so switching sessions (if runtime passes the new sessionId) is handled
// automatically. If runtime never passes sessionId to getBadge/getIcon,
// the Finch source needs to call notifyUpdate() on session switch so we
// re-fetch with the right context.
let activeSessionId: string | undefined;

function storageKey(sessionId: string): string {
  return `enabled:${sessionId}`;
}

// Returns the effective sessionId: prefer explicit, fall back to last known.
// Also updates activeSessionId whenever a fresh sessionId is seen.
function resolveSession(sessionId: string | undefined): string | undefined {
  if (sessionId) {
    if (sessionId !== activeSessionId) {
      // Session changed — runtime did pass the new id.
      activeSessionId = sessionId;
    }
    return sessionId;
  }
  // Runtime didn't pass sessionId; use last known as fallback.
  return activeSessionId;
}

function isEnabled(sessionId: string | undefined): boolean {
  const id = resolveSession(sessionId);
  return id !== undefined && sessionState.get(id) === true;
}

export function activate(ctx: finch.ExtensionContext): void {
  const action = ctx.composerActions.register('plan-mode', {

    async getBadge({ surface, sessionId, cwd }) {
      ctx.logger.info('getBadge called', { surface, sessionId, cwd, activeSessionId });
      if (surface === 'home') {
        return homePlanningEnabled ? { text: ACTIVE_BADGE, active: true } : undefined;
      }
      const resolved = resolveSession(sessionId);
      const enabled = isEnabled(resolved);
      return enabled ? { text: ACTIVE_BADGE, active: true } : undefined;
    },

    async getIcon({ surface, sessionId }) {
      if (surface === 'home') {
        return homePlanningEnabled ? ACTIVE_ICON : INACTIVE_ICON;
      }
      const resolved = resolveSession(sessionId);
      const enabled = isEnabled(resolved);
      ctx.logger.info('getIcon', { sessionId, resolved, activeSessionId, enabled });
      return enabled ? ACTIVE_ICON : INACTIVE_ICON;
    },

    async onClick({ surface, sessionId }) {
      ctx.logger.info('onClick', { surface, sessionId });

      // ── Home: one-shot toggle ──────────────────────────────────────────────
      if (surface === 'home') {
        homePlanningEnabled = !homePlanningEnabled;
        action.notifyUpdate();
        void ctx.ui.showToast({
          title: homePlanningEnabled ? '已进入计划' : '已退出计划',
          description: homePlanningEnabled
            ? '首页下一条消息将以计划模式发送，发送后会自动关闭。'
            : '已取消首页下一条消息的计划模式。',
          variant: homePlanningEnabled ? 'info' : 'default',
          position: 'TC',
        }).catch(() => undefined);
        return;
      }

      // ── Session: per-session persistent toggle ─────────────────────────────
      if (!sessionId) {
        ctx.logger.warn('onClick called without sessionId in session surface');
        return;
      }

      // onClick always carries the correct sessionId — update activeSessionId.
      activeSessionId = sessionId;

      const next = !isEnabled(sessionId);
      sessionState.set(sessionId, next);
      ctx.logger.info('toggled', { sessionId, next });
      action.notifyUpdate();

      void ctx.storage.set(storageKey(sessionId), next).catch((err) => {
        ctx.logger.warn('failed to persist plan mode state', err);
      });

      void ctx.ui.showToast({
        title: next ? '已进入计划' : '已退出计划',
        description: next
          ? '当前会话后续每轮消息都会自动附加"仅规划、不执行工具"的隐藏提醒。'
          : '当前会话已停止自动注入 planning reminder。',
        variant: next ? 'info' : 'default',
        position: 'TC',
      }).catch(() => undefined);
    },

    async getReminder({ surface, sessionId }) {
      // ── Home: one-shot, auto-clear after injection ─────────────────────────
      if (surface === 'home') {
        if (!homePlanningEnabled) return undefined;
        homePlanningEnabled = false;
        queueMicrotask(() => action.notifyUpdate());
        return REMINDER;
      }

      // ── Session: getReminder is called with the correct context reliably ───
      // Use it to update activeSessionId so getBadge/getIcon fallback stays current.
      if (sessionId) activeSessionId = sessionId;
      const resolved = resolveSession(sessionId);
      const enabled = isEnabled(resolved);
      ctx.logger.info('getReminder', { sessionId, resolved, enabled });
      return enabled ? REMINDER : undefined;
    },
  });

  ctx.subscriptions.push(action);
  ctx.logger.info('activated');
}

export function deactivate(): void {}
