/*!
 * Finch Extension API
 *
 * Use this published type package as the `finch` module alias in `tsconfig.json`.
 * Runtime APIs still come through `ctx`:
 *
 * ```ts
 * import type * as finch from 'finch';
 *
 * export function activate(ctx: finch.MiniToolContext) {
 *   ctx.subscriptions.push(
 *     ctx.tools.register({ ... }),
 *     ctx.composerActions.register('my-btn', { ... }),
 *   );
 * }
 *
 * export function deactivate() { }
 * ```
 *
 * `import type` is erased at compile time. The `finch` module name is only a type alias; runtime APIs still come through `ctx`.
 * Full docs: https://finchwork.app/docs/mini-tools
 */
declare module 'finch' {

  // ════════════════════════════════════════════════════════════════════════════
  // § 0  通用原语
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * 代表一个可以被注销的资源句柄。
   * 与 VS Code 保持一致：用 `ExtensionContext.subscriptions.push(d)` 统一管理生命周期。
   *
   * @example
   * const d = finch.tools.register({ ... });
   * ctx.subscriptions.push(d);
   */
  export interface Disposable {
    dispose(): void;
  }

  export namespace Disposable {
    /** 将多个 Disposable 合并为一个。 */
    function from(...disposables: { dispose(): unknown }[]): Disposable;
  }

  /**
   * 类型安全的事件，可附加任意数量的监听器。
   *
   * @example
   * finch.session.onDidChange(e => console.log('session changed', e));
   */
  export interface Event<T> {
    (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]): Disposable;
  }

  /** 手动触发 {@link Event} 的发射器，仅供内部能力扩展使用。 */
  export class EventEmitter<T> {
    readonly event: Event<T>;
    fire(data: T): void;
    dispose(): void;
  }

  /** 取消令牌，传递给长时操作以支持中止。 */
  export interface CancellationToken {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested: Event<unknown>;
  }

  /**
   * 统一资源标识符，适用于文件路径、远程 URL 等。
   *
   * @example
   * const uri = finch.Uri.file('/Users/alice/project/README.md');
   * const http = finch.Uri.parse('https://example.com');
   */
  export class Uri {
    static file(path: string): Uri;
    static parse(value: string, strict?: boolean): Uri;
    static joinPath(base: Uri, ...pathSegments: string[]): Uri;

    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
    readonly fsPath: string;

    with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri;
    toString(skipEncoding?: boolean): string;
    toJSON(): object;
  }

  /** 支持内联 Markdown 的富文本，渲染时保留基本格式。 */
  export class MarkdownString {
    value: string;
    isTrusted?: boolean;
    constructor(value?: string, supportThemeIcons?: boolean);
    appendText(value: string): MarkdownString;
    appendMarkdown(value: string): MarkdownString;
    appendCodeblock(value: string, language?: string): MarkdownString;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 1  插件生命周期
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * 插件激活时注入的上下文对象，也是插件能力的唯一入口。
   *
   * **生命周期**：将所有 {@link Disposable} 推入 `subscriptions`，
   * Finch 在插件停用时会自动调用 `dispose()`。
   *
   * **所有 API 均挂载在 ctx 上**，无需再从 `finch` 模块调用全局函数：
   * - `ctx.tools` — Agent 工具注册
   * - `ctx.composerActions` — Composer 工具栏按钮
   * - `ctx.storage` — 私有 KV 存储
   * - `ctx.secrets` — 只读密钥
   * - `ctx.logger` — 带前缀日志
   * - `ctx.app` — Finch App 基本信息（只读）
   * - `ctx.session` — 当前 session（只读）
   * - `ctx.workspace` — 当前 workspace（只读）
   *
   * @example
   * export function activate(ctx: finch.MiniToolContext) {
   *   ctx.subscriptions.push(
   *     ctx.tools.register({ name: 'greet', ... }),
   *     ctx.composerActions.register('my-btn', { ... }),
   *   );
   *   ctx.logger.info('activated');
   * }
   *
   * @deprecated Use {@link MiniToolContext} for new mini tools.
   */
  export interface ExtensionContext {
    /**
     * 推入此数组的 Disposable 将在插件停用时自动 `dispose()`。
     * 无需手动管理生命周期。
     */
    readonly subscriptions: { dispose(): unknown }[];

    /** 插件元信息（只读）。 */
    readonly extension: ExtensionInfo;

    /**
     * 插件私有持久化存储目录的绝对路径。
     * 由 Finch 预先创建，插件可在此读写文件（复杂状态持久化）。
     * 简单 KV 场景直接使用 `ctx.storage`。
     */
    readonly storagePath: string;

    // ── 注册 API ──────────────────────────────────────────────────────────────

    /**
     * Agent 工具注册表。
     *
     * @example
     * ctx.subscriptions.push(
     *   ctx.tools.register({
     *     name: 'search',
     *     title: 'Search',
     *     description: '...',
     *     inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
     *     async execute({ query }, exec) {
     *       return { content: [{ type: 'text', text: await doSearch(query) }] };
     *     },
     *   }),
     * );
     */
    readonly tools: {
      register(definition: ToolDefinition): Disposable;
      registerSearchProvider(provider: ToolSearchProvider): Disposable;
    };

    /**
     * Composer 工具栏按钮注册表。
     * manifest 的 `contributes.composerActions` 声明按钮槽位（icon / tooltip），
     * `register()` 提供动态数据（badge / menu / execute）。
     * `actionId` 必须与 manifest 中的 `id` 匹配。
     *
     * @example
     * ctx.subscriptions.push(
     *   ctx.composerActions.register('git-branch', {
     *     async getBadge({ cwd }) { return getCurrentBranch(cwd); },
     *     async getMenu({ cwd })  { return listBranches(cwd).map(b => ({ id: b, label: b })); },
     *     async execute({ cwd }, itemId, actions) { await checkout(cwd, itemId); },
     *   }),
     * );
     */
    readonly composerActions: {
      register(actionId: string, provider: ComposerActionProvider): Disposable & {
        /**
         * Signal the app that this action's badge or icon may have changed.
         * Triggers a re-fetch so `getBadge()` is called again and the toolbar updates.
         *
         * Use when the mini tool polls external state (e.g. git status, a counter)
         * and needs the badge to update without waiting for user interaction.
         *
         * @example
         * const action = ctx.composerActions.register('git-watch', provider);
         * ctx.subscriptions.push(action);
         *
         * const timer = setInterval(async () => {
         *   if (await gitStatusChanged()) action.notifyUpdate();
         * }, 5000);
         * ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
         */
        notifyUpdate(): void;
      };
    };

    /**
     * 命令注册表（Phase 2，预留）。
     * @example
     * ctx.subscriptions.push(
     *   ctx.commands.register('myextension.hello', () => ctx.ui.showMessage('hi')),
     * );
     */
    readonly commands: {
      register(commandId: string, handler: (...args: unknown[]) => unknown): Disposable;
    };

    /**
     * UI 扩展能力。
     * `showToast()` 可用于展示轻量、非阻塞通知；Webview Panel 仍为预留 API。
     * @example
     * ctx.ui.showToast({ title: 'Saved', variant: 'success', position: 'TC' });
     */
    readonly ui: {
      createWebviewPanel(options: WebviewPanelOptions): WebviewPanel;
      /**
       * 创建一个透明、无边框、可拖到任意位置、可置顶的**浮动 Canvas 窗口**。
       *
       * 与 `createWebviewPanel`（内嵌 Panel）正交：Canvas 窗口是独立顶层窗，适合桌宠、
       * 悬浮工具、桌面小游戏等。开发者**不写 HTML**，只提供一段 canvas 脚本（`entry`），
       * 脚本内调用 `finch.canvas.define({ init, frame, ... })` 注册生命周期。Finch 提供
       * 统一外壳，负责透明窗壳、devicePixelRatio 缩放、rAF 循环、事件分发与双向通信。
       *
       * Phase 1 每个扩展只允许一个 Canvas 窗口，重复调用会替换现有窗口。
       *
       * @example
       * // Host 段
       * const win = ctx.ui.createCanvasWindow({ entry: 'dist/pet-canvas.js', width: 220, height: 220, alwaysOnTop: true });
       * win.onDidReceiveMessage((msg) => ctx.logger.info('from canvas', msg));
       * win.postMessage({ type: 'status', value: 'running' });
       */
      createCanvasWindow(options: CanvasWindowOptions): CanvasWindow;
      showToast(options: ToastOptions): Promise<ToastResult>;
      showConfirmDialog(options: ConfirmDialogOptions): Promise<ConfirmDialogResult>;
      showModalDialog(options: ModalDialogOptions): Promise<ModalDialogResult>;
      showMessage(message: string, type?: 'info' | 'warning' | 'error'): void;
    };

    /**
     * 能力（capabilities）—— 插件之间的解耦协作机制。
     *
     * 官方插件可以 `provide` 一个具名能力（一组异步方法），其它插件通过
     * `get` 获取并调用，而无需直接 import 对方代码。能力调用跨进程路由，
     * 因此消费侧每个方法都返回 Promise。
     *
     * - 提供方必须在 manifest `provides.capabilities` 声明能力名。
     * - 消费方必须在 manifest `requires.capabilities` 声明能力名。
     *
     * @example 提供方
     * ctx.subscriptions.push(
     *   ctx.capabilities.provide('mcp.client', {
     *     async listTools(server) { return await mcp.listTools(server); },
     *     async callTool(server, name, args) { return await mcp.callTool(server, name, args); },
     *   }),
     * );
     *
     * @example 消费方
     * interface McpClient {
     *   listTools(server: string): Promise<unknown>;
     *   callTool(server: string, name: string, args: unknown): Promise<unknown>;
     * }
     * const mcp = ctx.capabilities.get<McpClient>('mcp.client');
     * const tools = await mcp.listTools('filesystem');
     */
    readonly capabilities: Capabilities;

    /**
     * 运行时图标包注册。manifest 只声明 `contributes.iconPacks` 的包名，实际图标
     * 在代码里注册为 SVG 字符串。主进程会先消毒 SVG，再交给渲染层使用。
     *
     * @example
     * ctx.subscriptions.push(ctx.icons.register('git-branch', {
     *   plus: { svg: '<svg viewBox="0 0 24 24">...</svg>' },
     * }));
     */
    readonly icons: Icons;

    /**
     * 扩展 manifest contribution 快照。Host 只按 extension point 名称透传原始值，
     * 具体语义由消费扩展自行定义。
     */
    readonly extensions: Extensions;

    /**
     * 运行时事件订阅。插件可只读观察 Finch 的 Agent 运行事件，用于状态展示或轻量遥测。
     * 事件为 best-effort 推送；监听器抛错不会影响 Agent 主流程。
     *
     * @example
     * ctx.subscriptions.push(ctx.events.onAgentEvent((event) => {
     *   if (event.kind === 'tool_use') ctx.logger.info('tool started', event.toolName);
     *   if (event.kind === 'session_status') ctx.logger.info('run status', event.runStatus);
     * }));
     */
    readonly events: Events;

    /** 聚合后的 Finch 当前状态，适合 badge、浮窗、状态展示等低频 UI。 */
    readonly status: Status;

    /** Finch 发出的用户可见通知事件。 */
    readonly notifications: Notifications;

    /**
     * 扩展运行时 i18n。读取当前扩展目录下的 `i18n/<locale>.json`，自动跟随 Finch app 语言。
     *
     * @example
     * ctx.i18n.t('toast.done', { name: 'GitHub' });
     */
    readonly i18n: ExtensionI18n;

    // ── 服务 ──────────────────────────────────────────────────────────────────

    /** 插件私有 KV 存储。 */
    readonly storage: Storage;

    /**
     * 用户在插件详情页配置的设置（由 manifest `settings` schema 声明，Finch
     * 原生渲染表单）。只读；用户保存后插件会重新加载，届时重新读取。
     */
    readonly settings: Settings;

    /** 带插件 id 前缀的日志。 */
    readonly logger: Logger;

    /** 对 manifest `permissions.secrets` 声明的密钥的只读访问。 */
    readonly secrets: Secrets;

    /** Finch App 基本信息（只读）。 */
    readonly app: App;

    /** 当前 session 信息（只读快照）。 */
    readonly session: SessionInfo;

    /** 当前 Space / Workspace 信息（只读）。 */
    readonly workspace: WorkspaceInfo;
  }

  /** Finch App 运行平台。 */
  export type AppPlatform = 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'netbsd' | 'openbsd' | 'sunos' | 'win32' | 'cygwin';

  /** Finch App 基本信息。 */
  export interface AppInfo {
    /** 应用名称。 */
    readonly name: 'Finch';
    /** 语义化版本号，例如 `1.5.0`。 */
    readonly version: string;
    /** 内部构建号。 */
    readonly buildNumber: number;
    /** 面向用户展示的完整版本，例如 `1.5.0(1456)`。 */
    readonly versionDisplay: string;
    /** 当前解析后的 App 语言。 */
    readonly locale: AppLocale;
    /** 当前操作系统平台，对齐 Node.js `process.platform`。 */
    readonly platform: AppPlatform;
    /** Finch API User-Agent 字符串。 */
    readonly userAgent: string;
    /** 用户自定义的助手名称，例如 "帕亚"。未设置时为默认值 "Finch"。 */
    readonly assistantName: string;
  }

  /** Finch App 只读信息入口。 */
  export interface App {
    /** 获取当前 Finch App 基本信息。 */
    getInfo(): Promise<AppInfo>;
  }

  /**
   * 插件自身元信息。
   * @deprecated Use {@link MiniToolInfo} for new mini tools.
   */
  export interface ExtensionInfo {
    /** 插件全局唯一 id，来自 manifest `finch.id`。 */
    readonly id: string;
    readonly displayName: string;
    readonly version: string;
    /** 插件安装目录绝对路径。 */
    readonly extensionPath: string;
    readonly isActive: boolean;
    readonly scope: 'global' | 'space';
    readonly spaceId?: string;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 2  Session & Workspace（只读上下文）
  // ════════════════════════════════════════════════════════════════════════════

  /** 当前 session 的只读快照。 */
  export interface SessionInfo {
    readonly id: string;
    /** session 标题，可为 undefined（未命名 session）。 */
    readonly title: string | undefined;
    readonly spaceId: string | undefined;
    /** 有效工作目录（Space.directoryPath 或 workspace.projectPath）。 */
    readonly cwd: string | undefined;
    readonly model: string;
  }

  /** 当前激活 Space 或默认 Workspace 的信息。 */
  export interface WorkspaceInfo {
    /** Space id，默认 session 下为 undefined。 */
    readonly spaceId: string | undefined;
    readonly spaceName: string | undefined;
    /** Space 绑定的目录（可选）。 */
    readonly directoryPath: string | undefined;
    /** 全局默认工作目录（用户设置的 projectPath）。 */
    readonly projectPath: string | undefined;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 3  finch.tools — Agent 工具
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * 插件自定义表单中的单个字段，渲染在等候区表单卡片里。
   * @deprecated Use {@link MiniToolFormField} for new mini tools.
   */
  export interface ExtensionFormField {
    /** 表单值映射中的唯一 key。 */
    readonly key: string;
    readonly label: string;
    readonly type: 'text' | 'password' | 'textarea' | 'number' | 'select' | 'boolean' | 'link';
    readonly placeholder?: string;
    readonly description?: string;
    readonly required?: boolean;
    readonly default?: string | number | boolean;
    /** `select` 字段的可选项。 */
    readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
    /**
     * 标记敏感字段。UI 会渲染密码框，且插件作者**绝不可**把它的值写回模型可见的 ToolResult。
     */
    readonly secret?: boolean;
    /**
     * 字段宽度占比，基于每行 6 格栅格自动排布：`full`（整行）/ `'1/2'` / `'1/3'` / `'2/3'`。
     * 字段按声明顺序从左到右填入，一行占满后自动换行；放不下的字段落到下一行。
     * 省略视为 `full`。`textarea` 始终独占整行。
     *
     * @example
     * fields: [
     *   { key: 'host', label: '主机', width: '2/3' },
     *   { key: 'port', label: '端口', width: '1/3', type: 'number' }, // 与 host 同一行（2/3 + 1/3）
     *   { key: 'a', label: 'A', width: '1/2' },
     *   { key: 'b', label: 'B', width: '1/2' },                       // 各占半行
     *   { key: 'note', label: '备注', type: 'textarea' },            // 独占整行
     * ]
     */
    readonly width?: 'full' | '1/2' | '1/3' | '2/3';
    /**
     * 仅 `type: 'link'` 字段使用：点击后由系统默认浏览器打开的外部链接地址。link 字段是
     * 纯展示元素（渲染为可点击链接，`label` 为显示文字），不产生表单值、不参与提交。
     * 用于把用户引到服务商注册页获取 API Key 等外部页面，可配合 `width` 与其他字段并排。
     *
     * @example
     * fields: [
     *   { key: 'apiKey', label: 'API Key', type: 'password', secret: true, width: '2/3' },
     *   { key: 'signup', label: '去注册获取 Key', type: 'link',
     *     href: 'https://app.tavily.com', width: '1/3' }, // 与 apiKey 同一行
     * ]
     */
    readonly href?: string;
  }

  /**
   * `ctx.ui.requestForm` 的表单描述 —— 用户在工具调用期间填写。
   * @deprecated Use {@link MiniToolFormSpec} for new mini tools.
   */
  export interface ExtensionFormSpec {
    readonly title: string;
    readonly description?: string;
    readonly submitLabel?: string;
    readonly cancelLabel?: string;
    readonly fields: ExtensionFormField[];
    /**
     * 可选自动取消超时（毫秒）。超时未提交则 resolve 为
     * `{ submitted: false, reason: 'timeout' }`。省略则一直等待用户提交/取消或 session 结束。
     */
    readonly timeoutMs?: number;
  }

  /**
   * 用户提交或取消表单后返回给插件的结果。
   * @deprecated Use {@link MiniToolFormResult} for new mini tools.
   */
  export interface ExtensionFormResult {
    /** 用户取消、超时、或 session 未提交即结束时为 false。 */
    readonly submitted: boolean;
    readonly values: Record<string, string | number | boolean>;
    /** 非提交结算的原因；submitted 为 true 时不存在。 */
    readonly reason?: 'cancelled' | 'timeout' | 'session-ended';
  }

  /** 工具执行期可用的 UI 交互面（表单）。 */
  export interface ToolUi {
    /**
     * 在等候区弹出一个插件自定义表单，用户提交后 resolve 为填写的值。
     * 敏感字段由用户直接输入；返回给模型的内容（如果有）由插件自行决定。
     */
    requestForm(spec: ExtensionFormSpec): Promise<ExtensionFormResult>;
  }

  /**
   * 工具执行时注入的上下文（每次调用独立生命周期）。
   *
   * 包含 cwd、session 元信息及与平台交互的服务句柄。
   */
  export interface ToolExecutionContext {
    readonly toolCallId: string;
    readonly sessionId: string;
    readonly spaceId: string | undefined;
    /** 当前有效工作目录。 */
    readonly cwd: string | undefined;
    /** 用户或超时触发中止时进入 aborted 状态；未中止或宿主未提供时为 undefined。 */
    readonly signal?: AbortSignal;
    readonly logger: Logger;
    readonly storage: Storage;
    readonly secrets: Secrets;
    /** 工具执行期的交互 UI 面（表单）。 */
    readonly ui: ToolUi;
  }

  /** 工具向模型返回的内容块。 */
  export type ToolContent =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

  /** 工具执行结果。 */
  export interface ToolResult {
    /** 给模型看的内容，至少一个块。 */
    readonly content: ToolContent[];
    /** 设为 true 则告知模型本次调用出错。 */
    readonly isError?: boolean;
  }

  /**
   * JSON Schema，描述工具的输入结构。
   * Finch 使用原生 JSON Schema，无需引入 zod / typebox 等运行时库。
   * 该 schema 会原样发送给模型。
   */
  export interface JsonSchema {
    readonly type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
    readonly properties?: Readonly<Record<string, JsonSchema>>;
    readonly items?: JsonSchema | readonly JsonSchema[];
    readonly required?: readonly string[];
    readonly enum?: readonly unknown[];
    readonly description?: string;
    readonly default?: unknown;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    readonly anyOf?: readonly JsonSchema[];
    readonly oneOf?: readonly JsonSchema[];
    readonly [key: string]: unknown;
  }

  /**
   * 插件贡献的 Agent 工具定义。
   *
   * @example
   * finch.tools.register({
   *   name: 'read_file',
   *   title: 'Read File',
   *   description: 'Read the content of a file. Call when asked to view or inspect file contents.',
   *   inputSchema: {
   *     type: 'object',
   *     properties: { path: { type: 'string', description: 'Absolute or relative file path.' } },
   *     required: ['path'],
   *   },
   *   async execute({ path }, ctx) {
   *     const text = await fs.readFile(path, 'utf-8');
   *     return { content: [{ type: 'text', text }] };
   *   },
   * });
   */
  export type ToolExposure = 'startup' | 'dynamic';

  export interface ToolSearchQuery {
    readonly query?: string;
    readonly source?: string;
    readonly limit?: number;
  }

  export interface ToolSearchContext {
    readonly sessionId?: string;
    readonly spaceId?: string;
    readonly cwd?: string;
  }

  export interface ToolSearchResult {
    /** 要激活的模型侧工具名，例如 `mcp__filesystem__read_file`。 */
    readonly toolName: string;
    readonly title?: string;
    readonly description?: string;
    readonly source?: string;
  }

  export interface ToolSearchProvider {
    readonly id: string;
    readonly description?: string;
    search(query: ToolSearchQuery, ctx: ToolSearchContext): Promise<ToolSearchResult[]>;
  }

  export type ToolInlineDisplayFormat = 'plain' | 'path' | 'quoted' | 'truncate';

  export interface ToolInlineDisplayField {
    /** Input path, e.g. "action" / "owner" / "repo" / "options.state". */
    readonly path: string;
    /** Optional field label prefix rendered as `label:value`. */
    readonly label?: string;
    readonly format?: ToolInlineDisplayFormat;
    /** Max text length when format=truncate, or as a generic post-format clamp. */
    readonly maxLength?: number;
  }

  export interface ToolInlineDisplaySpec {
    /** single = first non-empty field; join = combine all non-empty fields. */
    readonly mode?: 'single' | 'join';
    readonly fields: readonly ToolInlineDisplayField[];
    readonly separator?: string;
    /** Optional template like `{owner}/{repo}` or `action:{action}`. */
    readonly template?: string;
  }

  export interface ToolCallDisplay {
    /** Optional concise inline summary rendered beside the tool name. */
    readonly inline?: ToolInlineDisplaySpec;
  }

  export interface ToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
    /**
     * 插件内工具名（小写 + 数字 + 下划线）。
     * 模型看到的名称为 `<extensionId>_<name>`，例如 `myextension_read_file`。
     */
    readonly name: string;
    /** 工具栏 / 权限卡中显示的短名称。 */
    readonly title: string;
    /**
     * 给模型读的描述，决定模型在何时调用此工具。
     * 请清晰描述触发条件、副作用、输入约束。
     */
    readonly description: string;
    /** 描述 `input` 结构的 JSON Schema，原样发给模型。 */
    readonly inputSchema: JsonSchema;
    /** 默认是否启用。未指定则为 `false`（需用户手动开启）。 */
    readonly defaultEnabled?: boolean;
    /**
     * 风险等级，影响权限卡展示方式：
     * - `low`    读操作、无副作用
     * - `medium` 写操作、有限副作用
     * - `high`   删除、网络、外部服务
     */
    readonly risk?: 'low' | 'medium' | 'high';
    /**
     * 工具 schema 暴露策略：
     * - `startup` 默认值；每个新会话启动时注入工具定义。
     * - `dynamic` 不进入新会话初始工具表；仅在插件运行中注册/更新后注入活跃会话。
     *
     * 适用于 MCP server tools、按需发现的大量工具等场景，避免新会话工具表膨胀。
     */
    readonly exposure?: ToolExposure;
    /**
     * 归属覆盖。当一个插件代表「另一个插件的贡献」注册工具时（例如 MCP 桥接
     * 为其它插件贡献的 MCP server 注册工具），设置 `owner` 可让该工具的来源、
     * 权限门卫与 UI 计数归属到贡献插件，而非注册插件。省略时默认归属注册插件。
     */
    readonly owner?: { readonly extensionId: string; readonly extensionName?: string };
    /** Optional ToolCallCard inline-summary metadata. */
    readonly callDisplay?: ToolCallDisplay;
    execute(input: TInput, ctx: ToolExecutionContext): Promise<ToolResult>;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 4  finch.composerActions — Composer 工具栏扩展
  // ════════════════════════════════════════════════════════════════════════════

  /** Composer 按钮所在界面位置。 */
  export type ComposerSurface = 'home' | 'session';

  /**
   * Composer 扩展点上下文，每次调用时传入。
   */
  export interface ComposerActionContext {
    /** 当前有效工作目录（可能为 undefined）。 */
    readonly cwd: string | undefined;
    readonly sessionId: string | undefined;
    readonly spaceId: string | undefined;
    /**
     * Composer 所在界面：`'home'` = 首页/新对话（尚无进行中的 session），
     * `'session'` = 已打开的对话内。可据此对不同界面做差异化的按钮可见性判断。
     *
     * @example
     * // 只在会话内显示，首页隐藏
     * async getBadge({ surface }) {
     *   if (surface === 'home') throw new Error('hidden on home');
     *   return 'ready';
     * }
     */
    readonly surface: ComposerSurface;
  }

  /**
   * 从 `getBadge()` 返回此对象，可在文字的基础上附加 `active` 激活态。
   *
   * - `text` — 按钮右侧展示的徽标文字；省略则只显示图标（等价于返回 `undefined` 徽标）。
   * - `active` — 为 `true` 时按钮进入「激活」态：badge 文字染 accent 色、按钮背景加淡高亮。
   *   适用于计划模式、过滤器、全局开关等「开/关」场景。
   *
   * @example
   * async getBadge() {
   *   return planningMode
   *     ? { text: '计划中', active: true }   // 激活态，accent 高亮
   *     : undefined;                          // 未激活，隐藏 badge
   * }
   */
  export interface ComposerActionBadge {
    text?: string;
    active?: boolean;
  }

  /** 填充 Composer 输入框的模式。 */
  export type ComposerFillMode = 'replace' | 'append';

  /** 填充 Composer 输入框的选项。 */
  export interface ComposerFillOptions {
    /** replace（默认）覆盖当前输入；append 追加到当前输入后面。 */
    readonly mode?: ComposerFillMode;
  }

  /** 内联 Composer confirm 条的选项。 */
  export interface ComposerConfirmOptions {
    /** confirm 条上显示的提示文字。 */
    readonly text: string;
    /** 主按钮（确认）文案，默认本地化的「确认」。 */
    readonly confirmLabel?: string;
    /** 次按钮（取消）文案，默认本地化的「取消」。 */
    readonly cancelLabel?: string;
  }

  /**
   * 内联 Composer confirm 条的结果：
   *  - `'confirm'`   用户点了主按钮。
   *  - `'cancel'`    用户点了次按钮。
   *  - `'dismissed'` confirm 条被自动收起（用户忽略它、直接发消息 / 清空了会话），
   *    未做选择——按「无决定」处理。
   */
  export type ComposerConfirmResult = 'confirm' | 'cancel' | 'dismissed';

  /** Composer 域 helper。 */
  export interface ComposerActionComposerActions {
    /**
     * 向当前激活的 Composer 输入框填入文字。
     * `/skill` 指令和 `@[path]` 文件引用会渲染为富文本 token。
     */
    fill(text: string, options?: ComposerFillOptions): Promise<void>;
    /**
     * 在 Composer 上弹出一个内联 confirm 条（样式类似待发送消息，而非原生弹框），
     * 等待用户选择。与 `ctx.ui.showConfirmDialog` 不同，它不会用模态弹框阻塞整个 app，
     * 且当用户忽略它、直接发送消息时会自动收起（返回 `'dismissed'`）。
     * 在用户确认、取消或 confirm 条被收起时 resolve。
     *
     * @example
     * const r = await actions.composer.confirm({ text: '方案已就绪，开始执行？', confirmLabel: '开始执行', cancelLabel: '继续规划' });
     * if (r === 'confirm') { …关闭计划模式、注入文案… }
     */
    confirm(options: ComposerConfirmOptions): Promise<ComposerConfirmResult>;
  }

  /** Composer Action 执行期间可用的 UI 动作。 */
  export interface ComposerActionActions {
    /** Composer 域 helper：内联 confirm、填充输入框等。 */
    composer: ComposerActionComposerActions;
    /**
     * @deprecated 请使用 `actions.composer.fill(text, options)`。
     *
     * @example
     * await actions.composer.fill('帮我总结这段内容');
     * await actions.composer.fill('/pdf 请总结 @[docs/report.pdf]');
     * await actions.composer.fill('\n补充一句', { mode: 'append' });
     */
    fillComposer(text: string, options?: ComposerFillOptions): Promise<void>;
  }

  /** Composer 按钮下拉菜单中的一项。 */
  export interface ComposerActionMenuItem {
    readonly id: string;
    readonly label: string;
    /** 标记当前激活项（显示选中状态）。 */
    readonly current?: boolean;
    readonly disabled?: boolean;
    /** 在此项之前插入分割线。 */
    readonly separator?: boolean;
    /** 右侧的辅助文字（如快捷键、状态描述）。 */
    readonly description?: string;
    /** 菜单项左侧小图标，一个 {@link IconRef}（内置 Lucide 名或 `ext:<packId>/<iconId>`）。 */
    readonly iconName?: IconRef;
    /**
     * 分组 key。相邻且 `group` 相同的项归拢到一个分组区块，区块顶部显示 `groupLabel`
     * 小标题（取该组第一个项的 groupLabel）。未设置 `group` 的项属于无标题默认组。
     */
    readonly group?: string;
    /** 该项所在分组的小标题；取每组第一个带该字段的项作为标题。 */
    readonly groupLabel?: string;
    /**
     * 该分组最多展示的项数，超出部分放进内部 ScrollArea 滚动。仅在分组第一个项上生效。
     */
    readonly groupMaxVisible?: number;
    /**
     * 二级子菜单项。存在时该项 hover 展开子菜单，点击自身不触发 `execute`，
     * 只有点击子项才会以子项 id 调用 `execute`。
     *
     * @example
     * async getMenu() {
     *   return [
     *     { id: 'quick', label: '快速' },
     *     { id: 'think', label: '想一想', current: true },
     *     { id: 'model', label: 'GPT-5.5', children: [
     *       { id: 'gpt-5.5', label: 'GPT-5.5' },
     *       { id: 'opus-4.8', label: 'Opus 4.8' },
     *     ] },
     *   ];
     * }
     */
    readonly children?: ComposerActionMenuItem[];
  }

  /**
   * Composer Action 数据提供器。
   *
   * manifest 中的 `contributes.composerActions` 声明按钮槽位（id / icon / tooltip），
   * activate() 里通过 `finch.composerActions.register(id, provider)` 绑定动态数据。
   *
   * @example
   * // package.json → finch.contributes.composerActions
   * // [{ "id": "git-branch", "icon": "GitBranch", "tooltip": "切换分支" }]
   *
   * finch.composerActions.register('git-branch', {
   *   async getBadge({ cwd }) {
   *     return cwd ? getCurrentBranch(cwd) : undefined;
   *   },
   *   async getIcon({ cwd }) {
   *     return cwd ? 'GitBranch' : 'MessageCircle';
   *   },
   *   async getMenu({ cwd }) {
   *     return listBranches(cwd).map(b => ({ id: b, label: b, iconName: 'GitBranch' }));
   *   },
   *   async execute({ cwd }, branchName, actions) {
   *     await checkout(cwd, branchName);
   *     await actions.fillComposer(`已切换到 ${branchName}`);
   *   },
   * });
   */
  export interface ComposerActionProvider {
    /**
     * 返回按钮徽标。
     * - 返回字符串 → 显示在图标右侧（普通态）
     * - 返回 {@link ComposerActionBadge} `{ text?, active? }` → 可附加激活态高亮
     *   - `active: true` 使 badge 文字染 accent 色、按钮背景加淡高亮
     * - 返回 `undefined` → 只显示图标，按钮仍然可见
     * - 抛出错误 → 按钮隐藏（表示当前 cwd 不适用）
     *
     * @example 普通字符串（兼容旧用法）
     * async getBadge({ cwd }) { return getCurrentBranch(cwd); }
     *
     * @example 带激活态（计划模式 / 开关类按钮）
     * async getBadge() {
     *   return planningMode ? { text: '计划中', active: true } : undefined;
     * }
     */
    getBadge?(ctx: ComposerActionContext): Promise<string | ComposerActionBadge | undefined>;
    /**
     * 在用户发送消息前被调用。返回字符串时，Finch 将其作为 `<reminder>` 块追加到
     * 用户消息尾部；模型可见，但 UI 中不展示给用户。
     *
     * 典型用途：「计划模式」小工具在激活时，每轮消息都附加
     * `"This turn is planning only — do not perform any tool calls or side effects."` 等
     * 提示，让模型始终在约束下工作。
     *
     * - 返回字符串 → 注入到本轮消息
     * - 返回 `undefined` 或抛出错误 → 本轮不注入
     *
     * @example
     * getReminder({ cwd, surface }) {
     *   if (surface === 'home') return undefined;   // 首页无需计划约束
     *   return planningMode
     *     ? 'This turn is planning only — output a plan, do not execute any tools.'
     *     : undefined;
     * }
     */
    getReminder?(ctx: ComposerActionContext): Promise<string | undefined>;
    /**
     * 返回按钮图标的 {@link IconRef}：内置 Lucide 名（如 `'settings'`、`'timer'`、
     * `'log-in'`、`'list'`），或本扩展运行时图标包里的 icon id / `ext:<packId>/<iconId>`。
     * - 返回字符串 → 覆盖 manifest 中静态声明的 `icon`
     * - 返回 `undefined` → 使用 manifest 中的 `icon`
     * - 抛出错误 → 按钮隐藏（与 `getBadge` 保持一致）
     */
    getIcon?(ctx: ComposerActionContext): Promise<IconRef | undefined>;
    /**
     * 用户点击按钮后拉取的下拉菜单。
     * 返回空数组则显示空菜单；抛出错误则显示错误提示项。
     *
     * 当提供了 {@link onClick} 时，主点击不再触发菜单，此方法变为可选。
     * 对于纯切换按钮（计划模式、过滤器等），可省略此方法并只实现 `onClick`。
     */
    getMenu?(ctx: ComposerActionContext): Promise<ComposerActionMenuItem[]>;
    /**
     * 用户选中某个菜单项时执行。
     * @param itemId 对应 {@link ComposerActionMenuItem.id}
     */
    execute?(ctx: ComposerActionContext, itemId: string, actions: ComposerActionActions): Promise<void>;
    /**
     * 直接点击按钮时执行——**不弹出菜单**。
     *
     * 定义此方法后，按钮变为「直接点击」模式：
     * - 用户单击 → 调用 `onClick`，刷新 badge，无菜单弹出。
     * - 适合开/关切换（计划模式、全局过滤器等）。
     *
     * 与 `getBadge` `active` 配合，实现完整 check button 体验：
     *
     * @example
     * let planningMode = false;
     * const action = ctx.composerActions.register('plan-mode', {
     *   async getBadge() {
     *     return planningMode ? { text: '计划中', active: true } : undefined;
     *   },
     *   async getIcon() {
     *     return planningMode ? 'ClipboardCheck' : 'Clipboard';
     *   },
     *   async onClick() {               // ← 直接点击切换，无菜单
     *     planningMode = !planningMode;
     *   },
     *   async getReminder({ surface }) {
     *     if (!planningMode || surface === 'home') return undefined;
     *     return 'Planning only — do not execute tools this turn.';
     *   },
     * });
     * ctx.subscriptions.push(action);
     */
    onClick?(ctx: ComposerActionContext, actions: ComposerActionActions): Promise<void>;
    /**
     * 每次助手回复结束后触发一次（对应 app 的「本轮回复完成」时刻）。
     * 用来对刚产出的回复做反应——例如规划类工具在此弹出内联 `actions.confirm()` 条，
     * 询问用户是否退出计划模式、开始执行。
     *
     * 仅在 `surface === 'session'` 且存在真实 `ctx.sessionId` 时触发。
     * 抛错会被吞掉，绝不影响对话。
     *
     * @example
     * async onTurnEnd(ctx, actions) {
     *   if (!isPlanning(ctx.sessionId)) return;
     *   const r = await actions.composer.confirm({ text: '方案已就绪，开始执行？', confirmLabel: '开始执行', cancelLabel: '继续规划' });
     *   if (r === 'confirm') {
     *     setPlanning(ctx.sessionId, false);
     *     action.notifyUpdate();
     *     await actions.composer.fill('按上面的方案开始执行。');
     *   }
     * }
     */
    onTurnEnd?(ctx: ComposerActionContext, actions: ComposerActionActions): Promise<void>;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 5  finch.commands — 命令系统（reserved）
  // ════════════════════════════════════════════════════════════════════════════

  // `ctx.commands` 是**预留 API**：当前 Finch 版本未实现，调用会抛出明确的
  // "尚未实现" 错误。命令类型不再暴露全局 namespace，实现后会补齐。

  // ════════════════════════════════════════════════════════════════════════════
  // § 6  finch.ui — UI 扩展（reserved）
  // ════════════════════════════════════════════════════════════════════════════

  /** Toast 类型。 */
  export type ToastVariant = 'default' | 'success' | 'info' | 'warning' | 'error' | 'promise';

  /** Toast 出现位置：TL/TC/TR/BL/BC/BR，默认 TC。 */
  export type ToastPosition = 'TL' | 'TC' | 'TR' | 'BL' | 'BC' | 'BR';

  /** Toast 右侧动作按钮。点击后 `showToast()` resolve 为 `{ action: 'action' }`。 */
  export interface ToastActionOptions {
    readonly label: string;
  }

  /** 轻量、非阻塞通知。生命周期由 Finch 管理。 */
  export interface ToastOptions {
    /** 主标题。 */
    readonly title: string;
    /** 可选补充说明。 */
    readonly description?: string;
    /** 通知状态。默认 `default`。 */
    readonly variant?: ToastVariant;
    /** 出现位置。默认 `TC`。 */
    readonly position?: ToastPosition;
    /** 可选右侧动作按钮，例如 Undo。 */
    readonly action?: ToastActionOptions;
  }

  export interface ToastResult {
    readonly action: 'action' | 'dismissed';
  }

  export type DialogButtonVariant = 'primary' | 'secondary' | 'danger';

  export interface ConfirmDialogOptions {
    readonly title: string;
    readonly description?: string;
    /** Lightweight structured text. Supports blank lines, `code`, {text}\\g/\\r/\\y/\\m/\\a/\\b/\\i style tokens, > muted lines, and ! warning lines. */
    readonly message?: string;
    readonly confirmLabel?: string;
    readonly cancelLabel?: string;
    readonly variant?: 'primary' | 'danger';
  }

  export interface ConfirmDialogResult {
    readonly confirmed: boolean;
  }

  export interface ModalDialogActionOptions {
    readonly id: string;
    readonly label: string;
    readonly variant?: DialogButtonVariant;
  }

  export interface ModalDialogOptions {
    readonly title: string;
    readonly description?: string;
    /** Lightweight structured text. Supports blank lines, `code`, {text}\\g/\\r/\\y/\\m/\\a/\\b/\\i style tokens, > muted lines, and ! warning lines. */
    readonly message?: string;
    readonly actions?: readonly ModalDialogActionOptions[];
  }

  export interface ModalDialogResult {
    readonly action: string | 'dismissed';
  }

  /**
   * Webview Panel 选项。
   */
  export interface WebviewPanelOptions {
    /** Panel 标题。 */
    title: string;
    /** Panel 图标 Lucide 名（可选）。 */
    iconName?: string;
    /**
     * 初始 HTML 内容（完整 `<html>...</html>`）。
     * 通过 `window.acquireFinchApi()` 与主进程通信。
     */
    html: string;
    /** Panel 保持可见时是否持续渲染（默认 false，切换后内容保留但不渲染）。 */
    retainContextWhenHidden?: boolean;
  }

  /** Webview Panel 句柄，用于双向通信。 */
  export interface WebviewPanel {
    readonly title: string;
    /** 当 Panel 收到来自 webview 的消息时触发。 */
    readonly onDidReceiveMessage: Event<unknown>;
    /** 向 webview 发送消息（webview 内通过 `window.addEventListener('message')` 接收）。 */
    postMessage(message: unknown): Promise<void>;
    /** 更新 HTML 内容。 */
    setHtml(html: string): void;
    /** 关闭 Panel。 */
    dispose(): void;
    /** Panel 被用户关闭时触发。 */
    readonly onDidDispose: Event<void>;
  }

  // `ctx.ui.createWebviewPanel` 是**预留 API**：当前 Finch 版本未实现，调用会抛出明确的
  // "尚未实现" 错误。`ctx.ui.showToast` 会显示原生 Toast；`ctx.ui.showMessage` 映射为 Toast。全局 namespace 不再暴露。

  /**
   * Canvas 窗口选项。开发者只提供 `entry`（一段 canvas 脚本路径），不写 HTML。
   */
  export interface CanvasWindowOptions {
    /**
     * 开发者 canvas 脚本路径（相对扩展目录），如 `'dist/pet-canvas.js'`。
     * 脚本运行在 Finch 提供的隔离外壳里，需调用 `finch.canvas.define({ ... })` 注册生命周期。
     */
    entry: string;
    /** 初始宽度（逻辑像素）。 */
    width: number;
    /** 初始高度（逻辑像素）。 */
    height: number;
    /** 初始横坐标；缺省时屏幕居中。 */
    x?: number;
    /** 初始纵坐标；缺省时屏幕居中。 */
    y?: number;
    /** 是否置顶，默认 false。 */
    alwaysOnTop?: boolean;
    /** 是否透明背景，默认 true。 */
    transparent?: boolean;
    /** 是否允许缩放，默认 false。 */
    resizable?: boolean;
    /** 是否鼠标穿透（点击透传到下层窗口），默认 false。 */
    clickThrough?: boolean;
    /** 传给脚本 `init({ initialData })` 的初始数据（会 JSON 序列化）。 */
    initialData?: unknown;
  }

  /**
   * Canvas 窗口句柄（Host 段）。
   *
   * 窗口内脚本的运行时契约（Canvas 段）通过 `finch.canvas.define(...)` 注册：
   *
   * ```js
   * // pet-canvas.js —— 运行在 Finch canvas 外壳里，不写 HTML
   * finch.canvas.define({
   *   init({ canvas, ctx2d, width, height, dpr, finch, initialData }) {},
   *   frame(dt) {},                 // 可选：外壳驱动 requestAnimationFrame
   *   resize(width, height) {},
   *   onPointer(e) {},              // { type:'move'|'down'|'up', x, y, button }
   *   onMessage(msg) {},            // 来自 Host 段 postMessage
   *   dispose() {},
   * });
   * ```
   *
   * 外壳注入的 `finch` 桥（Canvas 段可调用）：
   * `finch.postMessage(msg)` / `finch.window.startDrag()` / `finch.window.setAlwaysOnTop(v)` /
   * `finch.window.setPosition(x,y)` / `finch.window.setClickThrough(v)` / `finch.window.close()`。
   */
  export interface CanvasWindow {
    /** 窗口唯一 id。 */
    readonly id: string;
    show(): void;
    hide(): void;
    setAlwaysOnTop(value: boolean): void;
    setPosition(x: number, y: number): void;
    setSize(width: number, height: number): void;
    setClickThrough(value: boolean): void;
    /** Host 段 → Canvas 段：脚本内 `onMessage(msg)` 接收。 */
    postMessage(message: unknown): Promise<void>;
    /** Canvas 段 → Host 段：脚本内 `finch.postMessage()` 触发。 */
    readonly onDidReceiveMessage: Event<unknown>;
    /** 窗口被移动（拖动结束或 setPosition）时触发。 */
    readonly onDidMove: Event<{ x: number; y: number }>;
    /** 窗口尺寸变化时触发。 */
    readonly onDidResize: Event<{ width: number; height: number }>;
    /** 销毁窗口。 */
    dispose(): void;
    /** 窗口被关闭 / 销毁时触发。 */
    readonly onDidDispose: Event<void>;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 6.1  Capabilities — 插件间能力协作
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * 能力实现是一组扁平的异步方法。由于提供方与消费方运行在不同进程，
   * 每个方法都通过 RPC 调用，因此消费侧总是返回 Promise。
   */
  export type CapabilityImpl = Record<string, (...args: never[]) => unknown>;

  /** `ctx.capabilities.provide` 的可选元信息。 */
  export interface CapabilityProvideOptions {
    /**
     * 能力的 semver 版本号（如 `'1.2.0'`）。消费方可用 `getVersion()` 读取并做兼容判断，
     * 避免因能力接口演进而在无版本协商下出现静默不兼容。省略则视为无版本声明。
     */
    readonly version?: string;
  }

  /** `ctx.capabilities` 的接口。 */
  export interface IconDefinition {
    /** 原始 SVG 字符串。Finch 主进程会先消毒，再交给 renderer 内联显示。 */
    readonly svg: string;
    readonly description?: string;
  }

  export interface Icons {
    /**
     * 注册一个运行时 SVG 图标包。`packId` 必须在 manifest `contributes.iconPacks` 声明。
     * 图标可通过 `ext:<packId>/<iconId>` 引用；在同一扩展内部也可用裸 `iconId` 或 `ext:<iconId>` 简写。
     */
    register(packId: string, icons: Record<string, IconDefinition>): Disposable;
  }

  export interface Capabilities {
    /**
     * 提供一个能力。仅允许 manifest `provides.capabilities` 中声明的名字。
     * 建议通过 `options.version` 声明 semver 版本，便于消费方协商兼容性。
     */
    provide(name: string, implementation: CapabilityImpl, options?: CapabilityProvideOptions): Disposable;
    /** 获取一个能力代理。仅允许 manifest `requires.capabilities` 中声明的名字。 */
    get<T = Record<string, (...args: never[]) => Promise<unknown>>>(name: string): T;
    /** 当前是否有插件提供该能力。 */
    has(name: string): boolean;
    /**
     * 读取当前 provider 声明的能力版本（semver 字符串）。无 provider 或未声明版本时为 undefined。
     * 消费方可据此判断是否满足所需最低版本。
     */
    getVersion(name: string): Promise<string | undefined>;
  }

  /** @deprecated Use {@link MiniToolContribution} for new mini tools. */
  export interface ExtensionContribution<T = unknown> {
    extensionId: string;
    extensionName: string;
    extensionPath: string;
    source: 'global' | 'personal' | 'project';
    value: T;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 6.2  Extensions — 读取其它扩展贡献
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * `ctx.extensions` 的接口：读取已启用扩展的原始 manifest contributions。
   * @deprecated Use {@link MiniToolContributions} for new mini tools.
   */
  export interface Extensions {
    listContributions<T = unknown>(point: string): ExtensionContribution<T>[];
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 6.3  Events — Finch 运行时事件订阅
  // ════════════════════════════════════════════════════════════════════════════

  export type AgentEventKind =
    | 'status'
    | 'user'
    | 'session_init'
    | 'assistant_text'
    | 'assistant_text_delta'
    | 'thinking'
    | 'thinking_delta'
    | 'tool_use'
    | 'tool_input_delta'
    | 'tool_result'
    | 'result'
    | 'error'
    | 'permission_request'
    | 'interrupted'
    | 'usage_update'
    | 'compact_boundary'
    | 'session_status';

  export interface AgentTokenUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheCreationTokens: number;
    readonly cacheReadTokens: number;
  }

  /**
   * Finch Agent 运行事件的插件可见只读快照。
   * 仅包含状态元数据；用户文本、工具输入、工具结果等内容字段会在主进程侧清洗掉。
   */
  export interface AgentEvent {
    readonly id: string;
    readonly kind: AgentEventKind;
    readonly createdAt: string;
    readonly sessionId?: string;
    readonly toolName?: string;
    readonly toolUseId?: string;
    readonly isToolError?: boolean;
    readonly isRetryable?: boolean;
    readonly errorCategory?: string;
    readonly permissionGranted?: boolean;
    readonly permissionDangerous?: boolean;
    readonly runStatus?: string;
    readonly usage?: AgentTokenUsage;
    readonly modelProvider?: string;
    readonly modelId?: string;
  }

  export interface Events {
    /** 订阅 Finch Agent 运行事件。返回的 Disposable 可用于取消订阅。 */
    onAgentEvent(listener: (event: AgentEvent) => unknown): Disposable;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 6.4  Status — Finch 聚合状态
  // ════════════════════════════════════════════════════════════════════════════

  export type FinchStatus = 'idle' | 'running' | 'waiting' | 'unread';

  export interface FinchStatusSnapshot {
    readonly status: FinchStatus;
    readonly runningCount: number;
    readonly waitingCount: number;
    readonly unreadCount: number;
    readonly updatedAt: string;
  }

  export interface Status {
    /** 读取最新聚合状态快照。 */
    get(): Promise<FinchStatusSnapshot>;
    /** 订阅聚合状态变化。 */
    onDidChange(listener: (status: FinchStatusSnapshot) => unknown): Disposable;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 6.5  Notifications — Finch 用户可见通知事件
  // ════════════════════════════════════════════════════════════════════════════

  export type FinchNotificationKind = 'background-done' | 'waiting' | 'error' | 'info';

  export interface FinchNotificationEvent {
    readonly id: string;
    readonly kind: FinchNotificationKind;
    readonly createdAt: string;
    readonly sessionId?: string;
    readonly title: string;
  }

  export interface Notifications {
    /** 订阅 Finch 发出的用户可见通知事件。 */
    onDidPost(listener: (event: FinchNotificationEvent) => unknown): Disposable;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 6.6  I18n — 扩展运行时多语言
  // ════════════════════════════════════════════════════════════════════════════

  export type AppLocale = 'zh-CN' | 'en-US';
  export type LocalePreference = 'system' | AppLocale;
  export type TranslationValue = string | number | boolean | null | undefined;
  export type TranslationValues = Record<string, TranslationValue>;

  /**
   * 扩展运行时 i18n。读取扩展自己的 `i18n/<locale>.json`。
   * @deprecated Use {@link MiniToolI18n} for new mini tools.
   */
  export interface ExtensionI18n {
    /** 当前解析后的 app 语言，例如 `zh-CN` 或 `en-US`。 */
    readonly locale: AppLocale;
    /** 按 key 翻译，支持 `{placeholder}` 参数替换；缺失 key 返回 key 本身。 */
    t(key: string, values?: TranslationValues): string;
    /** key 是否存在于当前语言或 fallback 语言中。 */
    has(key: string): boolean;
    /** 监听 Finch app 语言变化。 */
    onDidChangeLocale(listener: (locale: AppLocale) => void): Disposable;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 7  finch.storage — 插件私有 KV 存储
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * 插件私有键值存储，数据持久化在 `~/.finch/extension-data/<id>/storage.json`。
   *
   * 不要在此存储密钥或敏感数据，请用 {@link Secrets}。
   *
   * @example
   * await ctx.storage.set('lastRun', Date.now());
   * const t = await ctx.storage.get<number>('lastRun');
   */
  export interface Storage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
    /** 清空此插件的所有存储数据。 */
    clear(): Promise<void>;
    /** 返回当前所有 key。 */
    keys(): Promise<string[]>;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 7.1  finch.settings — 用户配置的只读插件设置
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * 用户配置的插件设置（只读）。字段由 manifest `settings.fields` 声明，Finch
   * 在插件详情页原生渲染表单。读取是同步的；用户保存后插件会重新加载。
   *
   * @example
   * // package.json → finch.settings.fields: [{ key: "endpoint", type: "string", label: {...} }]
   * const endpoint = ctx.settings.get<string>('endpoint');
   */
  export interface Settings {
    /** 读取某个设置项的值；未配置时返回 undefined。 */
    get<T = unknown>(key: string): T | undefined;
    /** 读取全部设置项。 */
    all(): Record<string, unknown>;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 8  finch.secrets — 密钥访问
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * 对 manifest `permissions.secrets` 中声明的密钥的只读访问。
   *
   * 密钥由 Finch 安全存储（Keychain / Secret Service），插件只能读取，无法写入。
   * 如需允许用户在 Finch 设置界面填写密钥，在 manifest 的 `permissions.secrets` 里声明 key 名。
   *
   * @example
   * // package.json → finch.permissions.secrets: ["OPENAI_API_KEY"]
   * const key = await ctx.secrets.get('OPENAI_API_KEY');
   */
  export interface Secrets {
    get(key: string): Promise<string | undefined>;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 9  finch.logger — 带前缀的日志
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * 带插件 id 前缀的日志接口，日志写入 Finch 插件日志文件。
   *
   * 在调试控制台（`Finch → 开发者工具 → 插件日志`）中可筛选查看。
   */
  export interface Logger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 10  Manifest 类型（辅助类型，供 package.json 注释使用）
  // ════════════════════════════════════════════════════════════════════════════

  /** 用户可见字符串，支持本地化。 */
  /**
   * Backward-compatible inline i18n shape for manifest fields.
   * New extensions should prefer plain strings in `package.json#finch` and put
   * locale-specific overrides in `i18n/<locale>.json`.
   */
  export type LocalizedString = string | {
    readonly default?: string;
    readonly 'en-US'?: string;
    readonly 'zh-CN'?: string;
  };

  /**
   * 扩展详情页展示的 prompt 引导语。点击后会填入 HomeView Composer。
   * @deprecated Use {@link MiniToolPromptGuide} for new mini tools.
   */
  export interface ExtensionPromptGuide {
    readonly id?: string;
    readonly title: LocalizedString;
    readonly prompt: LocalizedString;
    readonly description?: LocalizedString;
  }

  /** Mini tool 类型与来源，用于工具箱/社区展示。 */
  export type MiniToolType = 'official' | 'community' | 'local' | string;

  /**
   * 扩展能力声明，用于官方扩展与社区扩展之间解耦。
   * @deprecated Use {@link MiniToolCapabilitySpec} for new mini tools.
   */
  export interface ExtensionCapabilitySpec {
    readonly capabilities?: readonly string[];
  }

  /**
   * 一个由插件贡献的 MCP server 配置（stdio transport）。
   * Finch 会用 `command`/`args`/`env` 启动子进程，按 MCP 协议握手并列出工具。
   *
   * @example
   * {
   *   "name": "filesystem",
   *   "command": "npx",
   *   "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
   *   "description": "Local filesystem access"
   * }
   */
  export interface McpServerContribution {
    /** server 名称。MCP Bridge 默认用它生成 `mcp__<server>__<tool>` 工具名前缀。 */
    readonly name: string;
    /** 启动命令，如 `npx` 或可执行文件绝对路径。 */
    readonly command: string;
    /** 传给命令的参数。 */
    readonly args?: readonly string[];
    /** 额外环境变量。 */
    readonly env?: Readonly<Record<string, string>>;
    /** 子进程工作目录。 */
    readonly cwd?: string;
    /** 用户可见说明，展示在插件详情页。 */
    readonly description?: string;
  }

  /**
   * `package.json → finch` 字段的完整类型定义。
   * 可在编写 package.json 时用于 JSON Schema 提示。
   *
   * @example
   * // package.json
   * {
   *   "finch": {
   *     "manifestVersion": 1,
   *     "id": "my-extension",
   *     "name": "My Extension",
   *     "description": "Does something useful.",
   *     "systemPrompt": "When the user asks about X, prefer this extension's tools.",
   *     "promptGuides": [
   *       { "id": "start", "title": "Start", "prompt": "/my_skill Help me ..." }
   *     ],
   *     "main": "dist/index.js",
   *     "activationEvents": ["onStartup"],
   *     "contributes": {
   *       "tools": true,
   *       "composerActions": [
   *         { "id": "my-btn", "icon": "Star", "tooltip": "My Button" }
   *       ]
   *     },
   *     "permissions": {
   *       "filesystem": "read",
   *       "network": false,
   *       "shell": false,
   *       "secrets": ["MY_API_KEY"]
   *     }
   *   }
   * }
   *
   * // i18n/zh-CN.json
   * {
   *   "name": "我的扩展",
   *   "description": "做一些有用的事。",
   *   "systemPrompt": "当用户询问 X 时，优先使用这个扩展的工具。"
   * }
   *
   * @deprecated Use {@link MiniToolManifest} for new mini tools.
   */
  export interface ExtensionManifest {
    /** 必须为 `1`。 */
    readonly manifestVersion: 1;
    /** 全局唯一 id（小写字母、数字、连字符）。安装后不可更改。 */
    readonly id: string;
    /**
     * 用户可见名称。新扩展建议写默认字符串，把多语言文案放到 `i18n/<locale>.json`。
     * `LocalizedString` 仍被保留用于历史兼容。
     */
    readonly name: LocalizedString;
    /** 兼容旧字段；新扩展请改用 `name`。 */
    readonly displayName?: LocalizedString;
    /** 扩展说明。新扩展建议写默认字符串，把多语言文案放到 `i18n/<locale>.json`。 */
    readonly description?: LocalizedString;
    /** 一句话动态 system prompt。新扩展建议写默认字符串，把多语言文案放到 `i18n/<locale>.json`。 */
    readonly systemPrompt?: LocalizedString;
    /** 插件详情页 README 上方展示的 prompt 引导语。 */
    readonly promptGuides?: readonly ExtensionPromptGuide[];
    /** 编译后入口文件相对路径，默认 `dist/index.js`。 */
    readonly main: string;
    readonly activationEvents?: ActivationEvent[];
    readonly contributes?: {
      /** 是否贡献 Agent 工具。 */
      readonly tools?: boolean;
      /** 贡献的 Composer 工具栏按钮（静态声明）。 */
      readonly composerActions?: ComposerActionDeclaration[];
      /**
       * 运行时图标包命名空间声明。实际 SVG 在代码里通过 `ctx.icons.register(packId, icons)` 注册。
       * @example
       * "iconPacks": [{ "id": "my-icons", "label": "My Icons" }]
       */
      readonly iconPacks?: readonly IconPackContribution[];
      /**
       * 兼容旧的静态 SVG 文件路径声明。新扩展优先使用 `iconPacks` + `ctx.icons.register()`。
       * @example
       * "icons": { "rocket": { "description": "发射", "svg": "./icons/rocket.svg" } }
       */
      readonly icons?: Record<string, IconContribution>;
      /** 是否携带内置 Skills（扫描 ./skills/）。 */
      readonly skills?: boolean;
      /**
       * 贡献的 MCP server（注入到官方 MCP 桥接插件）。声明后，只要本插件被启用，
       * Finch 会自动把这些 server 交给 MCP 桥接连接，并将其工具暴露给 Agent。
       * 需要 MCP 桥接插件（提供 `mcp.client`）已安装并启用。
       */
      readonly mcpServers?: McpServerContribution[];
    };
    readonly permissions?: ExtensionPermissions;
    /**
     * 仅对随 Finch 捆绑的官方插件有效：是否在首次安装时自动启用。默认 true。
     * 需要用户显式授权或额外配置的插件（如 MCP 桥接）应设为 false。
     */
    readonly autoEnable?: boolean;
    /** Mini tool 类型与来源，用于工具箱/社区展示。 */
    readonly miniToolType?: MiniToolType;
    /**
     * 插件类型与分类，用于插件市场/工具箱展示。
     * @deprecated Use `miniToolType` for new mini tools.
     */
    readonly extensionType?: MiniToolType;
    readonly categories?: readonly string[];
    readonly privacyPolicyUrl?: string;
    readonly termsOfServiceUrl?: string;
    /** 本插件提供的能力，如官方 MCP 插件提供 mcp.client。 */
    readonly provides?: ExtensionCapabilitySpec;
    /** 本插件依赖的能力，如社区插件声明需要 mcp.client。 */
    readonly requires?: ExtensionCapabilitySpec;
  }

  /**
   * 控制插件激活时机。
   *
   * ⚠️ 当前 Finch 版本只实现了 `onStartup`：所有已启用扩展在应用启动 / 扩展启用时
   * 立即激活。惰性激活事件（onCommand / onSpace）尚未实现，为避免误导暂不在类型中暴露；
   * 后续实现后会重新加入。
   */
  export type ActivationEvent = 'onStartup';

  /**
   * 一个图标引用。Finch 里所有「带图标的入口」都接受同一种字符串引用（对齐
   * VS Code 的 ThemeIcon 思路），渲染时由中央图标注册表解析：
   * - `'settings'` / `'git-branch'` —— Finch 打包内置的 Lucide 图标名（kebab-case，亦兼容
   *   PascalCase 如 `'Settings'`）。这是固定集合，不随扩展动态增加。
   * - `'ext:<packId>/<iconId>'` —— 引用某个运行时图标包里的 SVG 图标。
   * - `'ext:<iconId>'` / 裸 iconId —— 在本扩展内部引用自己注册的图标，Finch 会自动补全为
   *   `ext:<当前图标包id>/<iconId>`。
   */
  export type IconRef = string;

  /** 扩展静态声明的一个运行时图标包命名空间。 */
  export interface IconPackContribution {
    readonly id: string;
    readonly label?: LocalizedString;
    readonly description?: LocalizedString;
  }

  /** 扩展贡献的一个自定义图标（兼容旧的 `contributes.icons` 文件路径声明）。 */
  export interface IconContribution {
    /** 图标用途说明（可选，便于他人复用）。 */
    readonly description?: string;
    /** SVG 文件相对扩展根目录的路径，如 `'./icons/rocket.svg'`。 */
    readonly svg: string;
  }

  /** Composer 工具栏按钮的静态声明（写在 manifest 里）。 */
  export interface ComposerActionDeclaration {
    /** 与 `finch.composerActions.register(id, ...)` 的 id 对应。 */
    readonly id: string;
    /**
     * 按钮默认图标，一个 {@link IconRef}：内置 Lucide 名（如 `'git-branch'`、
     * `'settings'`）或本扩展运行时图标包里的 icon id / `ext:<packId>/<iconId>`。
     */
    readonly icon?: IconRef;
    readonly tooltip?: string;
  }

  /**
   * 插件权限声明。
   * @deprecated Use {@link MiniToolPermissions} for new mini tools.
   */
  export interface ExtensionPermissions {
    /** 文件系统访问级别。`'none'` = 禁止，`'read'` = 只读，`'readwrite'` = 读写。 */
    readonly filesystem?: 'none' | 'read' | 'readwrite';
    /** 是否允许发起网络请求。 */
    readonly network?: boolean;
    /** 是否允许执行 shell 命令。 */
    readonly shell?: boolean;
    /** 可访问的密钥 key 列表（在 Finch 设置中由用户填写）。 */
    readonly secrets?: string[];
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 11  Mini Tool aliases — preferred public names
  // ════════════════════════════════════════════════════════════════════════════

  /** Preferred name for {@link ExtensionContext}. */
  export type MiniToolContext = ExtensionContext;
  /** Preferred name for {@link ExtensionInfo}. */
  export type MiniToolInfo = ExtensionInfo;
  /** Preferred name for {@link ExtensionFormField}. */
  export type MiniToolFormField = ExtensionFormField;
  /** Preferred name for {@link ExtensionFormSpec}. */
  export type MiniToolFormSpec = ExtensionFormSpec;
  /** Preferred name for {@link ExtensionFormResult}. */
  export type MiniToolFormResult = ExtensionFormResult;
  /** Preferred name for {@link ExtensionContribution}. */
  export type MiniToolContribution<T = unknown> = ExtensionContribution<T>;
  /** Preferred name for {@link Extensions}. */
  export type MiniToolContributions = Extensions;
  /** Preferred name for {@link ExtensionI18n}. */
  export type MiniToolI18n = ExtensionI18n;
  /** Preferred name for {@link ExtensionPromptGuide}. */
  export type MiniToolPromptGuide = ExtensionPromptGuide;
  /** Preferred name for {@link ExtensionCapabilitySpec}. */
  export type MiniToolCapabilitySpec = ExtensionCapabilitySpec;
  /** Preferred name for {@link ExtensionManifest}. */
  export type MiniToolManifest = ExtensionManifest;
  /** Preferred name for {@link ExtensionPermissions}. */
  export type MiniToolPermissions = ExtensionPermissions;

} // end declare module 'finch'
