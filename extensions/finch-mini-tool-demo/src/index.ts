import type * as finch from 'finch';
import { readFileSync } from 'node:fs';

// ── Constants ────────────────────────────────────────────────────────────────
const PACK_ID = 'mini-tool-demo' as const;
const ICON = (name: string) => `ext:${PACK_ID}/${name}` as const;
const CURRENT_ICON_KEY = 'currentIcon';
const LAST_ACTION_KEY = 'lastAction';

// ── Read SVG icon file ───────────────────────────────────────────────────────
function readIconSvg(name: string): string {
  return readFileSync(new URL(`../icons/${name}.svg`, import.meta.url), 'utf-8');
}

// ── Icon definitions (i18n keys only, resolved at runtime via ctx) ───────────
interface IconDef {
  id: string;
  svgName: string;
  labelKey: string;
  descKey: string;
}
const ALL_ICONS: IconDef[] = [
  { id: 'mini-tool-demo', svgName: 'mini-tool-demo', labelKey: 'icon.main',        descKey: 'icon.main.desc' },
  { id: 'all-fields',              svgName: 'all-fields',              labelKey: 'icon.all-fields',   descKey: 'icon.all-fields.desc' },
  { id: 'login',                   svgName: 'login',                   labelKey: 'icon.login',        descKey: 'icon.login.desc' },
  { id: 'timeout',                 svgName: 'timeout',                 labelKey: 'icon.timeout',      descKey: 'icon.timeout.desc' },
  { id: 'config',                  svgName: 'config',                  labelKey: 'icon.config',       descKey: 'icon.config.desc' },
  { id: 'toast',                   svgName: 'toast',                   labelKey: 'icon.toast',        descKey: 'icon.toast.desc' },
  { id: 'preview',                 svgName: 'preview',                 labelKey: 'icon.preview',      descKey: 'icon.preview.desc' },
];
const iconMap = new Map(ALL_ICONS.map(i => [i.id, i]));

// ── Action definitions (i18n keys only) ──────────────────────────────────────
interface ActionDef {
  id: string;
  labelKey: string;
  icon: string;
  promptKey: string;
  group: string;
}
const ALL_ACTIONS: ActionDef[] = [
  { id: 'all-fields', labelKey: 'action.all-fields', icon: ICON('all-fields'), promptKey: 'action.all-fields.prompt', group: '表单' },
  { id: 'login',      labelKey: 'action.login',      icon: ICON('login'),      promptKey: 'action.login.prompt',      group: '表单' },
  { id: 'timeout',    labelKey: 'action.timeout',     icon: ICON('timeout'),    promptKey: 'action.timeout.prompt',    group: '表单' },
  { id: 'config',     labelKey: 'action.config',      icon: ICON('config'),    promptKey: 'action.config.prompt',     group: '表单' },
  { id: 'toast',      labelKey: 'action.toast',       icon: ICON('toast'),     promptKey: 'action.toast.prompt',      group: 'UI 演示' },
  { id: 'preview',    labelKey: 'action.preview',     icon: ICON('preview'),   promptKey: 'action.preview.prompt',    group: 'UI 演示' },
];
const actionMap = new Map(ALL_ACTIONS.map(a => [a.id, a]));

// ── i18n helper ──────────────────────────────────────────────────────────────
function t(i18n: finch.ExtensionContext['i18n'], key: string, vars?: Record<string, string | number | boolean>): string {
  return i18n.t(key, vars as Record<string, string>);
}

// ── Tool: 全部字段类型 ───────────────────────────────────────────────────────
function registerAllFieldsTool(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_all_fields',
      title: t(ctx.i18n, 'action.all-fields'),
      description: t(ctx.i18n, 'action.all-fields.prompt') + '。同时演示 width 字段控制并排布局。',
      inputSchema: { type: 'object', properties: {} },
      risk: 'low',
      async execute(_input, exec) {
        const i = ctx.i18n;
        const result = await exec.ui.requestForm({
          title: i.t('form.all-fields.title'),
          description: i.t('form.all-fields.description'),
          submitLabel: i.t('form.all-fields.submit'),
          cancelLabel: i.t('form.cancel'),
          fields: [
            { key: 'name', label: i.t('form.all-fields.name.label'), type: 'text', placeholder: i.t('form.all-fields.name.placeholder'), required: true, width: '2/3' },
            { key: 'age', label: i.t('form.all-fields.age.label'), type: 'number', placeholder: '18', default: 18, width: '1/3' },
            { key: 'password', label: i.t('form.all-fields.password.label'), type: 'password', placeholder: i.t('form.all-fields.password.placeholder'), secret: true, width: '2/3' },
            { key: 'color', label: i.t('form.all-fields.color.label'), type: 'select', default: 'blue', width: '1/3',
              options: [
                { value: 'red', label: i.t('form.all-fields.color.red') },
                { value: 'blue', label: i.t('form.all-fields.color.blue') },
                { value: 'green', label: i.t('form.all-fields.color.green') },
                { value: 'purple', label: i.t('form.all-fields.color.purple') },
              ] },
            { key: 'bio', label: i.t('form.all-fields.bio.label'), type: 'textarea', placeholder: i.t('form.all-fields.bio.placeholder'), description: i.t('form.all-fields.bio.description') },
            { key: 'subscribe', label: i.t('form.all-fields.subscribe.label'), type: 'boolean', description: i.t('form.all-fields.subscribe.description'), default: true, width: '2/3' },
            { key: 'finchLink', label: i.t('form.all-fields.link.label'), type: 'link', href: 'https://finchwork.app', width: '1/3' },
          ],
          timeoutMs: 120_000,
        });

        if (!result.submitted) return { content: [{ type: 'text', text: i.t('result.all-fields.cancelled', { reason: result.reason ?? '' }) }] };

        const entries = Object.entries(result.values)
          .map(([k, v]) => `- **${k}**: \`${JSON.stringify(v)}\``).join('\n');
        return { content: [{ type: 'text', text: `${i.t('result.all-fields.success')}\n\n${entries}` }] };
      },
    }),
  );
}

// ── Tool: 模拟登录表单 ───────────────────────────────────────────────────────
function registerLoginTool(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_login',
      title: t(ctx.i18n, 'action.login'),
      description: t(ctx.i18n, 'action.login.prompt') + '。演示 requestForm 的实用案例和 secret 字段。',
      inputSchema: { type: 'object', properties: {} },
      risk: 'low',
      async execute(_input, exec) {
        const i = ctx.i18n;
        const result = await exec.ui.requestForm({
          title: i.t('form.login.title'),
          description: i.t('form.login.description'),
          submitLabel: i.t('form.login.submit'),
          fields: [
            { key: 'username', label: i.t('form.login.username.label'), type: 'text', placeholder: i.t('form.login.username.placeholder'), required: true },
            { key: 'password', label: i.t('form.login.password.label'), type: 'password', placeholder: i.t('form.login.password.placeholder'), secret: true, required: true,
              description: i.t('form.login.password.description') },
            { key: 'remember', label: i.t('form.login.remember.label'), type: 'boolean', default: false },
          ],
        });

        if (!result.submitted) return { content: [{ type: 'text', text: i.t('result.login.cancelled', { reason: result.reason ?? '' }) }] };

        return {
          content: [{
            type: 'text',
            text: i.t('result.login.success', { username: String(result.values.username) }) +
              (result.values.remember ? i.t('result.login.remember') : '') +
              '\n\n' + i.t('result.login.notice'),
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
      title: t(ctx.i18n, 'action.timeout'),
      description: '演示 requestForm 的可选超时参数。`seconds` 参数控制超时时长（默认 30 秒），设为 0 则不超时。' +
        '当用户说「超时测试」「自动取消」「自定义超时」时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: '超时秒数（默认 30，0 为不超时）' },
        },
      },
      risk: 'low',
      async execute(input, exec) {
        const i = ctx.i18n;
        const { seconds } = input as { seconds?: number };
        const timeoutSec = seconds != null && seconds >= 0 ? seconds : 30;

        const result = await exec.ui.requestForm({
          title: timeoutSec > 0 ? i.t('form.timeout.title.with', { seconds: timeoutSec }) : i.t('form.timeout.title.without'),
          description: timeoutSec > 0
            ? i.t('form.timeout.description.with', { seconds: timeoutSec })
            : i.t('form.timeout.description.without'),
          submitLabel: i.t('form.timeout.submit'),
          fields: [
            { key: 'feedback', label: i.t('form.timeout.input.label'), type: 'text', placeholder: i.t('form.timeout.input.placeholder') },
          ],
          timeoutMs: timeoutSec > 0 ? timeoutSec * 1000 : undefined,
        });

        if (!result.submitted) {
          const reasonMap: Record<string, string> = {
            timeout: i.t('result.timeout.timeout', { seconds: timeoutSec }),
            cancelled: i.t('result.timeout.cancelled'),
            'session-ended': i.t('result.timeout.session-ended'),
          };
          return { content: [{ type: 'text', text: reasonMap[result.reason!] || i.t('result.timeout.other', { reason: result.reason ?? '' }) }] };
        }
        return { content: [{ type: 'text', text: i.t('result.timeout.submitted', { value: String(result.values.feedback) }) }] };
      },
    }),
  );
}

// ── Tool: 配置向导表单 ───────────────────────────────────────────────────────
function registerConfigTool(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_config',
      title: t(ctx.i18n, 'action.config'),
      description: t(ctx.i18n, 'action.config.prompt') + '。演示复杂的多字段表单，含 select/boolean/并排布局。',
      inputSchema: { type: 'object', properties: {} },
      risk: 'medium',
      async execute(_input, exec) {
        const i = ctx.i18n;
        const result = await exec.ui.requestForm({
          title: i.t('form.config.title'),
          description: i.t('form.config.description'),
          submitLabel: i.t('form.config.submit'),
          fields: [
            { key: 'projectName', label: i.t('form.config.name.label'), type: 'text', placeholder: 'my-project', required: true },
            { key: 'language', label: i.t('form.config.language.label'), type: 'select', default: 'ts', width: '1/2',
              options: [
                { value: 'ts', label: 'TypeScript' }, { value: 'js', label: 'JavaScript' },
                { value: 'py', label: 'Python' }, { value: 'rs', label: 'Rust' },
              ] },
            { key: 'port', label: i.t('form.config.port.label'), type: 'number', placeholder: '3000', default: 3000, width: '1/2' },
            { key: 'initGit', label: i.t('form.config.initGit.label'), type: 'boolean', default: true, width: '1/2' },
            { key: 'initReadme', label: i.t('form.config.initReadme.label'), type: 'boolean', default: true, width: '1/2' },
            { key: 'notes', label: i.t('form.config.notes.label'), type: 'textarea', placeholder: i.t('form.config.notes.placeholder'), description: i.t('form.config.notes.description') },
          ],
        });

        if (!result.submitted) return { content: [{ type: 'text', text: i.t('result.config.cancelled') }] };

        const { projectName, language, port, initGit, initReadme, notes } = result.values;
        const langMap: Record<string, string> = { ts: 'TypeScript', js: 'JavaScript', py: 'Python', rs: 'Rust' };

        return {
          content: [{
            type: 'text',
            text: [
              i.t('result.config.header', { name: String(projectName) }),
              '',
              `| ${i.t('result.config.table.key')} | ${i.t('result.config.table.value')} |`,
              '| --- | --- |',
              `| ${i.t('result.config.row.language')} | ${langMap[language as string] || language} |`,
              `| ${i.t('result.config.row.port')} | ${port} |`,
              `| ${i.t('result.config.row.git')} | ${initGit ? '✅' : '❌'} |`,
              `| ${i.t('result.config.row.readme')} | ${initReadme ? '✅' : '❌'} |`,
              notes ? `| ${i.t('result.config.row.notes')} | ${notes} |` : null,
              '',
              i.t('result.config.footer'),
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
      title: t(ctx.i18n, 'action.toast'),
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
        const i = ctx.i18n;
        const { type = 'toast', variant = 'success' } = input as { type?: string; variant?: string };

        if (type === 'message') {
          ctx.ui.showMessage(i.t('toast.demo.description', { variant }), variant as 'info' | 'warning' | 'error');
          return { content: [{ type: 'text', text: i.t('result.toast.message', { variant }) }] };
        }

        const result = await ctx.ui.showToast({
          title: i.t('toast.demo.title', { variant }),
          description: i.t('toast.demo.description', { variant }),
          variant: variant as 'info' | 'success' | 'warning' | 'error',
          action: { label: i.t('toast.demo.undo') },
          position: 'TC',
        });

        if (result.action === 'action') {
          ctx.ui.showToast({ title: i.t('toast.demo.undone'), variant: 'info', position: 'TC' });
        }

        return { content: [{ type: 'text', text: i.t('result.toast.done', { variant }) }] };
      },
    }),
  );
}

// ── Tool: 自定义图标展示 ─────────────────────────────────────────────────────
function registerIconPreviewTool(ctx: finch.ExtensionContext) {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_icon_preview',
      title: t(ctx.i18n, 'action.preview'),
      description: t(ctx.i18n, 'action.preview.prompt') + '。展示所有通过 contributes.iconPacks + ctx.icons.register() 注册的自定义 SVG 图标及引用方式。',
      inputSchema: { type: 'object', properties: {} },
      risk: 'low',
      async execute() {
        const icons = [
          { name: 'mini-tool-demo',  label: '主按钮图标（自定义 SVG）', file: 'mini-tool-demo.svg' },
          { name: 'all-fields', label: '全部字段类型（Lucide list）', file: 'list.svg → all-fields.svg' },
          { name: 'login',      label: '模拟登录（Lucide log-in）', file: 'log-in.svg → login.svg' },
          { name: 'timeout',    label: '超时测试（Lucide timer）', file: 'timer.svg → timeout.svg' },
          { name: 'config',     label: '配置向导（Lucide settings）', file: 'settings.svg → config.svg' },
          { name: 'toast',      label: '弹框与提示（Lucide bell）', file: 'bell.svg → toast.svg' },
          { name: 'preview',    label: '图标预览（Lucide eye）',   file: 'eye.svg → preview.svg' },
        ];

        const table = icons.map(i =>
          `| \`ext:mini-tool-demo/${i.name}\` | ${i.label} | \`icons/${i.file}\` |`
        ).join('\n');

        return {
          content: [{
            type: 'text',
            text: [
              '## 🎨 注册的自定义图标',
              '',
              '本扩展通过 `contributes.iconPacks` + `ctx.icons.register()` 注册了以下 SVG 图标，',
              '可通过 `ext:mini-tool-demo/<name>` 在菜单、按钮中引用。',
              '',
              '| 引用名 | 用途 | 源文件 |',
              '| --- | --- | --- |',
              table,
              '',
              '**使用方式：**',
              '- Manifest 中：`"icon": "mini-tool-demo"`（指向 pack id）',
              '- 菜单项 iconName：`"ext:mini-tool-demo/xxx"`',
              '- 注册：`ctx.icons.register(\'mini-tool-demo\', { ... })`',
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
  const i18n = ctx.i18n;

  ctx.subscriptions.push(
    ctx.composerActions.register('example-quick', {
      async getBadge() {
        const lastAction = await ctx.storage.get<string>(LAST_ACTION_KEY);
        if (lastAction && actionMap.has(lastAction)) {
          const label = ctx.i18n.t(actionMap.get(lastAction)!.labelKey);
          // 中文按 6 字节截，英文按 10 字符截，适配视觉宽度
          return /[\u4e00-\u9fff]/.test(label) ? label.slice(0, 6) : label.slice(0, 10);
        }
        return ctx.i18n.t('badge.default');
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
            label: ctx.i18n.t(a.labelKey),
            iconName: a.icon,
            group: 'example-forms',
            groupLabel: ctx.i18n.t('group.forms'),
          }));

        // UI 演示组（一级菜单，无激活态；只保留弹框，去掉自定义图标）
        const uiItems: finch.ComposerActionMenuItem[] = ALL_ACTIONS
          .filter(a => a.group === 'UI 演示' && a.id !== 'preview')
          .map(a => ({
            id: a.id,
            label: ctx.i18n.t(a.labelKey),
            iconName: a.icon,
            group: 'example-ui',
            groupLabel: ctx.i18n.t('group.ui'),
          }));

        // 图标选择二级菜单（hover 展开）
        const iconItems: finch.ComposerActionMenuItem[] = ALL_ICONS.map(i => ({
          id: `icon-${i.id}`,
          label: ctx.i18n.t(i.labelKey),
          description: ctx.i18n.t(i.descKey),
          iconName: ICON(i.id),
          current: currentIcon === i.id,
          group: 'example-icons',
        }));

        // "更换图标" 作为可 hover 展开的二级菜单
        const iconPickerItem: finch.ComposerActionMenuItem = {
          id: 'icon-picker',
          label: ctx.i18n.t('icon.picker'),
          description: currentIcon ? ctx.i18n.t(iconMap.get(currentIcon)!.labelKey) : ctx.i18n.t('icon.picker.default'),
          iconName: currentIcon ? ICON(currentIcon) : ICON('mini-tool-demo'),
          group: 'example-ui',
          groupLabel: ctx.i18n.t('group.ui'),
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
            title: ctx.i18n.t('icon.changed'),
            description: ctx.i18n.t('icon.changed.desc', { label: ctx.i18n.t(iconMap.get(iconId)!.labelKey) }),
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
        await actions.fillComposer(ctx.i18n.t(def.promptKey));

        // 根据不同类型显示反馈（仅顶部中央一个 toast）
        const label = ctx.i18n.t(def.labelKey);
        if (itemId === 'all-fields') {
          await ctx.ui.showToast({
            title: ctx.i18n.t('toast.filled'),
            description: ctx.i18n.t('toast.filled.desc', { label }),
            variant: 'success',
            position: 'TC',
          });
        } else if (itemId === 'toast') {
          ctx.ui.showToast({
            title: ctx.i18n.t('toast.filled'),
            description: ctx.i18n.t('toast.toast.desc', { label }),
            variant: 'info',
            position: 'TC',
          });
        } else if (itemId === 'preview') {
          ctx.ui.showToast({
            title: ctx.i18n.t('toast.filled'),
            description: ctx.i18n.t('toast.preview.desc'),
            variant: 'info',
            position: 'TC',
          });
        } else {
          ctx.ui.showToast({
            title: ctx.i18n.t('toast.filled'),
            description: ctx.i18n.t('toast.filled.desc', { label }),
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
  ctx.logger.info('mini-tool-demo activating...');

  // Register icon pack — all 7 custom SVG icons
  ctx.subscriptions.push(
    ctx.icons.register('mini-tool-demo', {
      'mini-tool-demo':  { svg: readIconSvg('mini-tool-demo'),  description: 'Extension Example main icon' },
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

  ctx.logger.info('mini-tool-demo activated — 6 tools + 1 composer action + 7 custom icons');
}

export function deactivate(): void {
  // ctx.subscriptions.dispose handles cleanup
}
