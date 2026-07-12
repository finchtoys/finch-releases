import type * as finch from 'finch';

export function activate(ctx: finch.ExtensionContext): void {
  ctx.logger.info('Chrome DevTools extension activated.');
}
