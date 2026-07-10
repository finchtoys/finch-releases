import type * as finch from 'finch';

interface OfficeAction {
  id: string;
  labelKey: string;
  descriptionKey: string;
  promptKey: string;
  icon: string;
}

const actions: OfficeAction[] = [
  { id: 'word', labelKey: 'action.word.label', descriptionKey: 'action.word.description', promptKey: 'action.word.prompt', icon: 'file-text' },
  { id: 'pdf', labelKey: 'action.pdf.label', descriptionKey: 'action.pdf.description', promptKey: 'action.pdf.prompt', icon: 'file-type-2' },
  { id: 'slides', labelKey: 'action.slides.label', descriptionKey: 'action.slides.description', promptKey: 'action.slides.prompt', icon: 'presentation' },
  { id: 'spreadsheet', labelKey: 'action.spreadsheet.label', descriptionKey: 'action.spreadsheet.description', promptKey: 'action.spreadsheet.prompt', icon: 'table-2' },
];

export function activate(ctx: finch.ExtensionContext): void {
  ctx.subscriptions.push(
    ctx.composerActions.register('office-suite', {
      async getMenu(): Promise<finch.ComposerActionMenuItem[]> {
        return actions.map((action) => ({
          id: action.id,
          label: ctx.i18n.t(action.labelKey),
          description: ctx.i18n.t(action.descriptionKey),
          iconName: action.icon,
        }));
      },
      async execute(_context, itemId, composer): Promise<void> {
        const action = actions.find((candidate) => candidate.id === itemId);
        if (!action) return;
        await composer.fillComposer(ctx.i18n.t(action.promptKey));
      },
    }),
  );
  ctx.logger.info('Office Suite activated');
}

export function deactivate(): void {}
