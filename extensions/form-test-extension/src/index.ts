import type * as finch from 'finch';

export function activate(ctx: finch.ExtensionContext): void {
  ctx.logger.info('form-test extension activated');

  // ── 工具 1：展示所有字段类型 ──────────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_all_fields',
      title: '全部字段类型',
      description:
        '展示 Finch 自定义表单支持的全部字段类型（text / password / textarea / number / select / boolean）。' +
        '当用户说「测试表单」「所有字段」「全部字段类型」时使用。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      risk: 'low',
      async execute(_input, exec) {
        const result = await exec.ui.requestForm({
          title: '全部字段类型测试',
          description: '这是 Finch requestForm 支持的全部字段类型，填写后提交查看结果。',
          submitLabel: '查看结果',
          cancelLabel: '取消测试',
          fields: [
            {
              key: 'name',
              label: '姓名',
              type: 'text',
              placeholder: '请输入你的名字',
              required: true,
              width: '2/3',
            },
            {
              key: 'age',
              label: '年龄',
              type: 'number',
              placeholder: '18',
              default: 18,
              width: '1/3',
            },
            {
              key: 'password',
              label: '密码',
              type: 'password',
              placeholder: '输入密码（不会泄露给 AI）',
              secret: true,
              description: '此字段为敏感字段，值不会返回给模型',
              width: '2/3',
            },
            {
              key: 'color',
              label: '喜欢的颜色',
              type: 'select',
              description: '从下拉列表中选择',
              options: [
                { value: 'red', label: '红色' },
                { value: 'blue', label: '蓝色' },
                { value: 'green', label: '绿色' },
                { value: 'purple', label: '紫色' },
              ],
              default: 'blue',
              width: '1/3',
            },
            {
              key: 'bio',
              label: '自我介绍',
              type: 'textarea',
              placeholder: '写一段关于你自己的介绍…',
              description: '支持多行文本',
            },
            {
              key: 'subscribe',
              label: '订阅通知',
              type: 'boolean',
              description: '是否接收通知',
              default: true,
            },
          ],
          timeoutMs: 120_000,
        });

        if (!result.submitted) {
          return {
            content: [{ type: 'text', text: `表单已取消（原因：${result.reason}）` }],
          };
        }

        const entries = Object.entries(result.values)
          .map(([k, v]) => `- **${k}**: \`${JSON.stringify(v)}\``)
          .join('\n');

        return {
          content: [{
            type: 'text',
            text: `✅ 表单提交成功！以下是填写的内容：\n\n${entries}`,
          }],
        };
      },
    }),
  );

  // ── 工具 2：模拟登录表单 ──────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_login',
      title: '模拟登录',
      description:
        '模拟登录场景，展示 requestForm 的实用案例。' +
        '当用户说「登录」「登录表单」「测试登录」时使用。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      risk: 'low',
      async execute(_input, exec) {
        const result = await exec.ui.requestForm({
          title: '登录',
          description: '请输入你的登录凭据',
          submitLabel: '登录',
          cancelLabel: '取消',
          fields: [
            {
              key: 'username',
              label: '用户名',
              type: 'text',
              placeholder: '输入用户名',
              required: true,
            },
            {
              key: 'password',
              label: '密码',
              type: 'password',
              placeholder: '输入密码',
              secret: true,
              required: true,
              description: '密码不会被模型看到',
            },
            {
              key: 'remember',
              label: '记住我',
              type: 'boolean',
              default: false,
            },
          ],
        });

        if (!result.submitted) {
          return {
            content: [{ type: 'text', text: `❌ 登录已取消（原因：${result.reason}）` }],
          };
        }

        // 注意：secret 字段的值（password）不会包含在 result.values 中
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

  // ── 工具 3：带超时的自动取消演示 ──────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_timeout',
      title: '超时测试',
      description:
        '演示表单的超时自动取消功能。表单在指定秒数后自动取消。' +
        '当用户说「超时测试」「自动取消」「自定义超时」时使用。' +
        '可选参数 seconds 控制超时时长，默认 30 秒。',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: {
            type: 'number',
            description: '超时秒数，默认 30。设为 0 不超时。',
          },
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
            {
              key: 'feedback',
              label: '输入点什么',
              type: 'text',
              placeholder: '随便输入… 或者等待超时',
            },
          ],
          timeoutMs: timeoutSec > 0 ? timeoutSec * 1000 : undefined,
        });

        if (!result.submitted) {
          return {
            content: [{
              type: 'text',
              text: result.reason === 'timeout'
                ? `⏰ 超时了！表单因 ${timeoutSec} 秒无操作自动取消。`
                : `📋 表单已取消（原因：${result.reason}）`,
            }],
          };
        }

        return {
          content: [{ type: 'text', text: `✅ 已提交：${result.values.feedback}` }],
        };
      },
    }),
  );

  // ── 工具 4：复杂配置表单 ──────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'form_config',
      title: '配置向导',
      description:
        '演示复杂的多字段配置表单，含 select 和 boolean 组合使用。' +
        '当用户说「配置」「配置向导」「设置表单」时使用。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      risk: 'medium',
      async execute(_input, exec) {
        const result = await exec.ui.requestForm({
          title: '项目配置',
          description: '配置一个新项目的基本参数',
          submitLabel: '创建项目',
          fields: [
            {
              key: 'projectName',
              label: '项目名称',
              type: 'text',
              placeholder: 'my-project',
              required: true,
            },
            {
              key: 'language',
              label: '主要语言',
              type: 'select',
              options: [
                { value: 'ts', label: 'TypeScript' },
                { value: 'js', label: 'JavaScript' },
                { value: 'py', label: 'Python' },
                { value: 'rs', label: 'Rust' },
              ],
              default: 'ts',
              width: '1/2',
            },
            {
              key: 'port',
              label: '端口号',
              type: 'number',
              placeholder: '3000',
              default: 3000,
              description: '开发服务器端口',
              width: '1/2',
            },
            {
              key: 'initGit',
              label: '初始化 Git',
              type: 'boolean',
              default: true,
              width: '1/2',
            },
            {
              key: 'initReadme',
              label: '生成 README',
              type: 'boolean',
              default: true,
              width: '1/2',
            },
            {
              key: 'notes',
              label: '备注',
              type: 'textarea',
              placeholder: '可选的备注信息…',
              description: '非必填',
            },
          ],
        });

        if (!result.submitted) {
          return {
            content: [{ type: 'text', text: `❌ 配置已取消` }],
          };
        }

        const { projectName, language, port, initGit, initReadme, notes } = result.values;
        const langMap: Record<string, string> = { ts: 'TypeScript', js: 'JavaScript', py: 'Python', rs: 'Rust' };

        return {
          content: [{
            type: 'text',
            text: [
              `✅ 项目「${projectName}」配置完成！`,
              ``,
              `| 参数 | 值 |`,
              `| --- | --- |`,
              `| 语言 | ${langMap[language as string] || language} |`,
              `| 端口 | ${port} |`,
              `| Git 初始化 | ${initGit ? '✅' : '❌'} |`,
              `| 生成 README | ${initReadme ? '✅' : '❌'} |`,
              notes ? `| 备注 | ${notes} |` : null,
              ``,
              `现在可以使用 Finch 的工具来创建这个项目了。`,
            ].filter(Boolean).join('\n'),
          }],
        };
      },
    }),
  );

  // ── ComposerAction 按钮：快速表单测试 ──────────────────────────────
  const actionMeta: Record<string, { icon: string; label: string; prompt: string }> = {
    'all-fields': { icon: 'list', label: '全部字段', prompt: '帮我测试一下表单的所有字段类型' },
    'login':      { icon: 'log-in', label: '登录',   prompt: '帮我测试一下登录表单' },
    'timeout':    { icon: 'timer', label: '超时',    prompt: '帮我测一下 60 秒超时的表单' },
    'config':     { icon: 'settings', label: '配置', prompt: '帮我测试一下项目配置表单' },
  };

  const lastActionKey = 'lastAction';

  ctx.subscriptions.push(
    ctx.composerActions.register('form-quick', {
      async getBadge() {
        const lastAction = await ctx.storage.get<string>(lastActionKey);
        if (lastAction && actionMeta[lastAction]) {
          return actionMeta[lastAction].label;
        }
        return '表单';
      },

      async getIcon() {
        const lastAction = await ctx.storage.get<string>(lastActionKey);
        if (lastAction && actionMeta[lastAction]) {
          return actionMeta[lastAction].icon;
        }
        return 'clipboard-list';
      },

      async getMenu() {
        const lastAction = await ctx.storage.get<string>(lastActionKey);
        return [
          { id: 'all-fields', label: '全部字段类型', iconName: 'list', current: lastAction === 'all-fields', group: 'form', groupLabel: '测试项目' },
          { id: 'login',      label: '模拟登录',      iconName: 'log-in', current: lastAction === 'login', group: 'form' },
          { id: 'timeout',    label: '超时测试',      iconName: 'timer', current: lastAction === 'timeout', group: 'form' },
          { id: 'config',     label: '配置向导',      iconName: 'settings', current: lastAction === 'config', group: 'form' },
        ];
      },

      async execute(_ctx, itemId, actions) {
        await ctx.storage.set(lastActionKey, itemId);
        if (actionMeta[itemId]) {
          await actions.fillComposer(actionMeta[itemId].prompt);
        }
        const label = actionMeta[itemId]?.label || itemId;
        if (itemId === 'all-fields') {
          // showToast + action 按钮，await 结果
          const result = await ctx.ui.showToast({
            title: '已填入',
            description: `「${label}」的测试 prompt`,
            variant: 'success',
            action: { label: 'Undo' },
          });
          if (result.action === 'action') {
            // 用户点击了 Undo，清除填入的内容
            await actions.fillComposer('', { mode: 'replace' });
            ctx.ui.showToast({ title: '已撤销', variant: 'info', position: 'TC' });
          }
        } else if (itemId === 'login') {
          ctx.ui.showToast({ title: '已填入', description: `「${label}」的测试 prompt`, variant: 'success' });
        } else {
          ctx.ui.showMessage(`已填入「${label}」的测试 prompt`, 'info');
        }
        ctx.logger.info(`composer action selected: ${itemId}`);
      },
    }),
  );

  ctx.logger.info('form-test extension ready — 4 tools + 1 composer action registered');
}

export function deactivate(): void {
  // 清理工作在 ctx.subscriptions dispose 中自动完成
}
