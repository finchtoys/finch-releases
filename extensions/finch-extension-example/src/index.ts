import type * as finch from 'finch';
import { readFileSync } from 'node:fs';

// ── Constants ────────────────────────────────────────────────────────────────
const PACK_ID = 'finch-extension-example' as const;
const ICON = (name: string) => `ext:${PACK_ID}/${name}` as const;
const CURRENT_ICON_KEY = 'currentIcon';
const LAST_ACTION_KEY = 'lastAction';

// ── Read SVG icon file ───────────────────────────────────────────────────────
function readIconSvg(name: string): string {
  return readFileSync(new URL(`../icons/${name}.svg`, import.meta.url), 'utf-8');
}

// ── Icon definitions (for submenu + register) ────────────────────────────────
interface IconDef {
  id: string;
  svgName: string;
  label: string;
  description: string;
}
const ALL_ICONS: IconDef[] = [
  { id: 'finch-extension-example', svgName: 'finch-extension-example', label: '主图标', description: '自定义 SVG 主图标' },
  { id: 'all-fields', svgName: 'all-fields', label: '全部字段', description: 'Lucide list' },
  { id: 'login',      svgName: 'login',      label: '模拟登录', description: 'Lucide log-in' },
  { id: 'timeout',    svgName: 'timeout',    label: '超时测试', description: 'Lucide timer' },
  { id: 'config',     svgName: 'config',     label: '配置向导', description: 'Lucide settings' },
  { id: 'toast',      svgName: 'toast',      label: '弹框与提示', description: 'Lucide bell' },
  { id: 'preview',    svgName: 'preview',    label: '图标预览', description: 'Lucide eye' },
];
const iconMap = new Map(ALL_ICONS.map(i => [i.id, i]));

// ── Action definitions ──────────────────────────────────────────────────────
interface ActionDef {
  id: string;
  label: string;
  icon: string;
  prompt: string;
  group: string;
}
const ALL_ACTIONS: ActionDef[] = [
  { id: 'all-fields', label: '全部字段类型', icon: ICON('all-fields'), prompt: '用扩展示例展示全部表单字段类型', group: '表单' },
  { id: 'login',      label: '模拟登录',      icon: ICON('login'),      prompt: '用扩展示例测试登录表单',           group: '表单' },
  { id: 'timeout',    label: '超时测试',       icon: ICON('timeout'),    prompt: '用扩展示例测 30 秒超时的表单',     group: '表单' },
  { id: 'config',     label: '配置向导',       icon: ICON('config'),    prompt: '用扩展示例测试项目配置表单',       group: '表单' },
  { id: 'toast',      label: '弹框与提示',     icon: ICON('toast'),     prompt: '用扩展示例演示弹框和提示功能',     group: 'UI 演示' },
  { id: 'preview',    label: '自定义图标',     icon: ICON('preview'),   prompt: '用扩展示例展示所有注册的自定义图标', group: 'UI 演示' },
];
const actionMap = new Map(ALL_ACTIONS.map(a => [a.id, a]));

// ── Tool: 全部字段类型 ───────────────────────────────────────────────────────
function registerAllFieldsTool(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_all_fields',
      title: '全部字段类型',
      description:
        '展示 Finch 自定义表单支持的全部字段类型：text、password、textarea、number、select、boolean。' +
        '同时演示 width 字段控制并排布局。当用户说「测试表单」「所有字段」「查看字段类型」时使用。',
      inputSchema: { type: 'object', properties: {} },
      risk: 'low',
      async execute(_input, exec) {
        const result = await exec.ui.requestForm({
          title: '全部字段类型测试',
          description: '这是 Finch requestForm 支持的全部字段类型，包含并排布局演示。',
          submitLabel: '查看结果',
          cancelLabel: '取消',
          fields: [
            { key: 'name', label: '姓名', type: 'text', placeholder: '请输入你的名字', required: true, width: '2/3' },
            { key: 'age', label: '年龄', type: 'number', placeholder: '18', default: 18, width: '1/3' },
            { key: 'password', label: '密码', type: 'password', placeholder: '不会泄露给 AI', secret: true, width: '2/3' },
            { key: 'color', label: '喜欢的颜色', type: 'select', default: 'blue', width: '1/3',
              options: [
                { value: 'red', label: '红色' }, { value: 'blue', label: '蓝色' },
                { value: 'green', label: '绿色' }, { value: 'purple', label: '紫色' },
              ] },
            { key: 'bio', label: '自我介绍', type: 'textarea', placeholder: '写一段关于你自己的介绍…', description: '支持多行文本' },
            { key: 'subscribe', label: '订阅通知', type: 'boolean', description: '是否接收通知', default: true },
          ],
          timeoutMs: 120_000,
        });

        if (!result.submitted) return { content: [{ type: 'text', text: `表单已取消（原因：${result.reason}）` }] };

        const entries = Object.entries(result.values)
          .map(([k, v]) => `- **${k}**: \`${JSON.stringify(v)}\``).join('\n');
        return { content: [{ type: 'text', text: `✅ 表单提交成功！以下是填写的内容：\n\n${entries}` }] };
      },
    }),
  );
}

// ── Tool: 模拟登录表单 ───────────────────────────────────────────────────────
function registerLoginTool(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_login',
      title: '模拟登录',
      description:
        '模拟登录场景，演示 requestForm 的实用案例和 secret 字段的使用。' +
        '当用户说「登录」「登录表单」「测试登录」时使用。',
      inputSchema: { type: 'object', properties: {} },
      risk: 'low',
      async execute(_input, exec) {
        const result = await exec.ui.requestForm({
          title: '登录',
          description: '请输入你的登录凭据。密码标记为 secret，不会返回给模型。',
          submitLabel: '登录',
          fields: [
            { key: 'username', label: '用户名', type: 'text', placeholder: '输入用户名', required: true },
            { key: 'password', label: '密码', type: 'password', placeholder: '输入密码', secret: true, required: true,
              description: '此字段值不会泄露给 AI 模型' },
            { key: 'remember', label: '记住我', type: 'boolean', default: false },
          ],
        });

        if (!result.submitted) return { content: [{ type: 'text', text: `❌ 登录已取消（原因：${result.reason}）` }] };

        return {
          content: [{
            type: 'text',
            text: `✅ 登录成功！欢迎回来 **${result.values.username}**` +
              (result.values.remember ? '（已勾选"记住我"）' : '') +
              '\n\n> 注意：密码字段标记为 `secret: true`，其值未返回给模型。',
          }],
        };
      },
    }),
  );
}

// ── Tool: 超时测试表单 ───────────────────────────────────────────────────────
function registerTimeoutTool(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_timeout',
      title: '超时测试',
      description:
        '演示 requestForm 的可选超时参数。`seconds` 参数控制超时时长（默认 30 秒），设为 0 则不超时。' +
        '当用户说「超时测试」「自动取消」「自定义超时」时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: '超时秒数（默认 30，0 为不超时）' },
        },
      },
      risk: 'low',
      async execute(input, exec) {
        const { seconds } = input as { seconds?: number };
        const timeoutSec = seconds != null && seconds >= 0 ? seconds : 30;

        const result = await exec.ui.requestForm({
          title: timeoutSec > 0 ? `${timeoutSec} 秒超时测试` : '无超时测试',
          description: timeoutSec > 0
            ? `这个表单会在 **${timeoutSec} 秒** 后自动取消。`
            : '这个表单没有超时限制，可一直等待。',
          submitLabel: '提交',
          fields: [
            { key: 'feedback', label: '输入点什么', type: 'text', placeholder: '随便输入… 或者等待超时' },
          ],
          timeoutMs: timeoutSec > 0 ? timeoutSec * 1000 : undefined,
        });

        if (!result.submitted) {
          const reasonMap: Record<string, string> = {
            timeout: `⏰ 超时了！表单因 ${timeoutSec} 秒无操作自动取消。`,
            cancelled: '📋 表单已取消',
            'session-ended': '📋 会话已结束，表单关闭',
          };
          return { content: [{ type: 'text', text: reasonMap[result.reason!] || `📋 表单已取消（${result.reason}）` }] };
        }
        return { content: [{ type: 'text', text: `✅ 已提交：${result.values.feedback}` }] };
      },
    }),
  );
}

// ── Tool: 配置向导表单 ───────────────────────────────────────────────────────
function registerConfigTool(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_config',
      title: '配置向导',
      description:
        '演示复杂的多字段配置表单，包含 select、boolean 组合、并排布局。' +
        '当用户说「配置」「配置向导」「项目配置」时使用。',
      inputSchema: { type: 'object', properties: {} },
      risk: 'medium',
      async execute(_input, exec) {
        const result = await exec.ui.requestForm({
          title: '项目配置',
          description: '配置一个新项目的基本参数',
          submitLabel: '创建项目',
          fields: [
            { key: 'projectName', label: '项目名称', type: 'text', placeholder: 'my-project', required: true },
            { key: 'language', label: '主要语言', type: 'select', default: 'ts', width: '1/2',
              options: [
                { value: 'ts', label: 'TypeScript' }, { value: 'js', label: 'JavaScript' },
                { value: 'py', label: 'Python' }, { value: 'rs', label: 'Rust' },
              ] },
            { key: 'port', label: '端口号', type: 'number', placeholder: '3000', default: 3000, width: '1/2' },
            { key: 'initGit', label: '初始化 Git', type: 'boolean', default: true, width: '1/2' },
            { key: 'initReadme', label: '生成 README', type: 'boolean', default: true, width: '1/2' },
            { key: 'notes', label: '备注', type: 'textarea', placeholder: '可选的备注信息…', description: '非必填' },
          ],
        });

        if (!result.submitted) return { content: [{ type: 'text', text: '❌ 配置已取消' }] };

        const { projectName, language, port, initGit, initReadme, notes } = result.values;
        const langMap: Record<string, string> = { ts: 'TypeScript', js: 'JavaScript', py: 'Python', rs: 'Rust' };

        return {
          content: [{
            type: 'text',
            text: [
              `✅ 项目「${projectName}」配置完成！`,
              '',
              '| 参数 | 值 |',
              '| --- | --- |',
              `| 语言 | ${langMap[language as string] || language} |`,
              `| 端口 | ${port} |`,
              `| Git 初始化 | ${initGit ? '✅' : '❌'} |`,
              `| 生成 README | ${initReadme ? '✅' : '❌'} |`,
              notes ? `| 备注 | ${notes} |` : null,
              '',
              '现在可以使用 Finch 的工具来创建这个项目了。',
            ].filter(Boolean).join('\n'),
          }],
        };
      },
    }),
  );
}

// ── Tool: 弹框与提示演示 ─────────────────────────────────────────────────────
function registerToastDemoTool(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_show_message',
      title: '弹框与提示',
      description:
        '演示 ctx.ui.showToast 和 ctx.ui.showMessage 两种通知方式。' +
        'showToast 支持变体（success/info/warning/error）和 action 按钮（如 Undo）。' +
        'showMessage 支持 info/warning/error 三种类型。当用户说「弹框」「提示」「通知」「toast」时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['toast', 'message'],
            description: '通知类型：toast（弹窗通知）或 message（顶部消息）',
          },
          variant: {
            type: 'string',
            enum: ['info', 'success', 'warning', 'error'],
            description: 'toast 的变体，默认 success',
          },
        },
      },
      risk: 'low',
      async execute(input, exec) {
        const { type = 'toast', variant = 'success' } = input as { type?: string; variant?: string };

        if (type === 'message') {
          ctx.ui.showMessage(`这是一条 showMessage（${variant}）`, variant as 'info' | 'warning' | 'error');
          return { content: [{ type: 'text', text: `✅ 已调用 ctx.ui.showMessage('${variant}')` }] };
        }

        const result = await ctx.ui.showToast({
          title: `${variant} 通知`,
          description: `这是 ${variant} 变体的 showToast 演示`,
          variant: variant as 'info' | 'success' | 'warning' | 'error',
          action: { label: '撤销' },
          position: 'TC',
        });

        if (result.action === 'action') {
          ctx.ui.showToast({ title: '已撤销操作', variant: 'info', position: 'TC' });
        }

        return { content: [{ type: 'text', text: `✅ 已完成 ${variant} toast 演示` }] };
      },
    }),
  );
}

// ── Tool: 自定义图标展示 ─────────────────────────────────────────────────────
function registerIconPreviewTool(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_icon_preview',
      title: '自定义图标',
      description:
        '展示本扩展通过 contributes.icons 注册的所有自定义 SVG 图标，以及它们的引用方式。' +
        '当用户说「图标」「自定义图标」「查看图标」「图标演示」时使用。',
      inputSchema: { type: 'object', properties: {} },
      risk: 'low',
      async execute() {
        const icons = [
          { name: 'finch-extension-example',  label: '主按钮图标（自定义 SVG）', file: 'finch-extension-example.svg' },
          { name: 'all-fields', label: '全部字段类型（Lucide list）', file: 'list.svg → all-fields.svg' },
          { name: 'login',      label: '模拟登录（Lucide log-in）', file: 'log-in.svg → login.svg' },
          { name: 'timeout',    label: '超时测试（Lucide timer）', file: 'timer.svg → timeout.svg' },
          { name: 'config',     label: '配置向导（Lucide settings）', file: 'settings.svg → config.svg' },
          { name: 'toast',      label: '弹框与提示（Lucide bell）', file: 'bell.svg → toast.svg' },
          { name: 'preview',    label: '图标预览（Lucide eye）',   file: 'eye.svg → preview.svg' },
        ];

        const table = icons.map(i =>
          `| \`ext:finch-extension-example/${i.name}\` | ${i.label} | \`icons/${i.file}\` |`
        ).join('\n');

        return {
          content: [{
            type: 'text',
            text: [
              '## 🎨 注册的自定义图标',
              '',
              '本扩展通过 `contributes.iconPacks` + `ctx.icons.register()` 注册了以下 SVG 图标，',
              '可通过 `ext:finch-extension-example/<name>` 在菜单、按钮中引用。',
              '',
              '| 引用名 | 用途 | 源文件 |',
              '| --- | --- | --- |',
              table,
              '',
              '**使用方式：**',
              '- Manifest 中：`"icon": "finch-extension-example"`（指向 pack id）',
              '- 菜单项 iconName：`"ext:finch-extension-example/xxx"`',
              '- 注册：`ctx.icons.register(\'finch-extension-example\', { ... })`',
              '- 来源：6 枚来自 Lucide，1 枚自定义',
            ].join('\n'),
          }],
        };
      },
    }),
  );
}

// ── Composer action provider ─────────────────────────────────────────────────
function registerComposerAction(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.composerActions.register('example-quick', {
      async getBadge() {
        const lastAction = await ctx.storage.get<string>(LAST_ACTION_KEY);
        if (lastAction && actionMap.has(lastAction)) {
          return actionMap.get(lastAction)!.label.slice(0, 6);
        }
        return '演示';
      },

      /** 动态读取当前图标，从 storage 读取用户选择 */
      async getIcon() {
        const current = await ctx.storage.get<string>(CURRENT_ICON_KEY);
        if (current && iconMap.has(current)) return ICON(current);
        return undefined; // fallback to manifest default
      },

      async getMenu() {
        const currentIcon = await ctx.storage.get<string>(CURRENT_ICON_KEY);

        // 表单组（一级菜单，无激活态）
        const formItems: finch.ComposerActionMenuItem[] = ALL_ACTIONS
          .filter(a => a.group === '表单')
          .map(a => ({
            id: a.id,
            label: a.label,
            iconName: a.icon,
            group: 'example-forms',
            groupLabel: '📋 表单交互',
          }));

        // UI 演示组（一级菜单，无激活态；只保留弹框，去掉自定义图标）
        const uiItems: finch.ComposerActionMenuItem[] = ALL_ACTIONS
          .filter(a => a.group === 'UI 演示' && a.id !== 'preview')
          .map(a => ({
            id: a.id,
            label: a.label,
            iconName: a.icon,
            group: 'example-ui',
            groupLabel: '🔔 UI 能力',
          }));

        // 图标选择二级菜单（hover 展开）
        const iconItems: finch.ComposerActionMenuItem[] = ALL_ICONS.map(i => ({
          id: `icon-${i.id}`,
          label: i.label,
          description: i.description,
          iconName: ICON(i.id),
          current: currentIcon === i.id,
          group: 'example-icons',
        }));

        // "更换图标" 作为可 hover 展开的二级菜单
        const iconPickerItem: finch.ComposerActionMenuItem = {
          id: 'icon-picker',
          label: '更换图标',
          description: currentIcon ? iconMap.get(currentIcon)?.label : '默认',
          iconName: currentIcon ? ICON(currentIcon) : ICON('finch-extension-example'),
          group: 'example-ui',
          groupLabel: '🔔 UI 能力',
          children: iconItems,
        };

        return [...formItems, ...uiItems, iconPickerItem];
      },

      async execute(_ctx, itemId, actions) {
        // ── 处理图标选择 ──
        if (itemId.startsWith('icon-')) {
          const iconId = itemId.slice(5);
          if (!iconMap.has(iconId)) return;

          await ctx.storage.set(CURRENT_ICON_KEY, iconId);
          ctx.ui.showToast({
            title: '图标已更换',
            description: `当前图标：${iconMap.get(iconId)!.label}`,
            variant: 'success',
            position: 'TC',
          });
          return;
        }

        const def = actionMap.get(itemId);
        if (!def) return;

        // 记录上次操作
        await ctx.storage.set(LAST_ACTION_KEY, itemId);

        // 填入 Composer
        await actions.fillComposer(def.prompt);

        // 根据不同类型显示反馈（仅顶部中央一个 toast）
        if (itemId === 'all-fields') {
          await ctx.ui.showToast({
            title: '已填入',
            description: `「${def.label}」的测试 prompt`,
            variant: 'success',
            position: 'TC',
          });
        } else if (itemId === 'toast') {
          ctx.ui.showToast({
            title: '已填入',
            description: `「${def.label}」的测试 prompt — 打开弹框演示工具查看更多`,
            variant: 'info',
            position: 'TC',
          });
        } else if (itemId === 'preview') {
          ctx.ui.showToast({
            title: '已填入',
            description: '打开自定义图标展示工具',
            variant: 'info',
            position: 'TC',
          });
        } else {
          ctx.ui.showToast({
            title: '已填入',
            description: `「${def.label}」的测试 prompt`,
            variant: 'success',
            position: 'TC',
          });
        }

        ctx.logger.info(`composer action selected: ${itemId}`);
      },
    }),
  );
}

// ── Activation ───────────────────────────────────────────────────────────────
export function activate(ctx: finch.ExtensionContext): void {
  ctx.logger.info('finch-extension-example activating...');

  // Register icon pack — all 7 custom SVG icons
  ctx.subscriptions.push(
    ctx.icons.register('finch-extension-example', {
      'finch-extension-example':  { svg: readIconSvg('finch-extension-example'),  description: 'Extension Example main icon' },
      'all-fields': { svg: readIconSvg('all-fields'), description: 'All form fields' },
      'login':      { svg: readIconSvg('login'),      description: 'Login form' },
      'timeout':    { svg: readIconSvg('timeout'),    description: 'Timeout test' },
      'config':     { svg: readIconSvg('config'),     description: 'Config wizard' },
      'toast':      { svg: readIconSvg('toast'),      description: 'Toast demo' },
      'preview':    { svg: readIconSvg('preview'),    description: 'Icon preview' },
    }),
  );

  // Register all tools
  registerAllFieldsTool(ctx);
  registerLoginTool(ctx);
  registerTimeoutTool(ctx);
  registerConfigTool(ctx);
  registerToastDemoTool(ctx);
  registerIconPreviewTool(ctx);

  // Register composer action
  registerComposerAction(ctx);

  ctx.logger.info('finch-extension-example activated — 6 tools + 1 composer action + 7 custom icons');
}

export function deactivate(): void {
  // ctx.subscriptions.dispose handles cleanup
}
