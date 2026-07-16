import type * as finch from 'finch';

const STORAGE_KEY = 'tasks.v1';
const MAX_TITLE_LENGTH = 200;
const ICON_PACK_ID = 'todo-list';
const SQUARE_ICON = `ext:${ICON_PACK_ID}/square` as const;
const MENU_TITLE_MAX_WIDTH = 28;

type TodoStatus = 'todo' | 'in_progress' | 'completed';

// hoverText is supported by current Finch runtimes and will be included in the next API package.
type MenuItem = Omit<finch.ComposerActionMenuItem, 'children'> & {
  readonly hoverText?: string;
  readonly children?: MenuItem[];
};

interface TodoTask {
  id: string;
  title: string;
  status: TodoStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

interface MatchResult {
  task?: TodoTask;
  matches?: TodoTask[];
}

let mutationQueue: Promise<void> = Promise.resolve();

function normalizeTask(value: unknown): TodoTask | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const task = value as Record<string, unknown>;
  if (typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.createdAt !== 'string') {
    return undefined;
  }

  let status: TodoStatus;
  if (task.status === 'todo' || task.status === 'in_progress' || task.status === 'completed') {
    status = task.status;
  } else if (typeof task.completed === 'boolean') {
    status = task.completed ? 'completed' : 'todo';
  } else {
    return undefined;
  }

  return {
    id: task.id,
    title: task.title,
    status,
    createdAt: task.createdAt,
    startedAt: typeof task.startedAt === 'string' ? task.startedAt : undefined,
    completedAt: typeof task.completedAt === 'string' ? task.completedAt : undefined,
  };
}

async function loadTasks(ctx: finch.ExtensionContext): Promise<TodoTask[]> {
  const stored = await ctx.storage.get<unknown>(STORAGE_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.map(normalizeTask).filter((task): task is TodoTask => task !== undefined);
}

async function mutateTasks<T>(
  ctx: finch.ExtensionContext,
  mutation: (tasks: TodoTask[]) => T | Promise<T>,
): Promise<T> {
  const operation = mutationQueue.then(async () => {
    const tasks = await loadTasks(ctx);
    const result = await mutation(tasks);
    await ctx.storage.set(STORAGE_KEY, tasks);
    return result;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function cleanTitle(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE_LENGTH);
}

function isVersionAtLeast(current: string, minimum: string): boolean {
  const parse = (version: string) => version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const currentParts = parse(current);
  const minimumParts = parse(minimum);
  for (let index = 0; index < Math.max(currentParts.length, minimumParts.length); index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (currentPart !== minimumPart) return currentPart > minimumPart;
  }
  return true;
}

function menuTitle(title: string, supportsHoverText: boolean): Pick<MenuItem, 'label' | 'hoverText'> {
  const characters = Array.from(title);
  const widthOf = (character: string) => /[^\u0000-\u00ff]/u.test(character) ? 2 : 1;
  const totalWidth = characters.reduce((sum, character) => sum + widthOf(character), 0);
  if (totalWidth <= MENU_TITLE_MAX_WIDTH) return { label: title };

  const visible: string[] = [];
  let width = 0;
  for (const character of characters) {
    const nextWidth = width + widthOf(character);
    if (nextWidth > MENU_TITLE_MAX_WIDTH - 3) break;
    visible.push(character);
    width = nextWidth;
  }
  const label = `${visible.join('').trimEnd()}...`;
  return supportsHoverText ? { label, hoverText: title } : { label };
}

function findTask(tasks: TodoTask[], queryValue: unknown): MatchResult {
  const query = String(queryValue ?? '').trim().toLocaleLowerCase();
  if (!query) return {};

  const byId = tasks.find((task) => task.id.toLocaleLowerCase() === query);
  if (byId) return { task: byId };

  const exact = tasks.filter((task) => task.title.toLocaleLowerCase() === query);
  if (exact.length === 1) return { task: exact[0] };
  if (exact.length > 1) return { matches: exact };

  const partial = tasks.filter((task) => task.title.toLocaleLowerCase().includes(query));
  if (partial.length === 1) return { task: partial[0] };
  if (partial.length > 1) return { matches: partial };
  return {};
}

function matchError(ctx: finch.ExtensionContext, query: unknown, matches?: TodoTask[]): string {
  const value = String(query ?? '').trim();
  if (!matches?.length) return ctx.i18n.t('result.notFound', { query: value });
  const list = matches.map((task) => `- ${task.title} — ${task.id}`).join('\n');
  return ctx.i18n.t('result.ambiguous', { query: value, matches: list });
}

function textResult(text: string): finch.ToolResult {
  return { content: [{ type: 'text', text }] };
}

function formatTasks(ctx: finch.ExtensionContext, tasks: TodoTask[], includeCompleted: boolean): string {
  const inProgress = tasks
    .filter((task) => task.status === 'in_progress')
    .sort((a, b) => (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt));
  const todo = tasks
    .filter((task) => task.status === 'todo')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const completed = tasks
    .filter((task) => task.status === 'completed')
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));

  if (inProgress.length === 0 && todo.length === 0 && (!includeCompleted || completed.length === 0)) {
    return ctx.i18n.t('result.empty');
  }

  const sections: string[] = [];
  const appendSection = (title: string, rows: string[]) => {
    if (rows.length === 0) return;
    if (sections.length > 0) sections.push('');
    sections.push(`## ${title}`, ...rows);
  };

  appendSection(
    ctx.i18n.t('result.list.inProgress'),
    inProgress.map((task) => `- [ ] ${task.title} \`${task.id}\``),
  );
  appendSection(
    ctx.i18n.t('result.list.todo'),
    todo.map((task) => `- [ ] ${task.title} \`${task.id}\``),
  );
  if (includeCompleted) {
    appendSection(
      ctx.i18n.t('result.list.completed'),
      completed.map((task) => `- [x] ${task.title} \`${task.id}\``),
    );
  }

  sections.push(
    '',
    ctx.i18n.t('result.list.summary', {
      inProgress: inProgress.length,
      todo: todo.length,
      completed: completed.length,
    }),
  );
  return sections.join('\n');
}

function registerTools(ctx: finch.ExtensionContext, notifyUpdate: () => void): void {
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'todo_list_add',
      title: ctx.i18n.t('tool.add.title'),
      description: ctx.i18n.t('tool.add.description'),
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: ctx.i18n.t('tool.add.input.title') },
        },
        required: ['title'],
      },
      risk: 'low',
      async execute(input) {
        const title = cleanTitle((input as { title?: unknown }).title);
        if (!title) return textResult(ctx.i18n.t('result.invalidTitle'));

        const task = await mutateTasks(ctx, (tasks) => {
          const next: TodoTask = {
            id: createId(),
            title,
            status: 'todo',
            createdAt: new Date().toISOString(),
          };
          tasks.push(next);
          return next;
        });
        notifyUpdate();
        return textResult(ctx.i18n.t('result.added', { title: task.title, id: task.id }));
      },
    }),
    ctx.tools.register({
      name: 'todo_list_list',
      title: ctx.i18n.t('tool.list.title'),
      description: ctx.i18n.t('tool.list.description'),
      inputSchema: {
        type: 'object',
        properties: {
          includeCompleted: {
            type: 'boolean',
            description: ctx.i18n.t('tool.list.input.includeCompleted'),
          },
        },
      },
      risk: 'low',
      async execute(input) {
        const { includeCompleted = false } = input as { includeCompleted?: boolean };
        return textResult(formatTasks(ctx, await loadTasks(ctx), includeCompleted));
      },
    }),
    ctx.tools.register({
      name: 'todo_list_start',
      title: ctx.i18n.t('tool.start.title'),
      description: ctx.i18n.t('tool.start.description'),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: ctx.i18n.t('tool.start.input.query') },
        },
        required: ['query'],
      },
      risk: 'low',
      async execute(input) {
        const query = (input as { query?: unknown }).query;
        const result = await mutateTasks(ctx, (tasks) => {
          const match = findTask(tasks.filter((task) => task.status === 'todo'), query);
          if (!match.task) return match;
          match.task.status = 'in_progress';
          match.task.startedAt = new Date().toISOString();
          return match;
        });
        if (!result.task) return textResult(matchError(ctx, query, result.matches));
        notifyUpdate();
        return textResult(ctx.i18n.t('result.started', { title: result.task.title }));
      },
    }),
    ctx.tools.register({
      name: 'todo_list_complete',
      title: ctx.i18n.t('tool.complete.title'),
      description: ctx.i18n.t('tool.complete.description'),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: ctx.i18n.t('tool.complete.input.query') },
        },
        required: ['query'],
      },
      risk: 'medium',
      async execute(input) {
        const query = (input as { query?: unknown }).query;
        const result = await mutateTasks(ctx, (tasks) => {
          const match = findTask(tasks.filter((task) => task.status !== 'completed'), query);
          if (!match.task) return match;
          match.task.status = 'completed';
          match.task.completedAt = new Date().toISOString();
          return match;
        });
        if (!result.task) return textResult(matchError(ctx, query, result.matches));
        notifyUpdate();
        return textResult(ctx.i18n.t('result.completed', { title: result.task.title }));
      },
    }),
    ctx.tools.register({
      name: 'todo_list_delete',
      title: ctx.i18n.t('tool.delete.title'),
      description: ctx.i18n.t('tool.delete.description'),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: ctx.i18n.t('tool.delete.input.query') },
        },
        required: ['query'],
      },
      risk: 'medium',
      async execute(input) {
        const query = (input as { query?: unknown }).query;
        const result = await mutateTasks(ctx, (tasks) => {
          const match = findTask(tasks, query);
          if (!match.task) return match;
          tasks.splice(tasks.indexOf(match.task), 1);
          return match;
        });
        if (!result.task) return textResult(matchError(ctx, query, result.matches));
        notifyUpdate();
        return textResult(ctx.i18n.t('result.deleted', { title: result.task.title }));
      },
    }),
  );
}

function quickActions(ctx: finch.ExtensionContext): MenuItem[] {
  return [
    {
      id: 'add',
      label: ctx.i18n.t('menu.add'),
      description: ctx.i18n.t('menu.add.desc'),
      iconName: 'notebook-pen',
      group: 'quick',
      groupLabel: ctx.i18n.t('menu.quick'),
    },
    {
      id: 'view',
      label: ctx.i18n.t('menu.view'),
      description: ctx.i18n.t('menu.view.desc'),
      iconName: 'list',
      group: 'quick',
    },
    {
      id: 'automation',
      label: ctx.i18n.t('menu.automation'),
      description: ctx.i18n.t('menu.automation.desc'),
      iconName: 'timer',
      group: 'quick',
    },
  ];
}

function inProgressItems(
  ctx: finch.ExtensionContext,
  tasks: TodoTask[],
  supportsHoverText: boolean,
): MenuItem[] {
  const inProgress = tasks
    .filter((task) => task.status === 'in_progress')
    .sort((a, b) => (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt));

  if (inProgress.length === 0) {
    return [{
      id: 'in-progress-empty',
      label: ctx.i18n.t('menu.inProgress.empty'),
      iconName: SQUARE_ICON,
      disabled: true,
      group: 'in-progress',
      groupLabel: ctx.i18n.t('menu.inProgress.group'),
    }];
  }

  return inProgress.map((task, index) => ({
    id: `complete:${task.id}`,
    ...menuTitle(task.title, supportsHoverText),
    iconName: SQUARE_ICON,
    group: 'in-progress',
    groupLabel: index === 0 ? ctx.i18n.t('menu.inProgress.group') : undefined,
    groupMaxVisible: index === 0 ? 6 : undefined,
  }));
}

function todoMenu(
  ctx: finch.ExtensionContext,
  tasks: TodoTask[],
  supportsHoverText: boolean,
): MenuItem {
  const todo = tasks
    .filter((task) => task.status === 'todo')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (todo.length === 0) {
    return {
      id: 'todo-empty',
      label: ctx.i18n.t('menu.todo.empty'),
      iconName: 'clipboard',
      disabled: true,
      group: 'todo-root',
      groupLabel: ctx.i18n.t('menu.todo'),
    };
  }

  return {
    id: 'todo-menu',
    label: ctx.i18n.t('menu.todo.count', { count: todo.length }),
    iconName: 'clipboard-list',
    group: 'todo-root',
    groupLabel: ctx.i18n.t('menu.todo'),
    children: todo.map((task, index) => ({
      id: `start:${task.id}`,
      ...menuTitle(task.title, supportsHoverText),
      iconName: SQUARE_ICON,
      group: 'todo',
      groupLabel: index === 0 ? ctx.i18n.t('menu.todo.group') : undefined,
      groupMaxVisible: index === 0 ? 6 : undefined,
    })),
  };
}

export function activate(ctx: finch.ExtensionContext): void {
  ctx.logger.info('todo-list activating');

  ctx.subscriptions.push(ctx.icons.register(ICON_PACK_ID, {
    square: {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>',
      description: 'Unchecked todo item',
    },
  }));

  let notifyUpdate: () => void = () => {};
  const action = ctx.composerActions.register('todo-list', {
    async getBadge() {
      const inProgress = (await loadTasks(ctx))
        .filter((task) => task.status === 'in_progress').length;
      return inProgress > 0
        ? ctx.i18n.t('badge.inProgress', { count: inProgress })
        : ctx.i18n.t('badge.empty');
    },

    async getMenu() {
      const tasks = await loadTasks(ctx);
      const appInfo = await ctx.app.getInfo();
      const supportsHoverText = isVersionAtLeast(appInfo.version, '1.5.1');
      return [
        ...quickActions(ctx),
        ...inProgressItems(ctx, tasks, supportsHoverText),
        todoMenu(ctx, tasks, supportsHoverText),
      ];
    },

    async execute(_actionContext, itemId, actions) {
      if (itemId === 'add') {
        await actions.composer.fill(ctx.i18n.t('prompt.add'));
        return;
      }
      if (itemId === 'view') {
        await actions.composer.fill(ctx.i18n.t('prompt.view'));
        return;
      }
      if (itemId === 'automation') {
        await actions.composer.fill(ctx.i18n.t('prompt.automation'));
        return;
      }
      if (itemId.startsWith('start:')) {
        const id = itemId.slice('start:'.length);
        const changed = await mutateTasks(ctx, (tasks) => {
          const task = tasks.find((candidate) => candidate.id === id && candidate.status === 'todo');
          if (!task) return false;
          task.status = 'in_progress';
          task.startedAt = new Date().toISOString();
          return true;
        });
        if (changed) notifyUpdate();
        return;
      }
      if (!itemId.startsWith('complete:')) return;

      const id = itemId.slice('complete:'.length);
      const task = (await loadTasks(ctx)).find(
        (candidate) => candidate.id === id && candidate.status === 'in_progress',
      );
      if (!task) return;

      const confirmation = await actions.composer.confirm({
        text: ctx.i18n.t('confirm.complete', { title: task.title }),
        confirmLabel: ctx.i18n.t('confirm.complete.confirm'),
        cancelLabel: ctx.i18n.t('confirm.complete.cancel'),
      });
      if (confirmation !== 'confirm') return;

      const changed = await mutateTasks(ctx, (tasks) => {
        const current = tasks.find(
          (candidate) => candidate.id === id && candidate.status === 'in_progress',
        );
        if (!current) return false;
        current.status = 'completed';
        current.completedAt = new Date().toISOString();
        return true;
      });
      if (changed) notifyUpdate();
    },
  });
  notifyUpdate = () => action.notifyUpdate();
  ctx.subscriptions.push(action);

  registerTools(ctx, notifyUpdate);
  ctx.subscriptions.push(ctx.i18n.onDidChangeLocale(notifyUpdate));
  ctx.logger.info('todo-list activated — 5 tools + 1 composer action');
}

export function deactivate(): void {
  // ctx.subscriptions handles cleanup.
}
