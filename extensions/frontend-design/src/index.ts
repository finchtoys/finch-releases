import type * as finch from 'finch';

export function activate(ctx: finch.ExtensionContext): void {
  ctx.subscriptions.push(
    ctx.composerActions.register('frontend-design', {
      async getMenu(): Promise<finch.ComposerActionMenuItem[]> {
        return [
          {
            id: 'design-ui',
            label: ctx.i18n.t('action.design.label'),
            description: ctx.i18n.t('action.design.description'),
            iconName: 'palette',
          },
        ];
      },
      async execute(_context, itemId, composer): Promise<void> {
        if (itemId !== 'design-ui') return;
        await composer.fillComposer(ctx.i18n.t('action.design.prompt'));
      },
    }),
  );
  ctx.logger.info('Frontend Design activated');
}

export function deactivate(): void {}
