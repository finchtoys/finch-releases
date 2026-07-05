/**
 * Prompt Suggester — 按场景分类的 Composer 提示词建议扩展。
 *
 * 只在非 Session（默认聊天）环境下显示，点击灯泡按钮展开场景分类，
 * 每个场景有二级子菜单列出常用 Prompt，选中后填入 Composer 输入框。
 */
import type * as finch from 'finch';

/** 一个场景分类，包含二级提示词建议。 */
interface Scenario {
  id: string;
  labelKey: string;
  icon: string;
  children: PromptItem[];
}

/** 单个提示词建议。 */
interface PromptItem {
  id: string;
  labelKey: string;
  descKey: string;
  promptKey: string;
}

// ── 场景定义（只存 i18n key，运行时通过 ctx.i18n.t() 解析）───────────────

const scenarios: Scenario[] = [
  {
    id: 'dev',
    labelKey: 'scenario.dev',
    icon: 'braces',
    children: [
      { id: 'code-review',   labelKey: 'suggestion.code-review',   descKey: 'suggestion.code-review.desc',   promptKey: 'suggestion.code-review.prompt' },
      { id: 'code-explain',  labelKey: 'suggestion.code-explain',  descKey: 'suggestion.code-explain.desc',  promptKey: 'suggestion.code-explain.prompt' },
      { id: 'debug',         labelKey: 'suggestion.debug',         descKey: 'suggestion.debug.desc',         promptKey: 'suggestion.debug.prompt' },
      { id: 'refactor',      labelKey: 'suggestion.refactor',      descKey: 'suggestion.refactor.desc',      promptKey: 'suggestion.refactor.prompt' },
      { id: 'write-test',    labelKey: 'suggestion.write-test',    descKey: 'suggestion.write-test.desc',    promptKey: 'suggestion.write-test.prompt' },
      { id: 'optimize',      labelKey: 'suggestion.optimize',      descKey: 'suggestion.optimize.desc',      promptKey: 'suggestion.optimize.prompt' },
    ],
  },
  {
    id: 'writing',
    labelKey: 'scenario.writing',
    icon: 'notebook-pen',
    children: [
      { id: 'write-article',  labelKey: 'suggestion.write-article',  descKey: 'suggestion.write-article.desc',  promptKey: 'suggestion.write-article.prompt' },
      { id: 'polish',         labelKey: 'suggestion.polish',         descKey: 'suggestion.polish.desc',         promptKey: 'suggestion.polish.prompt' },
      { id: 'translate-cn',   labelKey: 'suggestion.translate-cn',   descKey: 'suggestion.translate-cn.desc',   promptKey: 'suggestion.translate-cn.prompt' },
      { id: 'translate-en',   labelKey: 'suggestion.translate-en',   descKey: 'suggestion.translate-en.desc',   promptKey: 'suggestion.translate-en.prompt' },
      { id: 'brainstorm',     labelKey: 'suggestion.brainstorm',     descKey: 'suggestion.brainstorm.desc',     promptKey: 'suggestion.brainstorm.prompt' },
    ],
  },
  {
    id: 'learning',
    labelKey: 'scenario.learning',
    icon: 'book',
    children: [
      { id: 'explain-concept', labelKey: 'suggestion.explain-concept', descKey: 'suggestion.explain-concept.desc', promptKey: 'suggestion.explain-concept.prompt' },
      { id: 'summarize',       labelKey: 'suggestion.summarize',       descKey: 'suggestion.summarize.desc',       promptKey: 'suggestion.summarize.prompt' },
      { id: 'research',        labelKey: 'suggestion.research',        descKey: 'suggestion.research.desc',        promptKey: 'suggestion.research.prompt' },
      { id: 'tutorial',        labelKey: 'suggestion.tutorial',        descKey: 'suggestion.tutorial.desc',        promptKey: 'suggestion.tutorial.prompt' },
      { id: 'compare',         labelKey: 'suggestion.compare',         descKey: 'suggestion.compare.desc',         promptKey: 'suggestion.compare.prompt' },
    ],
  },
  {
    id: 'file',
    labelKey: 'scenario.file',
    icon: 'file-text',
    children: [
      { id: 'analyze-data',  labelKey: 'suggestion.analyze-data',  descKey: 'suggestion.analyze-data.desc',  promptKey: 'suggestion.analyze-data.prompt' },
      { id: 'convert-format', labelKey: 'suggestion.convert-format', descKey: 'suggestion.convert-format.desc', promptKey: 'suggestion.convert-format.prompt' },
      { id: 'extract-info',  labelKey: 'suggestion.extract-info',  descKey: 'suggestion.extract-info.desc',  promptKey: 'suggestion.extract-info.prompt' },
    ],
  },
  {
    id: 'daily',
    labelKey: 'scenario.daily',
    icon: 'zap',
    children: [
      { id: 'write-email', labelKey: 'suggestion.write-email', descKey: 'suggestion.write-email.desc', promptKey: 'suggestion.write-email.prompt' },
      { id: 'organize',    labelKey: 'suggestion.organize',    descKey: 'suggestion.organize.desc',    promptKey: 'suggestion.organize.prompt' },
      { id: 'quick-qna',   labelKey: 'suggestion.quick-qna',   descKey: 'suggestion.quick-qna.desc',   promptKey: 'suggestion.quick-qna.prompt' },
    ],
  },
];

// ── 扩展激活 ──────────────────────────────────────────────────────────────

export function activate(ctx: finch.ExtensionContext): void {
  ctx.logger.info('prompt-suggester activated');

  ctx.subscriptions.push(
    ctx.composerActions.register('prompt-suggester', {
      async getBadge({ surface }) {
        if (surface !== 'home') throw new Error('仅在 Home 页显示');
        return '💡';
      },

      async getIcon({ surface }) {
        if (surface !== 'home') throw new Error('仅在 Home 页显示');
        return 'lightbulb';
      },

      async getMenu() {
        return scenarios.map((scenario) => ({
          id: scenario.id,
          label: ctx.i18n.t(scenario.labelKey),
          iconName: scenario.icon,
          children: scenario.children.map((item) => ({
            id: `${scenario.id}/${item.id}`,
            label: ctx.i18n.t(item.labelKey),
            description: ctx.i18n.t(item.descKey),
            iconName: 'message-circle',
          })),
        }));
      },

      async execute(_ctx, itemId, actions) {
        for (const scenario of scenarios) {
          for (const item of scenario.children) {
            if (`${scenario.id}/${item.id}` === itemId) {
              await actions.fillComposer(ctx.i18n.t(item.promptKey));
              return;
            }
          }
        }
        ctx.logger.warn('unknown prompt item', itemId);
      },
    }),
  );
}

export function deactivate(): void {
  // ctx.subscriptions 自动清理
}
