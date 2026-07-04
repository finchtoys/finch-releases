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
  label: string;
  icon: string;
  children: PromptItem[];
}

/** 单个提示词建议。 */
interface PromptItem {
  id: string;
  label: string;
  description: string;
  prompt: string;
}

// ── 场景定义 ──────────────────────────────────────────────────────────────

const scenarios: Scenario[] = [
  {
    id: 'dev',
    label: '编程开发',
    icon: 'braces',
    children: [
      {
        id: 'code-review',
        label: '代码审查',
        description: '检查代码质量与潜在问题',
        prompt: '请仔细审查以下代码，指出潜在问题、代码异味和改进建议：',
      },
      {
        id: 'code-explain',
        label: '代码解释',
        description: '理解代码的功能与设计',
        prompt: '请逐步解释以下代码的功能和设计思路：',
      },
      {
        id: 'debug',
        label: '调试帮助',
        description: '分析错误并给出修复方案',
        prompt: '我遇到了这个错误，请帮我分析原因并给出修复方案：',
      },
      {
        id: 'refactor',
        label: '重构建议',
        description: '提升代码可读性与性能',
        prompt: '请重构以下代码，提高可读性、可维护性和性能：',
      },
      {
        id: 'write-test',
        label: '编写测试',
        description: '生成单元测试覆盖',
        prompt: '为以下代码编写全面的单元测试，覆盖主要场景和边界情况：',
      },
      {
        id: 'optimize',
        label: '性能优化',
        description: '分析并优化代码性能',
        prompt: '请分析以下代码的性能瓶颈，并给出优化建议：',
      },
    ],
  },
  {
    id: 'writing',
    label: '写作创作',
    icon: 'notebook-pen',
    children: [
      {
        id: 'write-article',
        label: '文章撰写',
        description: '生成文章或内容',
        prompt: '请帮我撰写一篇关于',
      },
      {
        id: 'polish',
        label: '文案润色',
        description: '优化文字表达',
        prompt: '请润色以下文案，修正语病，优化表达，使其更流畅专业：',
      },
      {
        id: 'translate-cn',
        label: '译成中文',
        description: '中文化翻译',
        prompt: '请将以下内容翻译成地道的中文，保持原意和语气：',
      },
      {
        id: 'translate-en',
        label: '译成英文',
        description: '英文化翻译',
        prompt: '请将以下内容翻译成地道的英文，保持原意和语气：',
      },
      {
        id: 'brainstorm',
        label: '头脑风暴',
        description: '发散创意与方向',
        prompt: '我们来针对「」进行头脑风暴，从多个角度列出尽可能多的创意方向。\n\n请帮我拆解：',
      },
    ],
  },
  {
    id: 'learning',
    label: '学习研究',
    icon: 'book',
    children: [
      {
        id: 'explain-concept',
        label: '概念解释',
        description: '通俗易懂地解释概念',
        prompt: '请用通俗易懂的语言解释「」，并给出生活中的类比和例子。',
      },
      {
        id: 'summarize',
        label: '文档摘要',
        description: '提炼核心要点',
        prompt: '请总结以下内容的核心理念和关键信息，按要点列出：',
      },
      {
        id: 'research',
        label: '技术调研',
        description: '调研技术方案与趋势',
        prompt: '请调研一下关于「」的前沿技术方案、主流实践和关键对比，给出推荐方向。',
      },
      {
        id: 'tutorial',
        label: '教程生成',
        description: '生成入门教程',
        prompt: '请为「」编写一份适合初学者的入门教程，包含步骤说明和代码示例。',
      },
      {
        id: 'compare',
        label: '对比分析',
        description: '多维度对比方案',
        prompt: '请从功能、性能、学习曲线、生态等维度对比「」和「」，给出选型建议。',
      },
    ],
  },
  {
    id: 'file',
    label: '文件处理',
    icon: 'file-text',
    children: [
      {
        id: 'analyze-data',
        label: '数据分析',
        description: '洞察数据趋势与异常',
        prompt: '请分析以下数据的趋势、异常值和关键洞察，给出结论与建议：',
      },
      {
        id: 'convert-format',
        label: '格式转换',
        description: '数据格式互相转换',
        prompt: '请将下面这份数据转换成',
      },
      {
        id: 'extract-info',
        label: '信息提取',
        description: '提取结构化信息',
        prompt: '请从以下内容中提取关键信息，按结构化方式整理输出：',
      },
    ],
  },
  {
    id: 'daily',
    label: '日常效率',
    icon: 'zap',
    children: [
      {
        id: 'write-email',
        label: '邮件撰写',
        description: '起草专业邮件',
        prompt: '请帮我写一封关于「」的邮件，语气',
      },
      {
        id: 'organize',
        label: '内容整理',
        description: '归纳整理散乱内容',
        prompt: '请帮我整理归纳以下散乱的内容，按逻辑重新组织并提炼要点：',
      },
      {
        id: 'quick-qna',
        label: '快速问答',
        description: '简明回答疑问',
        prompt: '请简要回答：',
      },
    ],
  },
];

// ── 扩展激活 ──────────────────────────────────────────────────────────────

export function activate(ctx: finch.ExtensionContext): void {
  ctx.logger.info('prompt-suggester activated');

  ctx.subscriptions.push(
    ctx.composerActions.register('prompt-suggester', {
      // 只显示在 Home 页（未进入会话时）
      async getBadge({ surface }) {
        if (surface !== 'home') throw new Error('仅在 Home 页显示');
        return '💡';
      },

      async getIcon({ surface }) {
        if (surface !== 'home') throw new Error('仅在 Home 页显示');
        return 'lightbulb';
      },

      async getMenu() {
        // 场景作为一级菜单，每个场景的提示词建议作为二级子菜单
        return scenarios.map((scenario) => ({
          id: scenario.id,
          label: scenario.label,
          iconName: scenario.icon,
          children: scenario.children.map((item) => ({
            id: `${scenario.id}/${item.id}`,
            label: item.label,
            description: item.description,
            iconName: 'message-circle',
          })),
        }));
      },

      async execute(_ctx, itemId, actions) {
        // 从 itemId 反查 prompt（格式: "scenarioId/itemId"）
        for (const scenario of scenarios) {
          for (const item of scenario.children) {
            if (`${scenario.id}/${item.id}` === itemId) {
              await actions.fillComposer(item.prompt);
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
