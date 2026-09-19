import type * as finch from 'finch';
import type { AppRequest, HostMessage } from '../shared/types.js';
import { AgentTeamOrchestrator } from './orchestrator.js';
import { TeamStore } from './store.js';

export async function activate(ctx: finch.MiniToolContext): Promise<void> {
  ctx.logger.info('Agent Team activating');
  const store = new TeamStore(ctx);
  const orchestrator = new AgentTeamOrchestrator(ctx, store);
  await orchestrator.initialize();

  const panels = new Map<string, finch.AppPanel>();
  const broadcast = async (message: HostMessage): Promise<void> => {
    await Promise.allSettled([...panels.values()].map((panel) => panel.postMessage(message)));
  };
  ctx.subscriptions.push(store.subscribe((snapshot) => broadcast({ type: 'agent-team:snapshot', snapshot })));

  ctx.subscriptions.push(ctx.ui.onDidOpenPanel((panel) => {
    if (panel.view !== 'appView' || panels.has(panel.id)) return;
    panels.set(panel.id, panel);
    ctx.subscriptions.push(panel.onDidDispose(() => panels.delete(panel.id)));
    ctx.subscriptions.push(panel.onDidReceiveMessage((raw) => {
      void (async () => {
        const message = raw as Partial<AppRequest>;
        if (typeof message.type !== 'string' || !message.type.startsWith('agent-team:')) return;
        try {
          const notice = await orchestrator.handleRequest(message as AppRequest);
          if (notice) await panel.postMessage({ type: 'agent-team:notice', message: notice, variant: 'success' } satisfies HostMessage);
        } catch (error) {
          const description = error instanceof Error ? error.message : String(error);
          ctx.logger.error('Agent Team App View action failed', error);
          await panel.postMessage({ type: 'agent-team:error', message: description } satisfies HostMessage).catch(() => undefined);
        }
      })();
    }));
    void panel.postMessage({ type: 'agent-team:snapshot', snapshot: store.snapshot() } satisfies HostMessage).catch(() => undefined);
  }));

  ctx.logger.info('Agent Team activated');
}

export function deactivate(): void {
  // Finch disposes every registered subscription.
}
