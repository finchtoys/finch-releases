/*!
 * Finch Extension API
 *
 * 扩展使用 `import type` 引入类型，所有运行时 API 通过 `ctx` 调用：
 *
 * ```ts
 * import type * as finch from 'finch';
 *
 * export function activate(ctx: finch.ExtensionContext) {
 *   ctx.subscriptions.push(
 *     ctx.tools.register({ ... }),
 *     ctx.composerActions.register('my-btn', { ... }),
 *   );
 * }
 *
 * export function deactivate() { }
 * ```
 *
 * `import type` 在编译时完全擦除，无需运行时解析 `finch` 模块。
 * 完整文档：https://finchwork.app/docs/extensions
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
   * - `ctx.session` — 当前 session（只读）
   * - `ctx.workspace` — 当前 workspace（只读）
   *
   * @example
   * export function activate(ctx: finch.ExtensionContext) {
   *   ctx.subscriptions.push(
   *     ctx.tools.register({ name: 'greet', ... }),
   *     ctx.composerActions.register('my-btn', { ... }),
   *   );
   *   ctx.logger.info('activated');
   * }
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
     *     async getMenu({ cwd })  { return listBranches(cwd); },
     *     async execute({ cwd }, branch) { await checkout(cwd, branch); },
     *   }),
     * );
     */
    readonly composerActions: {
      register(actionId: string, provider: ComposerActionProvider): Disposable;
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
     * UI 扩展能力（Phase 2，预留）。
     * @example
     * const panel = ctx.ui.createWebviewPanel({ title: 'My Panel', html: '<h1>Hello</h1>' });
     * ctx.subscriptions.push(panel);
     */
    readonly ui: {
      createWebviewPanel(options: WebviewPanelOptions): WebviewPanel;
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
     * 扩展 manifest contribution 快照。Host 只按 extension point 名称透传原始值，
     * 具体语义由消费扩展自行定义。
     */
    readonly extensions: Extensions;

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

    /** 当前 session 信息（只读快照）。 */
    readonly session: SessionInfo;

    /** 当前 Space / Workspace 信息（只读）。 */
    readonly workspace: WorkspaceInfo;
  }

  /** 插件自身元信息。 */
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

  /** 插件自定义表单中的单个字段，渲染在等候区表单卡片里。 */
  export interface ExtensionFormField {
    /** 表单值映射中的唯一 key。 */
    readonly key: string;
    readonly label: string;
    readonly type: 'text' | 'password' | 'textarea' | 'number' | 'select' | 'boolean';
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
  }

  /** `ctx.ui.requestForm` 的表单描述 —— 用户在工具调用期间填写。 */
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

  /** 用户提交或取消表单后返回给插件的结果。 */
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
    /** 用户或超时触发中止时有信号。 */
    readonly token: CancellationToken;
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

  /**
   * Composer 扩展点上下文，每次调用时传入。
   */
  export interface ComposerActionContext {
    /** 当前有效工作目录（可能为 undefined）。 */
    readonly cwd: string | undefined;
    readonly sessionId: string | undefined;
    readonly spaceId: string | undefined;
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
    /** Lucide 图标名，用于菜单项左侧小图标。 */
    readonly iconName?: string;
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
   *   async getMenu({ cwd }) {
   *     return listBranches(cwd).map(b => ({ id: b, label: b }));
   *   },
   *   async execute({ cwd }, branchName) {
   *     await checkout(cwd, branchName);
   *   },
   * });
   */
  export interface ComposerActionProvider {
    /**
     * 返回按钮徽标文字（如分支名、计数器）。
     * - 返回字符串 → 显示在图标右侧
     * - 返回 `undefined` → 只显示图标，按钮仍然可见
     * - 抛出错误 → 按钮隐藏（表示当前 cwd 不适用）
     */
    getBadge?(ctx: ComposerActionContext): Promise<string | undefined>;
    /**
     * 用户点击按钮后拉取的下拉菜单。
     * 返回空数组则显示空菜单；抛出错误则显示错误提示项。
     */
    getMenu(ctx: ComposerActionContext): Promise<ComposerActionMenuItem[]>;
    /**
     * 用户选中某个菜单项时执行。
     * @param itemId 对应 {@link ComposerActionMenuItem.id}
     */
    execute(ctx: ComposerActionContext, itemId: string): Promise<void>;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 5  finch.commands — 命令系统（reserved）
  // ════════════════════════════════════════════════════════════════════════════

  // `ctx.commands` 是**预留 API**：当前 Finch 版本未实现，调用会抛出明确的
  // "尚未实现" 错误。命令类型不再暴露全局 namespace，实现后会补齐。

  // ════════════════════════════════════════════════════════════════════════════
  // § 6  finch.ui — UI 扩展（reserved）
  // ════════════════════════════════════════════════════════════════════════════

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
  // "尚未实现" 错误。`ctx.ui.showMessage` 为尽力而为的日志降级。全局 namespace 不再暴露。

  // ════════════════════════════════════════════════════════════════════════════
  // § 6.5  Capabilities — 插件间能力协作
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

  export interface ExtensionContribution<T = unknown> {
    extensionId: string;
    extensionName: string;
    extensionPath: string;
    source: 'global' | 'personal' | 'project';
    value: T;
  }

  /** `ctx.extensions` 的接口：读取已启用扩展的原始 manifest contributions。 */
  export interface Extensions {
    listContributions<T = unknown>(point: string): ExtensionContribution<T>[];
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

  /** 扩展详情页展示的 prompt 引导语。点击后会填入 HomeView Composer。 */
  export interface ExtensionPromptGuide {
    readonly id?: string;
    readonly title: LocalizedString;
    readonly prompt: LocalizedString;
    readonly description?: LocalizedString;
  }

  /** 扩展能力声明，用于官方扩展与社区扩展之间解耦。 */
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
   *       "filesystem": "readonly",
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
    /** 插件类型与分类，用于插件市场/工具箱展示。 */
    readonly extensionType?: 'official' | 'community' | 'local' | string;
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

  /** Composer 工具栏按钮的静态声明（写在 manifest 里）。 */
  export interface ComposerActionDeclaration {
    /** 与 `finch.composerActions.register(id, ...)` 的 id 对应。 */
    readonly id: string;
    /** Lucide 图标名（如 `'GitBranch'`、`'Star'`、`'Hash'`）。 */
    readonly icon?: string;
    readonly tooltip?: string;
  }

  /** 插件权限声明。 */
  export interface ExtensionPermissions {
    /** 文件系统访问级别。`'none'` = 禁止，`'readonly'/'read'` = 只读，`'readwrite'` = 读写。 */
    readonly filesystem?: 'none' | 'read' | 'readonly' | 'readwrite';
    /** 是否允许发起网络请求。 */
    readonly network?: boolean;
    /** 是否允许执行 shell 命令。 */
    readonly shell?: boolean;
    /** 可访问的密钥 key 列表（在 Finch 设置中由用户填写）。 */
    readonly secrets?: string[];
  }

} // end declare module 'finch'
