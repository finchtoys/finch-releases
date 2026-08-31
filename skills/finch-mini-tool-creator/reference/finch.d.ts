/*!
 * Finch Mini Tool API
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
   * 与 VS Code 保持一致：用 `MiniToolContext.subscriptions.push(d)` 统一管理生命周期。
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

  /** Finch 宿主级导航；后端 `ctx.navigation` 与页面 `window.finch.navigation` 共用此接口。 */
  export interface Navigation {
    /** 在当前 Finch 窗口打开已有 Session。 */
    openSession(sessionId: string): Promise<void>;
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
   * - `ctx.secrets` — 系统加密密钥读写
   * - `ctx.oauth` — 隔离的 OAuth 连接与授权请求
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
   */
  export interface MiniToolContext {
    /**
     * 推入此数组的 Disposable 将在插件停用时自动 `dispose()`。
     * 无需手动管理生命周期。
     */
    readonly subscriptions: { dispose(): unknown }[];

    /** 当前 mini tool 自身元信息（只读）。 */
    readonly minitool: MiniToolInfo;

    /** 当前运行时暴露的小程序 API surface 探针。 */
    readonly api: MiniToolApi;

    /**
     * @deprecated 用 `ctx.minitool` 代替。旧版扩展 API（Extension 更名为 MiniTool 之前）
     * 遗留的兼容别名，指向与 `ctx.minitool` 完全相同的对象，仅为已发布的旧版插件
     * 包（如 `ctx.extension.id`）保留运行时兼容，不要在新代码中使用。
     */
    readonly extension: MiniToolInfo;

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
      /** Register a provider that discovers tools on demand (e.g. MCP servers).
       *  The provider's `search()` is called when the model or ToolSearch
       *  requests tools matching a query.
       *  @deprecated Use {@link registerDiscoveryProvider} instead. */
      registerSearchProvider(provider: ToolSearchProvider): Disposable;
      /** Register a provider for on-demand tool discovery (MCP-style).
       *  Replaces the deprecated `registerSearchProvider`. */
      registerDiscoveryProvider(provider: ToolSearchProvider): Disposable;
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
     * 命令系统为预留阶段，当前版本未实现。请勿调用。
     * 后续版本会增加 `ctx.commands.register()` 支持。
     */
    readonly commands: undefined;

    /** Finch 宿主级导航；不依赖 Composer Action，可在任意后端回调中调用。 */
    readonly navigation: Navigation;

    /** Finch 内置 Browser Panel。每次调用在当前 Panel scope 新建一个 Browser Tab。 */
    readonly browser: {
      open(url: string): Promise<void>;
    };

    /**
     * UI 扩展能力。
     * `showToast()` 可用于展示轻量、非阻塞通知；Webview Panel 已实现。
     * @example
     * ctx.ui.showToast({ title: 'Saved', variant: 'success', position: 'TC' });
     */
    readonly ui: {
      /**
       * 在当前 Panel scope 的 Finch 原生文件预览中打开一个本地文件。路径必须为
       * 绝对路径；文件内容不会传入 mini tool，而是继续由 Finch 的预览管线读取与渲染。
       * 支持 Markdown、代码和其它可预览文本文件。
       *
       * @example
       * await ctx.ui.openFilePreview('/workspace/README.md');
       */
      openFilePreview(path: string, options?: FilePreviewOptions): Promise<void>;
      /**
       * 在当前 Panel scope 打开 Finch 原生双文件或 Git commit/ref Diff。
       * 仅传入要比较的路径/ref；右侧 Panel 或弹窗由用户的「改动与文件预览」设置决定。
       */
      openDiff(request: AppViewDiffRequest): Promise<void>;
      /**
       * 打开 `contributes.appPanel` 声明的唯一 Panel App。
       * 声明决定页面来源、标题、图标与工具栏；此调用只决定 single/multiple
       * 实例策略。Panel 可绑定 Session、Home 或其他当前 Panel scope。
       */
      createPanel(options?: AppPanelOptions): AppPanel;
      /**
       * 监听当前 mini tool 声明的 Panel App 实例。Launcher、ComposerAction、
       * Delivery 等所有打开路径都会触发；订阅时也会补发当前仍存活的实例。
       *
       * 用户直接打开的 `contributes.appView` 应用级页面同样会触发这个
       * 监听器（它自己并不调用 `createPanel()`），这是后端唯一能拿到其
       * `AppPanel` 句柄（进而 `postMessage()`/`onDidReceiveMessage()`）的
       * 方式；用 `panel.view === 'appView'` 判断是否是 appView 页面。
       */
      onDidOpenPanel(listener: (panel: AppPanel) => unknown): Disposable;
      /**
       * 创建一个透明、无边框、可拖到任意位置、可置顶的**浮动 Canvas 窗口**。
       *
       * 与 `createPanel`（内嵌 Panel）正交：Canvas 窗口是独立顶层窗，适合桌宠、
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
      showModalDialog(options: ModalDialogOptions): ModalDialogHandle;
      /**
       * 打开 Finch 原生文件选择器：浏览当前 Space/工作间目录树，或输入关键字模糊过滤，
       * 只返回选中文件的绝对路径，不回传文件内容——需要哪个文件的内容，小程序自己按
       * 路径读取（需要 manifest `permissions.filesystem: "read"` 或 `"readwrite"`）。
       *
       * 默认只能在当前 Space（或全局工作间）目录下选择，和 Composer `@` 提及文件看到
       * 的目录范围一致。若这次调用发生在 `contributes.appView` 页面（不绑定单个
       * Session/Space），可以传 `allowSpaceSwitch: true`，弹窗顶部会出现一个 Space /
       * 工作间切换器。
       *
       * @example
       * const result = await ctx.ui.pickFile({
       *   title: '选择要导入的文件',
       *   multiple: true,
       *   filter: { extensions: ['.md', '.png', '.jpg'] },
       * });
       * if (result.action === 'select') {
       *   for (const file of result.files) {
       *     const text = await fs.readFile(file.path, 'utf-8');
       *   }
       * }
       */
      pickFile(options?: FilePickerOptions): FilePickerHandle;
      /** 显示一条 Toast 通知（映射为 showToast，保留了 `type` 参数以兼容不同严重等级）。 */
      notify(message: string, type?: 'info' | 'warning' | 'error'): void;
      /**
       * 显示一条 Toast 通知。
       * @deprecated 请改用 `notify`，语义更清晰。
       */
      showMessage(message: string, type?: 'info' | 'warning' | 'error'): void;
      /**
       * 当前 Session 右侧 Work Sidebar「交付」区的这一行——一条跟随 Session 走
       * 的扁平记录，与对话时间线完全无关：没有历史、没有解释，只是一行「标题
       * + 说明」。平台约束每个小工具在一个 Session 里**只能有一行**：重复
       * `set()` 总是原地覆盖同一行，没有 entryId 概念，不能叠加出多行。点击
       * 该行会打开这个小工具通过 `contributes.appPanel` 声明的 Panel App。
       *
       * @example
       * await ctx.ui.delivery.set({
       *   title: '帕亚的改动',
       *   detail: '{+969}\\g {-354}\\r',
       * });
       * // ...
       * await ctx.ui.delivery.remove();
       */
      readonly delivery: {
        set(options: DeliverySetOptions): Promise<void>;
        remove(): Promise<void>;
      };
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
     * 读取已启用 mini tool 的 manifest contribution 快照。
     * Host 只按 extension point 名称透传原始值，具体语义由消费扩展自行定义。
     */
    readonly minitools: MiniToolContributions;

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
    readonly i18n: MiniToolI18n;

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

    /** 对 manifest `permissions.secrets` 声明的密钥进行系统加密读写。 */
    readonly secrets: Secrets;

    /** OAuth Broker：凭证按小工具隔离，原始 token 不会暴露。 */
    readonly oauth: OAuth;

    /** Finch App 基本信息（只读）。 */
    readonly app: App;

    /** 当前 session 信息（只读快照）。 */
    readonly session: SessionInfo;

    /** 创建并可靠收发当前小工具自己拥有的 Session。需要 permissions.sessions。 */
    readonly sessions: Sessions;
    /**
     * 只读 Space 目录。需要 permissions.sessions（与 `ctx.sessions` 共用同一
     * 权限门），主要用途是在创建 Session 前发现 `spaceId` 传给
     * `sessions.create({ space })`。
     */
    readonly spaces: Spaces;
    readonly sessionContainers: {
      /**
       * @deprecated 旧版容器级设置菜单，只会出现在该容器的会话页头部。
       * 新小工具请改用 `ctx.settingsMenu.register()`——它同时出现在容器页头部
       * 和小工具箱卡片上。已发布的小工具无需改造，仍按原样工作。
       */
      registerSettingsMenu(containerId: string, provider: SessionContainerSettingsMenuProvider): Disposable & {
        /** Re-fetch the visible menu after login or other background state changes. */
        notifyUpdate(): void;
      };
    };

    /**
     * 小工具唯一的统一设置菜单。需要在 manifest 里声明
     * `contributes.settingsMenu`，注册后会同时出现在：
     * 1）该小工具会话容器页头部；2）小工具箱卡片（开关左侧）与详情页操作行。
     * manifest 顶层 `settings` 表单会作为内置项自动追加到菜单末尾。
     */
    readonly settingsMenu: {
      register(provider: SettingsMenuProvider): Disposable & {
        /** Re-fetch the visible menu after login or other background state changes. */
        notifyUpdate(): void;
      };
    };

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

  /** 当前 Finch 暴露的小程序 API surface 探针。 */
  export interface MiniToolApi {
    /**
     * 当前运行时的小程序 API 是否提供指定成员。
     * `capability` 是相对 `MiniToolContext` 根节点的点分路径，例如
     * `ui.createCanvasWindow`。返回 `true` 只表示 API 存在；调用所需的
     * manifest 权限、当前 Session/Panel 上下文和参数约束仍需另行满足。
     *
     * 小程序仍应通过 manifest `minVersion` 声明使用本探针所需的最低
     * Finch 版本，再用本方法对后续新增 API 做渐进增强。
     */
    supports(capability: string): boolean;
  }

  /**
   * 插件自身元信息。
   */
  export interface MiniToolInfo {
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

  export type MinitoolSessionActivity = 'interactive' | 'background';

  /** 由 Finch 写入的小工具 Session 元数据；owner 与 minitoolId 不可伪造。 */
  export interface MinitoolSessionDescriptor {
    readonly sessionId: string;
    readonly owner: { readonly type: 'minitool'; readonly minitoolId: string };
    /**
     * `minitool` 会话位于本工具声明的容器内。`space` 会话被创建到某个具体
     * Space，出现在该 Space 的普通会话列表中，但仍归本 mini tool 所有（因此
     * 仍能收到 turn 事件并回复微信等外部平台）。`chat` 会话是既无容器也无
     * Space 的普通对话——出现在普通会话列表中，效果等同于用户点「新对话」，
     * 但仍归本 mini tool 所有。
     */
    readonly placement:
      | { readonly type: 'minitool'; readonly minitoolId: string; readonly containerId: string }
      | { readonly type: 'space'; readonly spaceId: string }
      | { readonly type: 'chat' };
    readonly activity: MinitoolSessionActivity;
    readonly profileId?: string;
    /**
     * 当 mini tool 容器会话继承了某个 Space 的运行上下文时（通过 `context: 'caller'`
     * 或容器自身的 Space 级首页/上下文），此处记录该 Space id。会话仍保持在 mini tool
     * 容器内，但侧栏中显示在该 Space 下方。对真正放入 Space（space placement）或
     * 无 Space 上下文的会话为 `undefined`。
     */
    readonly contextSpaceId?: string;
    readonly state: { readonly pinned: boolean; readonly archived: boolean };
    readonly createdAt: string;
    readonly updatedAt: string;
  }

  export type SessionMessageAttachmentKind = 'image' | 'pdf' | 'text' | 'file';

  export interface SessionMessageAttachment {
    readonly name: string;
    readonly mimeType: string;
    /** Base64 文件内容；send() 返回前 Finch 会复制到受管暂存区。 */
    readonly data: string;
    readonly kind?: SessionMessageAttachmentKind;
  }

  export interface SessionUserMessage {
    /** 有附件时允许为空字符串。 */
    readonly text: string;
    /** 每条消息最多 10 个附件，单个及总大小均不超过 20 MB。 */
    readonly attachments?: SessionMessageAttachment[];
    /** 外部平台的稳定不透明幂等键；不要放 token、消息正文或个人信息。 */
    readonly idempotencyKey: string;
  }

  export interface SessionCreateOptions {
    /**
     * 会话所在容器，须在 manifest contributes.sessionContainers 中声明。若
     * 用户为该容器选择了默认模型，Finch 会自动用于新会话；否则回退全局默认。
     * 与 `space` 互斥。`containerId` 和 `space` 都不传时，创建一个既无容器也
     * 无 Space 的普通对话（`chat` placement），使用全局默认 cwd/模型——效果
     * 等同于用户点「新对话」，但会话仍归本 mini tool 所有。
     */
    readonly containerId?: string;
    /**
     * 把会话创建到某个具体 Space，而非小工具容器。会话会出现在该 Space 的
     * 普通会话列表中（交互式，非隐藏于容器），同时仍归本 mini tool 所有。
     * 与 `containerId` 互斥。可先用 `ctx.spaces.list()` 获取可用 Space 的
     * id/name 列表。
     */
    readonly space?: { readonly spaceId: string };
    readonly title?: string;
    /**
     * @deprecated 已废弃且被忽略。Agent 角色由目标容器的
     * `contributes.sessionContainers[].agentProfile` 声明决定并自动生效，
     * 不再由调用方逐个会话指定。传入不会报错（仅打印一条废弃警告，
     * 会话照常创建），但不产生任何效果——请改为在容器上声明。
     */
    readonly profileId?: string;
    /** 继承发起调用的 Chat/Space 上下文；仅在 Agent tool 调用作用域内可用。 */
    readonly context?: 'caller';
    /**
     * `background` 容器会话在完成或等待时不弹系统通知，只在所属
     * session container 入口显示提醒红点。
     */
    readonly activity?: MinitoolSessionActivity;
    /** 默认 acceptCalls；可显式设为 ask。 */
    readonly permissionMode?: 'ask' | 'acceptCalls';
    /** 提供时，与 Session 创建原子接收；失败不会留下 ghost Session。 */
    readonly initialMessage?: SessionUserMessage;
  }

  export interface SessionListOptions {
    readonly containerId?: string;
    readonly includeArchived?: boolean;
  }

  /**
   * 用户已创建的某个 Space 的只读摘要。用于在调用
   * `sessions.create({ space: { spaceId } })` 之前发现可用的 Space id/name，
   * 无需本工具正运行在该 Space 内。
   */
  export interface SpaceSummary {
    readonly id: string;
    /** 展示名称（用户自定义或默认名）。 */
    readonly name: string;
    /** 用户设置的短别名（如有）。 */
    readonly alias?: string;
    /** 该 Space 绑定的目录（如有）。 */
    readonly directoryPath?: string;
  }

  export interface Spaces {
    /** 列出用户创建的所有 Space，按最近打开时间排序。 */
    list(): Promise<SpaceSummary[]>;
  }

  export interface SessionSendOptions {
    /** Phase 1 仅支持严格 FIFO queue。 */
    readonly delivery?: 'queue';
  }

  export type SessionSendReceipt =
    | {
        readonly sessionId: string;
        readonly turnId: string;
        readonly clientMessageId: string;
        readonly state: 'accepted' | 'duplicate';
        readonly queued: boolean;
        /** 调用后该 Session 内 running + queued 的数量。 */
        readonly pendingCount: number;
        /** 前方 turn 数量，从 0 开始；0 表示正在运行或即将派发。 */
        readonly queuePosition?: number;
      }
    | {
        readonly sessionId: string;
        readonly state: 'rejected';
        readonly queued: false;
        readonly code: 'queue_full';
        readonly scope: 'session' | 'minitool';
        readonly pendingCount: number;
        readonly limit: number;
        readonly retryAfterMs: number;
      };

  export type SessionDurableEvent =
    | { readonly sequence: number; readonly type: 'assistant.message'; readonly sessionId: string; readonly turnId: string; readonly messageId: string; readonly text: string; readonly createdAt: string }
    | { readonly sequence: number; readonly type: 'turn.completed'; readonly sessionId: string; readonly turnId: string; readonly outputText: string; readonly messageIds: string[]; readonly createdAt: string }
    | { readonly sequence: number; readonly type: 'turn.failed'; readonly sessionId: string; readonly turnId: string; readonly code: string; readonly retryable: boolean; readonly createdAt: string }
    | {
        readonly sequence: number;
        readonly type: 'turn.waiting';
        readonly sessionId: string;
        readonly turnId: string;
        readonly reason: SessionWaitKind;
        /** 用于调用 respondToWait() 应答该等待，等同于卡片 id。 */
        readonly requestId: string;
        /** 完整的等待内容快照。 */
        readonly wait: SessionWait;
        readonly createdAt: string;
      }
    | {
        readonly sequence: number;
        readonly type: 'turn.wait_resolved';
        readonly sessionId: string;
        readonly turnId: string;
        readonly requestId: string;
        readonly resolvedBy: SessionWaitResolver;
        readonly createdAt: string;
      };

  export type SessionBridgeEvent =
    | SessionDurableEvent
    /** 仅实时投递，不写入 listEvents()；断线后使用最终消息恢复。 */
    | { readonly type: 'assistant.delta'; readonly sessionId: string; readonly turnId: string; readonly messageId: string; readonly delta: string; readonly createdAt: string };

  export interface SessionEventQuery {
    readonly sessionId: string;
    readonly after?: number;
    readonly limit?: number;
  }

  export interface SessionEventPage {
    readonly events: SessionDurableEvent[];
    readonly nextCursor?: number;
  }

  export interface SessionWaitOptions {
    /** 默认 60 秒，限制为 1–600 秒；超时不会取消 turn。 */
    readonly timeoutMs?: number;
  }

  export type SessionTurnWaitResult =
    | { readonly state: 'completed'; readonly sessionId: string; readonly turnId: string; readonly outputText: string; readonly messageIds: string[]; readonly completedAt: string }
    | { readonly state: 'failed'; readonly sessionId: string; readonly turnId: string; readonly code: string; readonly retryable: boolean; readonly failedAt: string }
    | { readonly state: 'timeout'; readonly sessionId: string; readonly turnId: string };

  // ── Session 等待（权限 / 提问 / 表单）─────────────────────────

  export type SessionWaitKind = 'permission' | 'question' | 'form';

  /** 谁结算了这次等待。 */
  export type SessionWaitResolver = 'user' | 'minitool' | 'timeout' | 'system';

  export interface SessionWaitBase {
    readonly sessionId: string;
    readonly turnId?: string;
    /** 传给 respondToWait() 的 id，等同于交互卡片 id（toolUseId）。 */
    readonly requestId: string;
    readonly kind: SessionWaitKind;
    readonly createdAt: string;
    /** 仅当等待会自行取消时出现（带 timeoutMs 的表单卡）。 */
    readonly expiresAt?: string;
  }

  export interface SessionPermissionWait extends SessionWaitBase {
    readonly kind: 'permission';
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly toolTitle?: string;
    /** 发起授权请求的工具来源。 */
    readonly toolSource?: { readonly type: 'builtin' | 'minitool'; readonly id?: string; readonly name?: string };
    /** 高风险工具或危险命令，不允许沉淀为长期规则。 */
    readonly dangerous?: boolean;
    /**
     * 不可逆操作。小工具可拒绝这类等待，让任务安全继续，但不能批准；
     * 批准时 respondToWait() 返回 `forbidden`，只有真人可以批准。
     */
    readonly destructive?: boolean;
  }

  export interface SessionQuestionWait extends SessionWaitBase {
    readonly kind: 'question';
    readonly questions: ReadonlyArray<{
      readonly question: string;
      readonly header: string;
      readonly multiSelect: boolean;
      readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
    }>;
  }

  export interface SessionFormWait extends SessionWaitBase {
    readonly kind: 'form';
    /** 打开该表单的小工具。 */
    readonly extensionId?: string;
    readonly form: {
      readonly title: string;
      readonly description?: string;
      readonly submitLabel?: string;
      readonly cancelLabel?: string;
      readonly fields: MiniToolFormField[];
    };
  }

  export type SessionWait = SessionPermissionWait | SessionQuestionWait | SessionFormWait;

  export type SessionWaitResponse =
    | { readonly kind: 'permission'; readonly allow: boolean }
    /** key 为每个问题的 `header`。 */
    | { readonly kind: 'question'; readonly answers: Record<string, string> }
    | { readonly kind: 'form'; readonly submitted: boolean; readonly values?: Record<string, string | number | boolean | string[]> };

  export type SessionWaitRespondResult =
    | { readonly state: 'accepted'; readonly requestId: string }
    /** 已被真人、超时或会话结束抢先结算。 */
    | { readonly state: 'stale'; readonly requestId: string; readonly resolvedBy: SessionWaitResolver }
    | { readonly state: 'not_found'; readonly requestId: string }
    /** 被策略拦截——例如尝试批准 destructive 权限卡。 */
    | { readonly state: 'forbidden'; readonly requestId: string; readonly reason: string };

  export interface SessionWaitPollOptions {
    /** 默认 60 秒，限制为 1–600 秒。 */
    readonly timeoutMs?: number;
  }

  export interface Sessions {
    create(options: SessionCreateOptions): Promise<MinitoolSessionDescriptor>;
    get(sessionId: string): Promise<MinitoolSessionDescriptor | undefined>;
    list(options?: SessionListOptions): Promise<MinitoolSessionDescriptor[]>;
    send(sessionId: string, message: SessionUserMessage, options?: SessionSendOptions): Promise<SessionSendReceipt>;
    /**
     * 动态修改当前 mini tool 自己拥有的 Session 权限模式并持久化。
     * acceptCalls 仍不会自动批准危险操作；不支持 auto。
     */
    setPermissionMode(sessionId: string, permissionMode: 'ask' | 'acceptCalls'): Promise<void>;
    /** 等待指定 turn 完成或失败，无需 sleep/polling。 */
    waitForTurn(sessionId: string, turnId: string, options?: SessionWaitOptions): Promise<SessionTurnWaitResult>;
    onDidReceiveEvent(listener: (event: SessionBridgeEvent) => unknown): Disposable;
    listEvents(options: SessionEventQuery): Promise<SessionEventPage>;
    /** 当前阻塞该 Session 的未结算等待。需要 permissions.sessions。 */
    listWaits(sessionId: string): Promise<SessionWait[]>;
    /** 以程序方式应答等待。需要 permissions.sessionInteractions。 */
    respondToWait(sessionId: string, requestId: string, response: SessionWaitResponse): Promise<SessionWaitRespondResult>;
    /** Session 一旦出现待处理等待就返回，无需轮询。 */
    waitForWait(sessionId: string, options?: SessionWaitPollOptions): Promise<SessionWait | undefined>;
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
   * 插件自定义表单中的单个字段。`ctx.ui.requestForm()`（等候区表单卡片，绑定 tool
   * 执行上下文）与 `ModalDialogOptions.fields`（独立弹窗，无需 tool 执行上下文）共用同一套字段定义。
   */
  export interface MiniToolFormField {
    /** 表单值映射中的唯一 key。 */
    readonly key: string;
    readonly label: string;
    readonly type: 'text' | 'password' | 'textarea' | 'number' | 'select' | 'multiselect' | 'boolean' | 'link';
    readonly placeholder?: string;
    readonly description?: string;
    readonly required?: boolean;
    /** `multiselect` 的默认值是初始勾选的选项值数组。 */
    readonly default?: string | number | boolean | readonly string[];
    /** `select` / `multiselect` 字段的可选项。 */
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
   */
  export interface MiniToolFormSpec {
    readonly title: string;
    readonly description?: string;
    readonly submitLabel?: string;
    readonly cancelLabel?: string;
    readonly fields: MiniToolFormField[];
    /**
     * 可选自动取消超时（毫秒）。超时未提交则 resolve 为
     * `{ submitted: false, reason: 'timeout' }`。省略则一直等待用户提交/取消或 session 结束。
     */
    readonly timeoutMs?: number;
  }

  /**
   * 用户提交或取消表单后返回给插件的结果。
   */
  export interface MiniToolFormResult {
    /** 用户取消、超时、或 session 未提交即结束时为 false。 */
    readonly submitted: boolean;
    /** `multiselect` 字段回传 `string[]`（未勾选时为空数组）。 */
    readonly values: Record<string, string | number | boolean | string[]>;
    /**
     * 非提交结算的原因；submitted 为 true 时不存在。
     * `'background'` 表示会话运行在后台、没有桌面端用户可应答，表单从未展示——
     * 若确需用户输入，应提示用户回到 Finch 桌面客户端，而不是重试表单。
     */
    readonly reason?: 'cancelled' | 'timeout' | 'session-ended' | 'background';
  }

  /** Mini Tool 在长任务执行期间上报给 timeline 的进度。 */
  export interface ToolProgressUpdate {
    /** 稳定的机器可读阶段，例如 queued / generating / downloading。 */
    readonly stage?: string;
    /** 当前展示给用户的简短状态。 */
    readonly message: string;
    /** 0–100；省略时 Finch 展示不确定进度动画。 */
    readonly percent?: number;
    /** 设为 'image' 时渲染专用的生图动效，取代默认进度条。 */
    readonly kind?: 'image';
    /** kind: 'image' 时展示的附加信息。 */
    readonly image?: {
      /** [宽, 高] 像素，例如 [1024, 1024]；展示为角标，同时决定画布自身尺寸——按与正方形大致相同的面积缩放，长方形/竖形分辨率会渲染出成比例变宽/变高的画布，而不是被裁成正方形。 */
      readonly resolution?: readonly [number, number];
    };
  }

  /** 单次工具调用的进度上报入口。 */
  export interface ToolProgress {
    /** 更新当前 tool call 的 live 进度；不会写入模型上下文或 ToolResult。 */
    report(update: ToolProgressUpdate): void;
  }

  /** 在调用 progress.report() 前显式请求初始不定进度条。 */
  export type ToolProgressMode = 'indeterminate';

  /** 工具执行期可用的 UI 交互面（表单）。 */
  export interface ToolUi {
    /**
     * 在等候区弹出一个插件自定义表单，用户提交后 resolve 为填写的值。
     * 敏感字段由用户直接输入；返回给模型的内容（如果有）由插件自行决定。
     */
    requestForm(spec: MiniToolFormSpec): Promise<MiniToolFormResult>;
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
    /** 当前 tool call 的 live 进度上报入口。 */
    readonly progress: ToolProgress;
    /** 工具执行期的交互 UI 面（表单）。 */
    readonly ui: ToolUi;
  }

  /** 工具向模型返回的内容块。 */
  export type ToolContent =
    | { readonly type: 'text'; readonly text: string }
    | {
        readonly type: 'image';
        /** 裸 base64 图片数据；不要包含 `data:image/...;base64,` 前缀。 */
        readonly data: string;
        readonly mimeType: string;
      };

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
    /** Show an initial indeterminate progress bar until this tool reports progress. */
    readonly progressMode?: ToolProgressMode;
    /**
     * 该工具单次执行的最长时间（毫秒）。省略时使用 Finch 默认的 120000（2 分钟）。
     *
     * 用于长耗时工具（生图、视频渲染、远程任务轮询等）。声明后 Finch 会以该值
     * 作为超时上限，而不是默认 2 分钟；取值被夹在 15000 ~ 600000（15 秒 ~ 10 分钟）之间。
     *
     * 注意：超时只是保护上限，不是配额。长任务更推荐「先同步等一小段时间，拿不到
     * 结果就返回任务 id 让模型稍后查询」的异步模式，避免长时间阻塞整轮对话。
     */
    readonly timeoutMs?: number;
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
    /** @deprecated 请改用激活时捕获的 `ctx.navigation`。 */
    navigation: Navigation;
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

  /**
   * 菜单项右侧的独立操作按钮。悬停该菜单行时才显示，用于承载「跳转 / 打开 / 复制 /
   * 删除」等**与选中该行本身不同**的次要操作。
   *
   * 交互约定：
   * - 仅在鼠标悬停在菜单行上时显示；未悬停时隐藏。
   * - 当按钮显示时，会**顶替**该行右侧的 `description` 文字（两者互斥展示）。
   * - 点击按钮**不会**触发该行的 `execute(itemId)`，而是单独以
   *   `execute(ctx, '__trailing__:<button.id>', actions)` 回调，插件据此处理跳转或其它逻辑；
   *   事件不冒泡到菜单行，也不关闭菜单（除非你在处理函数里主动 `actions.composer.*`）。
   * - **子菜单项（带 `children` 的项）不支持右侧按钮**，此时该字段被忽略。
   *
   * @example
   * async getMenu() {
   *   return [
   *     { id: 'main', label: 'main', trailingButton: { id: 'open', iconName: 'ExternalLink', tooltip: '在浏览器打开' } },
   *   ];
   * }
   * async execute(ctx, itemId, actions) {
   *   if (itemId === '__trailing__:open') { openInBrowser(); return; }
   *   if (itemId === 'main') { await checkout('main'); }
   * }
   */
  export interface ComposerActionMenuItemTrailingButton {
    /** 按钮唯一 id。点击时以 `execute(ctx, '__trailing__:<id>', actions)` 回调。 */
    readonly id: string;
    /** 按钮图标 {@link IconRef}（内置 Lucide 名或 `ext:<packId>/<iconId>`）。 */
    readonly iconName: IconRef;
    /** 悬停按钮时的 tooltip 文字。 */
    readonly tooltip?: string;
    /** 禁用该按钮（灰显、不可点击）。 */
    readonly disabled?: boolean;
  }

  /** Composer 按钮下拉菜单中的一项。 */
  export interface ComposerActionMenuItem {
    readonly id: string;
    readonly label: string;
    /** 标记当前激活项（显示选中状态）。 */
    readonly current?: boolean;
    readonly disabled?: boolean;
    /** 将此项渲染为分割线；其他显示字段会被忽略。 */
    readonly separator?: boolean;
    /** 右侧的辅助文字（如快捷键、状态描述）。若同时提供 `trailingButton`，悬停时按钮顶替此文字。 */
    readonly description?: string;
    /**
     * 菜单项右侧的独立操作按钮，悬停菜单行时显示，点击触发 `execute('__trailing__:<id>')`。
     * 子菜单项（带 `children`）不支持，会被忽略。详见 {@link ComposerActionMenuItemTrailingButton}。
     */
    readonly trailingButton?: ComposerActionMenuItemTrailingButton;
    /** 悬浮该菜单项时通过 HoverCard 展示的较长纯文本说明，支持换行。 */
    readonly hoverText?: string;
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
   *     return listBranches(cwd).map(b => ({
   *       id: b,
   *       label: b,
   *       iconName: 'GitBranch',
   *       hoverText: `切换到 ${b} 分支`,
   *     }));
   *   },
   *   async execute({ cwd }, branchName, actions) {
   *     await checkout(cwd, branchName);
   *     await actions.fillComposer(`已切换到 ${branchName}`);
   *   },
   * });
   */
  /** Context passed to the owning SessionContainer's settings menu. */
  export interface SessionContainerSettingsMenuContext {
    readonly cwd: string | undefined;
    readonly minitoolId: string;
    readonly containerId: string;
  }

  /** Each declared SessionContainer may register exactly one settings menu. */
  export interface SessionContainerSettingsMenuProvider {
    getMenu(ctx: SessionContainerSettingsMenuContext): Promise<ComposerActionMenuItem[]>;
    execute(ctx: SessionContainerSettingsMenuContext, itemId: string): Promise<void>;
  }

  /** 统一设置菜单当前渲染的位置。 */
  export type SettingsMenuSurface = 'container' | 'toolcase';

  /** 小工具统一设置菜单的运行时上下文。 */
  export interface SettingsMenuContext {
    readonly cwd: string | undefined;
    readonly minitoolId: string;
    /** `container`：会话容器页头部；`toolcase`：小工具箱卡片/详情页。 */
    readonly surface: SettingsMenuSurface;
    /** 仅当 `surface === 'container'` 时存在。 */
    readonly containerId?: string;
  }

  /**
   * 每个小工具最多注册一个统一设置菜单。
   *
   * @example
   * ctx.settingsMenu.register({
   *   async getMenu() {
   *     const account = await readAccount();
   *     return [
   *       { id: 'account', label: account ? `已登录：${account}` : '未登录', disabled: true },
   *       { id: 'login', label: account ? '重新登录' : '登录', iconName: 'LogIn' },
   *     ];
   *   },
   *   async execute(_ctx, itemId) {
   *     if (itemId === 'login') await login();
   *   },
   * });
   */
  export interface SettingsMenuProvider {
    getMenu(ctx: SettingsMenuContext): Promise<ComposerActionMenuItem[]>;
    execute(ctx: SettingsMenuContext, itemId: string): Promise<void>;
  }

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

  /** 可安全跨进程传递与持久化的 JSON 值。 */
  export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

  export interface DeliverySetOptions {
    readonly title: string;
    /**
     * 行右侧的说明文字（如 `+969 -354`）。支持和 `ConfirmDialogOptions.message`
     * 相同的行内 token 子集：`` `code` `` 与 `{text}\g/\r/\y/\m/\a/\b/\i`
     * 颜色/粗细/样式标记（g=绿 r=红 y=黄 m=灰 a=强调色 b=粗体 i=斜体）。
     * 仅支持单行——不支持 `>`/`!` 前缀，也不支持图片。
     */
    readonly detail?: string;
    readonly icon?: string;
    /** 点击此 Delivery 行打开 Panel App 时带入的上下文。 */
    readonly payload?: JsonValue;
  }

  export type DialogButtonVariant = 'primary' | 'secondary' | 'danger';

  export interface ConfirmDialogOptions {
    readonly title: string;
    readonly description?: string;
    /** Lightweight structured text. Supports blank lines, `code`, {text}\\g/\\r/\\y/\\m/\\a/\\b/\\i style tokens, > muted lines, ! warning lines, and standalone `![alt](src)` images. Image src accepts credential-free HTTPS URLs or base64 PNG/JPEG/WebP/GIF data URLs up to 5 MB. Dialog images stay UI-only and are not returned to the model. */
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
    /** Lightweight structured text. Supports blank lines, `code`, {text}\\g/\\r/\\y/\\m/\\a/\\b/\\i style tokens, > muted lines, ! warning lines, and standalone `![alt](src)` images. Image src accepts credential-free HTTPS URLs or base64 PNG/JPEG/WebP/GIF data URLs up to 5 MB. Dialog images stay UI-only and are not returned to the model. */
    readonly message?: string;
    readonly actions?: readonly ModalDialogActionOptions[];
    /**
     * 可选输入字段，复用 `ctx.ui.requestForm()` 同一套字段栅格
     * （text/password/textarea/number/select/boolean/link）。
     * 与 `requestForm` 不同，这个弹窗**不依赖正在运行的 tool call**——可以在
     * `MiniToolContext.ui` 的任意时机调用（ComposerAction 处理函数、设置菜单、
     * activate() 里等），因此适合让小工具在没有 Agent 回合的情况下手动收集文本/token 输入。
     * 声明 `fields` 后，主按钮（第一个 `variant: 'primary'` 的 action）在必填项未填完时禁用；
     * 提交后 `ModalDialogResult.values` 携带填写的值。
     *
     * @example
     * const result = await ctx.ui.showModalDialog({
     *   title: '配置 API Key',
     *   actions: [
     *     { id: 'cancel', label: '取消' },
     *     { id: 'save', label: '保存', variant: 'primary' },
     *   ],
     *   fields: [
     *     { key: 'apiKey', label: 'API Key', type: 'password', secret: true, required: true },
     *   ],
     * });
     * if (result.action === 'save') {
     *   await ctx.secrets.set('apiKey', String(result.values?.apiKey ?? ''));
     * }
     */
    readonly fields?: readonly MiniToolFormField[];
  }

  export interface ModalDialogResult {
    readonly action: string | 'dismissed';
    /** 仅当 `ModalDialogOptions.fields` 被设置时才存在。`multiselect` 字段为 `string[]`。 */
    readonly values?: Readonly<Record<string, string | number | boolean | string[]>>;
  }

  /**
   * Awaitable Modal result. `close(action?)` programmatically dismisses the visible
   * dialog and resolves this same handle exactly like a user action.
   */
  export interface ModalDialogHandle extends Promise<ModalDialogResult> {
    close(action?: string): Promise<void>;
  }

  /** `ctx.ui.pickFile()` 的过滤条件。 */
  export interface FilePickerFilter {
    /** 后缀白名单，形如 `.md`；省略表示不过滤。目录始终可见（用于展开浏览），不受此过滤影响。 */
    readonly extensions?: readonly string[];
  }

  export interface FilePickerOptions {
    readonly title?: string;
    readonly description?: string;
    /** 是否允许多选。默认 `false`（单选）。 */
    readonly multiple?: boolean;
    readonly filter?: FilePickerFilter;
    /** 预填搜索框内容。 */
    readonly initialQuery?: string;
    /** 覆盖默认根目录。省略时按当前 Space / 全局工作间解析。 */
    readonly root?: { readonly directoryPath: string };
    /**
     * 是否允许用户在弹窗内切换到其他 Space 或工作间。默认 `false`——只能在
     * 当前 Space/工作间目录下选择。仅在小程序自己判断当前处于
     * `contributes.appView` 页面等不绑定单一 Session/Space 的场景时传 `true`。
     */
    readonly allowSpaceSwitch?: boolean;
  }

  /** `ctx.ui.pickFile()` 返回的单个选中项。 */
  export interface PickedFileEntry {
    /** 绝对路径。 */
    readonly path: string;
    /** 相对于选择时所在根目录的路径，仅用于展示。 */
    readonly relativePath: string;
    readonly name: string;
    readonly isDir: boolean;
    /** 选择时所在的 Space（如有）。 */
    readonly spaceId?: string;
    readonly spaceName?: string;
  }

  export interface FilePickerResult {
    readonly action: 'select' | 'dismissed';
    /** `dismissed` 时为空数组。 */
    readonly files: readonly PickedFileEntry[];
  }

  /** 与 {@link ModalDialogHandle} 同构：可 await，也可编程关闭（视为用户取消）。 */
  export interface FilePickerHandle extends Promise<FilePickerResult> {
    close(): Promise<void>;
  }

  /** 工具栏 `menu` 项下拉菜单里的一行。 */
  export interface AppPanelMenuItem {
    readonly id: string;
    readonly label: string;
    readonly icon?: IconRef;
    readonly disabled?: boolean;
    readonly separator?: boolean;
  }

  /**
   * 面板自身工具栏的一项——固定渲染在标签栏下方一整行（只要该面板处于激活
   * 状态），不藏进下拉菜单里，效果类似内置浏览器面板自带的地址/操作栏。
   * 可自由混排静态图标标题、普通按钮、会展开下拉菜单的 `menu` 按钮、纯分隔线，
   * 以及把后续项推到行尾的弹性空白。标题项仅展示，不会向页面发送消息；它
   * 也需要稳定的 `id`，以便通过 {@link AppPanel.updateToolbarItem} 更新：
   *
   * `button`/`menu` 项还支持 `checked`，用来做开关型工具栏按钮（如「显示行号」
   * 这类切换）：设为 `true` 时按钮渲染成按下态（accent 高亮背景 + `aria-pressed`），
   * 由小工具自己在 `finch:menu` 消息处理里维护这份开关状态并调用
   * `updateToolbarItem(id, { checked })` 同步：
   *
   * ```ts
   * toolbar: [
   *   { type: 'title', id: 'section-title', icon: 'book-open', label: '资料库' },
   *   { id: 'reload', icon: 'rotate-cw', tooltip: '重新加载' },
   *   { type: 'separator' },
   *   { id: 'share', label: '分享', icon: 'share-2' },
   *   { id: 'wrap', label: '自动换行', icon: 'wrap-text', checked: true },
   *   { type: 'spacer' },
   *   { type: 'menu', id: 'more', icon: 'ellipsis', items: [
   *     { id: 'clear-log', label: '清空日志' },
   *     { id: 'sep', label: '', separator: true },
   *     { id: 'about', label: '关于', icon: 'sparkles' },
   *   ] },
   * ]
   * ```
   */
  export type AppPanelToolbarItem =
    | { readonly type?: 'button'; readonly id: string; readonly label?: string; readonly icon?: IconRef; readonly tooltip?: string; readonly disabled?: boolean; readonly checked?: boolean }
    | { readonly type: 'menu'; readonly id: string; readonly label?: string; readonly icon?: IconRef; readonly tooltip?: string; readonly disabled?: boolean; readonly checked?: boolean; readonly items: readonly AppPanelMenuItem[] }
    | { readonly type: 'title'; readonly id: string; readonly icon: IconRef; readonly label: string }
    | { readonly type: 'separator' }
    | { readonly type: 'spacer' };

  /** 可修改的顶层工具栏项展示字段。 */
  export interface AppPanelToolbarItemPatch {
    readonly label?: string;
    readonly icon?: IconRef;
    readonly tooltip?: string;
    readonly disabled?: boolean;
    /** 切换按钮/menu 触发器的按下（checked）态；见 {@link AppPanelToolbarItem}。 */
    readonly checked?: boolean;
  }

  /**
   * AppPanel 页面收到的 Finch 主题 CSS 变量（`--finch-*`）——在完整
   * FinchUI 组件库落地之前，先只提供已解析好的主题色/圆角/阴影/字体 token，
   * 让扩展作者可以直接写 `color: var(--finch-text-primary)` 之类的纯 CSS 来
   * 适配当前皮肤（含浅色/深色与用户自定义皮肤），不需要任何 Bridge 消息或
   * JS 代码。平台在页面 `dom-ready` 时以及宿主主题变化时自动重新注入，无需
   * 扩展代码处理。也可用 `getComputedStyle(document.documentElement)
   * .getPropertyValue('--finch-theme-mode')`（值为 `'light'` 或 `'dark'`）
   * 做纯 CSS 变量之外的 JS 分支判断。生效范围：打包 `extension`/内联 `html`
   * 页面总是注入；`url` 页面仅当满足与 Bridge 相同的 localhost + allowlist
   * 条件时才注入，公网页面永不注入。
   */
  export type AppPanelThemeVar =
    | "--finch-bg-root" | "--finch-bg-main" | "--finch-bg-elevated" | "--finch-bg-hover" | "--finch-bg-active"
    | "--finch-text-primary" | "--finch-text-secondary" | "--finch-text-tertiary"
    | "--finch-accent" | "--finch-accent-hover" | "--finch-accent-dim"
    | "--finch-border" | "--finch-border-subtle" | "--finch-border-strong"
    | "--finch-positive" | "--finch-warning" | "--finch-danger" | "--finch-info"
    | "--finch-radius-sm" | "--finch-radius-md" | "--finch-radius-lg" | "--finch-radius-full"
    | "--finch-shadow-sm" | "--finch-shadow-md"
    | "--finch-font-body" | "--finch-font-mono"
    | "--finch-message-font-size" | "--finch-message-line-height"
    | "--finch-code-font-size" | "--finch-code-line-height"
    | "--finch-theme-mode";

  /**
   * `createPanel` 成功创建面板后，平台会自动向已注入 Bridge 的页面
   * postMessage 一条保留消息，页面可在 `window.finch.onMessage` 里按
   * `msg.type === 'finch:env'` 识别，无需扩展代码手动下发即可拿到运行环境。
   * `finch:` 前缀为平台保留，业务消息请避免使用同名 `type`。
   */
  export interface AppPanelEnvMessage {
    readonly type: 'finch:env';
    /**
     * 面板归属的工作区目录；非 Session scope（如 Home）可能为空字符串。
     * `view === 'appView'` 时固定反映默认工作区目录，与当前激活的 Space
     * 无关（见 `view` 字段说明）。
     */
    readonly cwd: string;
    /** 面板归属的真实 Agent Session id；非 Session scope（如 Home/AppView）为空字符串。 */
    readonly sessionId: string;
    /**
     * 面板所在的路由类型：`'session'`（有真实 Agent Session，`sessionId` 非空）、
     * `'home'`（无 Session，但仍有一个 Home Composer 草稿可以写入 —— 例如通过
     * `composer:addContexts` 插入的批注会落到当前 Space 的 Home 输入框）、
     * `'container'`（既无 Session 也无 Composer 草稿，例如小工具的收件箱容器
     * 视图）、`'appView'`（`contributes.appView` 声明的应用级左侧栏全屏页面，
     * 同样既无 Session 也无 Composer 草稿，且不跟随任何 Space —— `spaceId`/
     * `spaceName` 固定为空字符串，`cwd` 固定是默认工作区目录）。历史/无法识别
     * 的 scope 为空字符串，页面应按 `sessionId` 是否非空兜底判断，不要假设一
     * 定拿到本字段。
     */
    readonly view: 'home' | 'session' | 'container' | 'appView' | '';
    /**
     * 面板所在 scope 当前归属的 Space id；未绑定 Space（如自由 Home/自由
     * Session，或 `view === 'appView'`）时为空字符串。Mini Tool 后端代码通过
     * `ctx` 拿到的 `WorkspaceInfo.spaceId` 是同一个值，这里把它同步暴露给页
     * 面本身，避免页面为了拿 Space 信息还要专门 `postMessage` 一次工具调用。
     */
    readonly spaceId: string;
    /** `spaceId` 对应的展示名称（已本地化/用户自定义），与 `spaceId` 同时为空或同时非空。 */
    readonly spaceName: string;
    /**
     * 当前 Finch App 语言（`ctx.app.getInfo().locale` 的同一个值），页面可据此
     * 本地渲染文案而不必再发一次工具调用去问后端。所有 scope（`session`/`home`/
     * `container`/`appView`）都会下发。
     */
    readonly locale?: AppLocale;
    /** 本次打开带入的上下文；页面重建后仍从当前 Session 的 Panel Tab 恢复。 */
    readonly payload?: JsonValue;
  }

  /**
   * 用户点击 manifest toolbar 按钮或下拉菜单项时，平台会向页面自身
   * postMessage 一条保留消息。页面在 `window.finch.onMessage` 中按
   * `msg.type === 'finch:menu'` 识别并处理。
   */
  export interface AppPanelMenuMessage {
    readonly type: 'finch:menu';
    /** 被点击项的 id：工具栏按钮/menu 按钮本身的 id，或其下拉菜单里某一行的 `AppPanelMenuItem.id`。 */
    readonly itemId: string;
  }

  export interface AppPanelOptions {
    /** 覆盖 `appPanel.instanceMode`；不传则使用 manifest 声明。 */
    readonly instanceMode?: 'single' | 'multiple';
    /** 跟随当前 Session Panel Tab 保存的打开上下文。 */
    readonly payload?: JsonValue;
  }

  export interface AppPanel {
    readonly id: string;
    /**
     * 打开/持有该 Panel scope 的真实 Agent Session id；非 Session scope
     * （Home、session container）为 undefined。后端代码（例如
     * `ctx.ui.onDidOpenPanel` 监听器）可以直接用它判断是哪个 Session 打开了
     * 这个面板，不必等待页面侧的 `finch:env` 消息。
     */
    readonly sessionId?: string;
    /**
     * 与页面侧 `finch:env.view` 一致的分类：`'session' | 'home' | 'container'`，
     * 另有 `'appView'` —— 表示这个句柄来自用户直接打开的 `contributes.appView`
     * 应用级页面（而非通过 `createPanel()` 创建），没有自己的 Session/Home/
     * Container scope。
     */
    readonly view?: 'home' | 'session' | 'container' | 'appView';
    /** 该 scope 当前绑定的 Space（如有），与页面侧 `finch:env.spaceId` 一致。 */
    readonly spaceId?: string;
    /** `spaceId` 对应的展示名称，与 `spaceId` 同时为 undefined 或同时有值。 */
    readonly spaceName?: string;
    /** 当前 Panel 实例的打开上下文；single 实例再次打开时会更新。 */
    readonly payload?: JsonValue;
    /** 仅当本实例是实际展开、未被响应式隐藏的 Panel 中当前选中 tab 时为 true。 */
    readonly visible: boolean;
    reveal(): Promise<void>;
    postMessage(message: unknown): Promise<void>;
    /** 原子替换该 Panel App 的整行工具栏。 */
    setToolbar(items: readonly AppPanelToolbarItem[]): Promise<void>;
    /** 按稳定 id 更新一个顶层工具栏项的展示字段。 */
    updateToolbarItem(itemId: string, patch: AppPanelToolbarItemPatch): Promise<void>;
    onDidReceiveMessage(listener: (message: unknown) => unknown): Disposable;
    /**
     * tab 选择、scope 切换、Panel 折叠/展开或响应式自动隐藏导致实际可见性变化时触发。
     * `true` 不代表 guest 页面已安装消息监听器；恢复后端状态时，页面仍须在
     * `window.finch.onMessage` 安装后主动发送 ready/init 握手。
     */
    onDidChangeVisibility(listener: (visible: boolean) => unknown): Disposable;
    onDidDispose(listener: () => unknown): Disposable;
    dispose(): void;
  }

  export interface FileRangeAnnotation {
    readonly startLine: number;
    readonly startColumn?: number;
    readonly endLine?: number;
    readonly endColumn?: number;
  }

  export type ComposerContextDraft =
    | { readonly type: 'file-range'; readonly path: string; readonly ranges: readonly FileRangeAnnotation[]; readonly note?: string; readonly displayName?: string }
    | { readonly type: 'image-region'; readonly name: string; readonly mimeType: string; readonly content: string; readonly regions: ReadonlyArray<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly note?: string }>; readonly note?: string; readonly displayName?: string }
    | {
        /**
         * Adds a "user annotation" chip token to the Composer instead of a bare
         * attachment — hovering the chip reveals the image/note. The heavy
         * payload (image bytes, long note text) still ends up in the sent
         * message's `attachments[]`; the token itself only carries ids.
         */
        readonly type: 'annotation';
        /** Composer chip text. Defaults to a generic "user annotation" label when omitted. */
        readonly label?: string;
        /** File this annotation points at (absolute path, must stay inside the active workspace). */
        readonly path?: string;
        readonly ranges?: readonly FileRangeAnnotation[];
        /** User-entered comment attached to this annotation. */
        readonly note?: string;
        /** Tool/program-authored prompt shown in the hover card and sent to the model instead of / alongside `note`. */
        readonly promptText?: string;
        /**
         * Tool/program-authored hint sent to the model but *not* rendered in
         * the hover card body (unlike `note`/`promptText`) — use it for
         * machine-oriented instructions (e.g. "call tool X with id=Y to
         * resolve the exact location") that would otherwise clutter what the
         * user sees. It still ends up in the raw message text a technically
         * curious user could inspect (conversation export, dev tools) — this
         * is intentional, not a covert/hidden channel. Do not abuse this for
         * anything the user would object to if they saw it.
         */
        readonly reminder?: string;
        /** Optional image evidence (base64, no data URL prefix) attached to the annotation. */
        readonly image?: { readonly name: string; readonly mimeType: string; readonly content: string };
        /** Optional local image path instead of inline base64. Resolved by Main. */
        readonly imagePath?: string;
      };

  /** Host-rendered Diff input. Finch chooses Panel or modal from the user's settings. */
  export type AppViewDiffRequest =
    | { readonly type: 'files'; readonly leftPath: string; readonly rightPath: string; readonly title?: string }
    | { readonly type: 'git'; readonly repoPath: string; readonly base: string; readonly target: string; readonly title?: string };

  /** 选择 Finch 原生文件预览打开 HTML 的方式。 */
  export type HtmlPreviewMode = 'browser' | 'code';

  /** 原生文件预览的可选行为。 */
  export interface FilePreviewOptions {
    /** HTML/HTM 默认在浏览器打开；传入 `code` 可查看源码。 */
    readonly htmlPreview?: HtmlPreviewMode;
  }

  /** Shape exposed as `window.finch` inside a trusted Webview Panel page. */
  export interface WebviewBridgeApi {
    postMessage(message: unknown): void;
    onMessage(listener: (message: unknown) => void): () => void;
    /**
     * Attaches contexts into the Composer draft this panel's scope owns.
     * Works on `'session'` scope (writes into that Session's draft) and
     * `'home'` scope (writes into the current Space's Home Composer draft —
     * see `AppPanelEnvMessage.view`). Rejects on `'container'` scope or
     * any legacy/unrecognized scope, since neither has a Composer draft to
     * attach into.
     */
    readonly composer: { addContexts(contexts: readonly ComposerContextDraft[]): Promise<{ added: number }> };
    readonly capture: { capturePage(options?: { mode?: 'viewport' | 'selection'; rect?: { x: number; y: number; width: number; height: number } }): Promise<{ name: string; mimeType: 'image/png'; content: string }> };
    /** Controls the current Panel tab from inside its page. */
    readonly panel: {
      setTitle(title: string): Promise<void>;
      setIcon(icon?: IconRef): Promise<void>;
    };
    /**
     * Native Finch toast / confirm dialog, callable directly from the page —
     * the same trusted UI `ctx.ui.showToast()` / `ctx.ui.showConfirmDialog()`
     * render on the extension backend side. Never falls back to a browser-native
     * `confirm()`/`alert()`; both calls require a real page
     * user gesture, same as `composer.addContexts()` / `capture.capturePage()`.
     *
     * @example
     * document.getElementById('delete-btn').addEventListener('click', async () => {
     *   const { confirmed } = await window.finch.ui.confirm({
     *     title: 'Delete this item?',
     *     message: 'This cannot be undone.',
     *     variant: 'danger',
     *   });
     *   if (!confirmed) return;
     *   await doDelete();
     *   await window.finch.ui.toast({ title: 'Deleted', variant: 'success' });
     * });
     */
    readonly ui: {
      toast(options: ToastOptions): Promise<ToastResult>;
      confirm(options: ConfirmDialogOptions): Promise<ConfirmDialogResult>;
    };
    /**
     * 只读 Space 目录，页面可直接调用而无需经过本工具后端再转发一次
     * 消息。与 `ctx.spaces.list()` 是同一份数据，供纯静态 `appPanel`
     * 页面（无后端 tool 调用能力）使用。
     */
    readonly spaces: {
      list(): Promise<SpaceSummary[]>;
    };
    /**
     * 宿主级导航能力。与普通 `<a href="finch://…">` 不同，这些方法不会让
     * guest webview 自己加载自定义协议，也不会通过系统外部协议处理器跳出
     * 当前窗口；调用要求来自真实用户手势。
     */
    readonly navigation: Navigation;
    /**
     * 可信本地小程序页面均可调用。文件预览仅在 `contributes.appView` 页面
     * 内可用；Diff 可在 App View 或 Panel App 中调用，二者都交给 Finch 宿主
     * 打开并遵循用户的「改动与文件预览」Panel/弹窗设置；浏览器或另一个
     * 已声明 `embeddable: true` 的小程序 `appView` 页面
     * 才作为下一层级压入 Appview 导航栈。栈会显示为多级面包屑
     * （`小程序 > 当前小程序 > 浏览器 > ...`）；点击面包屑中的某一级会
     * 关闭它右侧（含自身）的所有层级，回到该级 —— 这是唯一的返回方式，
     * 没有单独的"关闭"调用。
     *
     * 浏览器/小程序栈深度有限（当前上限 3 层），超出会 reject；`openApp` 额外做防环检测
     * ——不能把已经在当前栈路径上的小程序再打开一次。不做状态保留：某一层
     * 被关闭后会被销毁，不保留滚动位置等内部状态，下次重新打开会重新加载。
     *
     * @example
     * document.getElementById('open-report').addEventListener('click', async () => {
     *   await window.finch.appView.openPreview('/Users/me/report.md');
     * });
     */
    readonly appView: {
      /** 用 Finch 内置文件预览展示本地文件；展示位置遵循用户设置。 */
      openPreview(path: string, options?: FilePreviewOptions): Promise<{ id: string }>;
      /**
       * 用 Finch 内置 Diff 展示两个本地文件，或 Git repository 中两个 commit/ref
       * 的多文件差异；App View 和 Panel App 都可调用。展示位置遵循用户设置，
       * 调用方不能指定 Panel/弹窗。允许异步准备本地快照后调用。
       */
      openDiff(request: AppViewDiffRequest): Promise<{ id: string }>;
      /** 压入内置浏览器面板，加载给定的 http(s) 地址。 */
      openBrowser(url: string): Promise<{ id: string }>;
      /**
       * 压入另一个小程序的 `contributes.appView` 页面。目标小程序必须在自己
       * 的 manifest 中声明 `contributes.appView.embeddable: true`，否则会
       * reject；默认拒绝，需要显式声明才能被其他小程序嵌入。
       */
      openApp(extensionId: string): Promise<{ id: string }>;
    };
  }

  /** 公开的 macOS 置顶层级，仅支持常规与浮动窗口。 */
  export type AlwaysOnTopLevel = 'normal' | 'floating';

  /** CanvasWindow 的显式生命周期；`disposed` 是不可逆终态。 */
  export type CanvasWindowState = 'creating' | 'ready' | 'visible' | 'hidden' | 'disposing' | 'disposed';

  /** 在一次主进程控制中提交的窗口模式更新。 */
  export interface CanvasWindowUpdate {
    bounds?: { x?: number; y?: number; width?: number; height?: number };
    alwaysOnTop?: boolean;
    alwaysOnTopLevel?: AlwaysOnTopLevel;
    alwaysOnTopRelativeLevel?: number;
    clickThrough?: boolean;
    visible?: boolean;
  }

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
    /** 允许窗口越出屏幕工作区，默认 false。 */
    allowOffscreen?: boolean;
    /** 不在 Mission Control（调度中心）中显示，默认 false。仅 macOS，其他平台忽略。 */
    hiddenInMissionControl?: boolean;
    /** 在所有桌面 Space（含全屏空间）显示，切换桌面时窗口跟随，默认 false。仅 macOS，其他平台忽略。 */
    visibleOnAllWorkspaces?: boolean;
    /** 业务绘制帧率上限，默认 30。 */
    frameRate?: 15 | 30 | 60;
    /** Canvas backing store 的最大 DPR，默认 2，范围 1～4。 */
    maxDevicePixelRatio?: number;
    /** macOS 原生窗口置顶层级。其他平台忽略。 */
    alwaysOnTopLevel?: AlwaysOnTopLevel;
    /** 相对置顶层级。仅 macOS 且指定 `alwaysOnTopLevel` 时生效。 */
    alwaysOnTopRelativeLevel?: number;
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
   *   frame(dt) {},                 // 可选：连续动画，受 frameRate 限制
   *   render(ctx2d) {},             // 可选：按需绘制；与 frame 二选一
   *   resize(width, height) {},
   *   onPointer(e) {},              // { type:'move'|'down'|'up'|'cancel', pointerId, x, y, screenX, screenY, button, buttons, pointerType }
   *   onMessage(msg) {},            // 来自 Host 段 postMessage
   *   suspend(reason) {},           // hidden/system/sleep 时暂停
   *   resume(reason) {},            // visible/system/wake 时恢复；首帧 dt 已重置
   *   dispose() {},
   * });
   * ```
   *
   * 外壳注入的 `finch` 桥（Canvas 段可调用）：
   * `finch.postMessage(msg)` / `finch.window.startDrag()` / `finch.window.setAlwaysOnTop(v, level?, relativeLevel?)` /
   * `finch.window.setPosition(x,y)` / `finch.window.getDisplays()` / `finch.window.setClickThrough(v)` /
   * `finch.window.close()`；按需绘制可调用 `finch.canvas.invalidate()`。
   */
  export interface CanvasWindowMotion {
    kind: 'linear' | 'spring';
    to: { x: number; y: number };
    /** 默认 linear=300ms、spring=600ms，范围 16～60000ms。 */
    durationMs?: number;
    velocity?: { x: number; y: number };
    bounds?: 'display-work-area' | 'all-displays';
    /** Main 侧原生移动频率，默认 30。 */
    frameRate?: 30 | 60;
  }

  export interface CanvasWindow {
    /** 窗口唯一 id。 */
    readonly id: string;
    /** shell 加载、define 注册及 init 成功后 resolve；创建取消或失败时 reject。 */
    readonly ready: Promise<void>;
    readonly state: CanvasWindowState;
    readonly visible: boolean;
    show(): void;
    hide(): void;
    setAlwaysOnTop(value: boolean, level?: AlwaysOnTopLevel, relativeLevel?: number): void;
    setPosition(x: number, y: number): void;
    setSize(width: number, height: number): void;
    setClickThrough(value: boolean): void;
    /** 原子更新单个窗口；bounds 在原生层只调用一次 setBounds。 */
    update(options: CanvasWindowUpdate): Promise<void>;
    /** Main 侧执行持续移动，新 motion 会覆盖旧 motion。 */
    startMotion(motion: CanvasWindowMotion): void;
    stopMotion(): void;
    /** Host 段 → Canvas 段：脚本内 `onMessage(msg)` 接收。 */
    postMessage(message: unknown): Promise<void>;
    /** Canvas 段 → Host 段：脚本内 `finch.postMessage()` 触发。 */
    readonly onDidReceiveMessage: Event<unknown>;
    /** 窗口被移动（拖动结束或 setPosition）时触发。 */
    readonly onDidMove: Event<{ x: number; y: number }>;
    /** 窗口尺寸变化时触发。 */
    readonly onDidResize: Event<{ width: number; height: number }>;
    /** 实际可见性变化时触发。 */
    readonly onDidChangeVisibility: Event<boolean>;
    /** 生命周期状态变化时触发。 */
    readonly onDidChangeState: Event<CanvasWindowState>;
    /** 销毁窗口。重复调用安全。 */
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

  /** 插件贡献的一条 manifest contribution 原始记录。 */
  export interface MiniToolContribution<T = unknown> {
    extensionId: string;
    extensionName: string;
    extensionPath: string;
    source: 'global' | 'personal' | 'project';
    value: T;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // § 6.2  MiniToolContributions — 读取其它 mini tool 贡献
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * 读取已启用 mini tool 的 manifest contribution 快照。
   * Host 只按 extension point 名称透传原始值，具体语义由消费扩展自行定义。
   */
  export interface MiniToolContributions {
    listContributions<T = unknown>(point: string): MiniToolContribution<T>[];
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
    | 'tool_progress'
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
    /** 最近一条当前仍未读的会话；没有未读会话时为 undefined。 */
    readonly latestUnreadSessionId?: string;
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

  export type AppLocale = 'zh-CN' | 'zh-HK' | 'en-US';
  export type LocalePreference = 'system' | AppLocale;
  export type TranslationValue = string | number | boolean | null | undefined;
  export type TranslationValues = Record<string, TranslationValue>;

  /**
   * Mini tool 运行时 i18n。读取小工具自己的 `i18n/<locale>.json`。
   */
  export interface MiniToolI18n {
    /** 当前解析后的 app 语言，例如 `zh-CN`、`zh-HK` 或 `en-US`。 */
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
   * 对 manifest `permissions.secrets` 中声明的密钥进行加密、扩展隔离的访问。
   *
   * 插件可读取、写入和删除已授权的 key。Finch 只在系统安全存储可用时读写；
   * 不会回退为明文。权限支持精确 key 或末尾 `.*` 前缀（如 `mcp.*`），不接受裸 `*`。
   *
   * @example
   * // package.json → finch.permissions.secrets: ["OPENAI_API_KEY"]
   * await ctx.secrets.set('OPENAI_API_KEY', keyFromSecureForm);
   * const key = await ctx.secrets.get('OPENAI_API_KEY');
   * await ctx.secrets.delete('OPENAI_API_KEY');
   */
  export interface Secrets {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  }

  /** OAuth 2.0 公共客户端配置，支持 Authorization Code + PKCE 与 Device Flow。 */
  export interface OAuthProviderConfig {
    /** 稳定 provider id，必须在 manifest `permissions.oauth` 中声明。 */
    id: string;
    name: string;
    /** 小工具包内 Provider PNG 品牌图标的相对路径，例如 "assets/github.png"。 */
    icon?: string;
    /** 小工具开发者提供的公开 Client ID；终端用户无需配置。 */
    clientId: string;
    /** 默认 authorization_code（Authorization Code + PKCE）。 */
    flow?: 'authorization_code' | 'device_code';
    /** 默认 loopback；custom 使用开发者声明的 HTTPS callbackUrl。 */
    callbackStrategy?: 'loopback' | 'custom';
    /** callbackStrategy 为 custom 时必填，且必须为 HTTPS URL。 */
    callbackUrl?: string;
    authorizationEndpoint: string;
    /** flow 为 device_code 时必填。 */
    deviceAuthorizationEndpoint?: string;
    tokenEndpoint: string;
    scopes: string[];
    /** `ctx.oauth.request()` 允许访问的 HTTPS origin。 */
    resourceOrigins: string[];
    revocationEndpoint?: string;
    authorizationParams?: Record<string, string>;
  }

  export interface OAuthStatus {
    providerId: string;
    connected: boolean;
    scopes: string[];
    displayName?: string;
    email?: string;
    expiresAt?: number;
  }

  export interface OAuthRequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }

  export interface OAuthResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  }

  export interface OAuthInteractiveAuthorization {
    /** Manifest permissions.oauth 中声明的权限 id。 */
    providerId: string;
    providerName: string;
    /** 可选的可信 Provider 图标 URL，例如 finch-ext-icon://<scope>/<package>/icon.png。 */
    providerIcon?: string;
    /** 已包含 state 与 redirect_uri 的完整 HTTPS 授权 URL。 */
    authorizationUrl: string;
    state: string;
    /** 协议客户端注册的 HTTPS callback。 */
    callbackUrl: string;
  }

  export interface OAuthAuthorizationCode {
    code: string;
  }

  /**
   * 小工具私有 OAuth Broker。
   *
   * Finch 使用 Authorization Code + PKCE 或 Device Flow 完成登录，自动加密保存和刷新凭证。
   * `request()` 由主进程注入 Authorization；access token、refresh token 与 device code 永不返回小工具。
   */
  export interface OAuth {
    connect(provider: OAuthProviderConfig): Promise<OAuthStatus>;
    /** 为 MCP SDK 等外部协议客户端复用 Finch 原生授权 UI、浏览器与 callback。
     *  只返回授权码（AuthorizationCode），由调用方自行完成后续令牌交换。
     *  如需一键完成完整 OAuth 流程并使用已授权请求，请用 `connect()`。 */
    initiateAuthorization(input: OAuthInteractiveAuthorization): Promise<OAuthAuthorizationCode>;
    /** @deprecated 请改用 `initiateAuthorization`。 */
    authorize(input: OAuthInteractiveAuthorization): Promise<OAuthAuthorizationCode>;
    getStatus(provider: OAuthProviderConfig): Promise<OAuthStatus>;
    disconnect(provider: OAuthProviderConfig): Promise<void>;
    request(provider: OAuthProviderConfig, url: string, init?: OAuthRequestInit): Promise<OAuthResponse>;
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
    readonly 'zh-HK'?: string;
  };

  /**
   * 扩展详情页展示的 prompt 引导语。点击后会填入 HomeView Composer。
   */
  export interface MiniToolPromptGuide {
    readonly id?: string;
    readonly title: LocalizedString;
    readonly prompt: LocalizedString;
    readonly description?: LocalizedString;
  }

  /** Mini tool 类型与来源，用于工具箱/社区展示。 */
  export type MiniToolType = 'official' | 'community' | 'local' | string;

  /**
   * 扩展能力声明，用于官方扩展与社区扩展之间解耦。
   */
  export interface MiniToolCapabilitySpec {
    readonly capabilities?: readonly string[];
  }

  /**
   * OAuth-protected MCP server 的元数据。声明后，官方 MCP Client 代表本插件完成
   * discovery + DCR + PKCE、凭证保存与带鉴权的 transport，插件自己不接触 token。
   *
   * 这与 `permissions.oauth` + `ctx.oauth.*`（插件自建 OAuth provider）是两条不同路径，
   * 走这条路径时不需要在 `permissions.oauth` 里额外声明。
   */
  export interface McpServerOAuthContribution {
    /** 稳定的本地凭证 id，供 MCP Client 存取该 server 的凭证。 */
    readonly id?: string;
    /** OAuth 授权弹窗中展示的 Provider 名称。 */
    readonly providerName?: string;
    /**
     * OAuth 授权弹窗中的 Provider logo：**本插件包内**的相对 PNG 路径（如 `icon.png`）。
     * 在这里声明，等于授权 MCP Client 在代持授权流程时展示本插件的 logo；
     * scoped 包会解析为 `finch-ext-icon://<scope>/<package>/<path>`，并校验文件确实存在。
     * 记得把该文件加进 `package.json#files`。
     */
    readonly providerIcon?: string;
  }

  /** 贡献 MCP server 的工具短标题，按原始 MCP 工具名索引。 */
  export interface McpServerToolMetaContribution {
    readonly titles?: Readonly<Record<string, string>>;
  }

  /** 贡献 MCP server 的 ToolCallCard inline 摘要，按原始 MCP 工具名索引。 */
  export interface McpServerToolDisplayContribution {
    readonly tools?: Readonly<Record<string, ToolCallDisplay>>;
  }

  /** 三种 MCP server 声明形式共享的元数据字段。 */
  export interface McpServerContributionBase {
    /** server 名称。MCP Bridge 默认用它生成 `mcp__<server>__<tool>` 工具名前缀。 */
    readonly name: string;
    /** 用户可见说明，展示在插件详情页。 */
    readonly description?: string;
    /** OAuth 元数据，仅对 HTTP transport 的 MCP server 有意义。 */
    readonly oauth?: McpServerOAuthContribution;
    /** 该 server 暴露工具的短标题。 */
    readonly toolMeta?: McpServerToolMetaContribution;
    /** 该 server 暴露工具的 ToolCallCard inline 摘要。 */
    readonly toolDisplay?: McpServerToolDisplayContribution;
  }

  /**
   * 一个由插件贡献的 MCP server 声明，三选一：
   * 1. **仅元数据**（不带 transport）——transport 在 `activate()` 里通过
   *    `mcp.client#registerServer()` 注册，适用于需要 API Key / token 的 server；
   * 2. **stdio**——用 `command`/`args`/`env` 启动子进程；
   * 3. **HTTP**——用 `url`（可选 `headers`），OAuth server 走这一种。
   *
   * ⚠️ 绝不要把 API Key、token 等 secret 写进静态声明；只有不含 secret 的
   * transport 才适合直接写在 manifest 里。
   *
   * @example
   * // stdio
   * {
   *   "name": "filesystem",
   *   "command": "npx",
   *   "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
   *   "description": "Local filesystem access"
   * }
   *
   * @example
   * // OAuth-protected HTTP server，由 MCP Client 代持授权
   * {
   *   "name": "notion",
   *   "url": "https://mcp.notion.com/mcp",
   *   "oauth": { "id": "notion-mcp", "providerName": "Notion", "providerIcon": "icon.png" }
   * }
   */
  export type McpServerContribution =
    | (McpServerContributionBase & {
        /** 启动命令，如 `npx` 或可执行文件绝对路径。存在即表示 stdio transport。 */
        readonly command: string;
        /** 传给命令的参数。 */
        readonly args?: readonly string[];
        /** 额外环境变量。 */
        readonly env?: Readonly<Record<string, string>>;
        /** 子进程工作目录。 */
        readonly cwd?: string;
        readonly url?: never;
      })
    | (McpServerContributionBase & {
        /** MCP endpoint URL。存在即表示 httpStream transport。 */
        readonly url: string;
        /** 静态请求头；不要在这里放 secret。 */
        readonly headers?: Readonly<Record<string, string>>;
        readonly env?: Readonly<Record<string, string>>;
        readonly command?: never;
      })
    | (McpServerContributionBase & {
        readonly command?: never;
        readonly url?: never;
      });

  /** 一个 owner-scoped session 容器声明，供 `ctx.sessions.create()` 使用。 */
  export interface SessionContainerContribution {
    /** 当前小工具内稳定且唯一的容器 id。 */
    readonly id: string;
    /**
     * 容器入口图标。支持 Finch built-in {@link IconRef}，或通过
     * `contributes.iconPacks` + `ctx.icons.register()` 注册的 `ext:` SVG。
     * 省略时回退为 `bot`。
     */
    readonly icon?: IconRef;
    /**
     * 容器入口名称。支持 LocalizedString；也可在 `i18n/<locale>.json` 中用
     * `sessionContainers.<id>.title` 覆盖，切换 App 语言后立即更新。
     */
    readonly title?: LocalizedString;
    /** 可用 `sessionContainers.<id>.description` 提供语言覆盖。 */
    readonly description?: LocalizedString;
    /**
     * @deprecated 旧版容器级设置菜单入口，只显示在该容器的会话页头部；运行时通过
     * `ctx.sessionContainers.registerSettingsMenu()` 填充。新小工具请改用顶层
     * `contributes.settingsMenu` + `ctx.settingsMenu.register()`，它会同时出现在
     * 容器页头部和小工具箱里。
     * `icon` 遵循标准 IconRef（内置图标 id 或 `ext:<packId>/<iconId>` 自定义 SVG），
     * 省略时回退为 `sliders-horizontal`——注意这与容器自身 `icon` 的回退值 `bot` 不同。
     * `tooltip` 省略时回退为小工具名称。
     */
    readonly settingsMenu?: { readonly icon?: IconRef; readonly tooltip?: LocalizedString; };
    /**
     * 容器模式：
     * - `inbox`（默认）：Bot/多 Agent 聚合，会话由小工具发起，首页显示会话列表，
     *   不展示新建入口，支持容器级默认模型。
     * - `assistant`：行业场景助手，用户主动创建对话，首页展示角色介绍与引导提示词，
     *   隐藏容器模型选择，需要绑定 `agentProfile`。
     */
    readonly mode?: 'inbox' | 'assistant';
    /**
     * 绑定的 Agent 角色 profile id，引用 `contributes.agentProfiles` 中声明的 id。
     * `assistant` 模式必填，`inbox` 模式可选（例如 Bot 容器给所有来信会话统一人设）。
     * 该角色会以「用户 Finch 助手的搭档」身份注入：两个身份共存，Finch 本体的名字、
     * 性格与安全规则保留，角色只负责扩展专长与分工。因此 `prompt` 请写成"专长 + 工作方式"，
     * 不要写成"你是一个全新的、与 Finch 无关的 AI"。
     * 该容器内创建的每个会话都会自动绑定此 profile —— 无论
     * 是用户在 Finch 界面点「新对话」，还是小工具自己调用 `ctx.sessions.create()`；
     * profile 内容在会话创建时快照冻结，后续修改 manifest 不影响已存在的会话。
     * 容器之外的普通会话与 Space 会话永远不会带上 agentProfile。
     */
    readonly agentProfile?: string;
    /**
     * 容器首页展示的引导提示词，最多显示前四项。语言包可用
     * `sessionContainers.<containerId>.starterPrompts[<index>]` 覆盖其文案。
     */
    readonly starterPrompts?: readonly {
      /** 卡片标题。 */
      readonly title: LocalizedString;
      /** 卡片补充说明。 */
      readonly description?: LocalizedString;
      /** 点击卡片后直接发送的提示词。 */
      readonly prompt: LocalizedString;
    }[];
  }

  /** Panel App 内容来源。`local` 由 Finch 静态服务托管；`url` 不注入 Bridge。 */
  export type AppPanelEntrySource =
    | { readonly type: 'local'; readonly path: string }
    | { readonly type: 'url'; readonly url: string };

  /**
   * A mini tool's single application-level Webview page. Finch renders it as
   * a full route and adds its entry above Toolcase in the left sidebar. It is
   * not a right-side Panel tab: there is no Session scope, toolbar, instance
   * control, Delivery target, or `AppPanel` lifecycle handle.
   */
  export interface AppViewContribution {
    /**
     * Stable navigation title. Omit to inherit the mini tool's own `name`/
     * `displayName` (and its `i18n/<locale>.json` → `name` override) — a
     * mini tool's several entry surfaces (this App View, `appPanel`, its
     * Composer action…) should read as the same product, so only set this
     * when the App View genuinely needs a different label. If set, override
     * per-locale via `i18n/<locale>.json` → `appView.title`.
     */
    readonly title?: LocalizedString;
    /**
     * Optional longer description shown as the sidebar entry's tooltip
     * (replaces the default tooltip, which otherwise just repeats the mini
     * tool's name). Override per-locale via `i18n/<locale>.json` →
     * `appView.description`.
     */
    readonly description?: LocalizedString;
    /** Sidebar icon. Supports Finch built-in {@link IconRef} or `ext:` SVG. */
    readonly icon?: IconRef;
    /** Packaged `local` pages receive the trusted Bridge and Finch theme variables; public `url` pages do not. */
    readonly source: AppPanelEntrySource;
    /**
     * Whether another mini tool's own App View may open this page as a
     * nested child inside its Appview navigation stack via
     * `window.finch.appView.openApp(extensionId)`. Defaults to `false` —
     * a mini tool must opt in explicitly before others can embed it this
     * way; Finch's own built-in file preview / browser panels need no such
     * declaration.
     */
    readonly embeddable?: boolean;
  }

  /**
   * 小工具唯一的 Panel App 声明。一个小工具最多声明一个；它同时作为右侧 Panel
   * 的用户入口、`ctx.ui.createPanel()` 的运行时定义和 Delivery 行的点击目标。
   * `showInLauncher: false` 时隐藏右侧「+」菜单与起始页入口，但不影响其他打开路径。
   *
   * @example
   * "appPanel": {
   *   "title": "仪表盘",
   *   "icon": "gauge",
   *   "viewType": "demo.dashboard",
   *   "source": { "type": "local", "path": "dist/dashboard.html" }
   * }
   */
  export interface AppPanelContribution {
    /**
     * 入口显示名称。留空则继承小工具自身的 `name`/`displayName`
     * （及其 `i18n/<locale>.json` → `name` 覆盖）——同一小工具的各个入口
     * （本 Panel App、`appView`、Composer action…）在用户看来应是同一款
     * 工具，因此仅在该入口确实需要与小工具本身不同的名称时才显式声明。
     * 若声明，可用 `i18n/<locale>.json` → `appPanel.title` 提供语言覆盖。
     */
    readonly title?: LocalizedString;
    /** 入口图标。支持 Finch built-in {@link IconRef} 或 `ext:` SVG。 */
    readonly icon?: IconRef;
    /**
     * 面板类型 key。`instanceMode: 'single'` 时，同一会话内相同 `viewType` 的
     * 面板会被复用而不是重复打开。
     */
    readonly viewType: string;
    /**
     * 面板内容来源：
     * - `{ "type": "local", "path": "dist/page.html" }` —— 小工具包内页面，
     *   由平台静态服务以 `http://127.0.0.1:<port>/__finch_ext__/<extensionId>/...`
     *   加载（真实 http origin，ESM / fetch 可用），默认注入 JS Bridge。
     * - `{ "type": "url", "url": "https://…" }` —— 开发者自建服务或公网页面，
     *   不注入 JS Bridge。
     */
    readonly source: AppPanelEntrySource;
    /** `single` 面板在同一 Panel scope 内复用；默认 `multiple`。 */
    readonly instanceMode?: 'single' | 'multiple';
    /** 是否在右侧 Panel 的「+」菜单和起始页显示默认入口；默认 `true`。 */
    readonly showInLauncher?: boolean;
    /** 独立渲染在标签栏下方的工具栏行（静态），见 {@link AppPanelToolbarItem}。 */
    readonly toolbar?: readonly AppPanelToolbarItem[];
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
   *     "minVersion": "1.6.0",
   *     "id": "my-tool",
   *     "name": "My Tool",
   *     "description": "Does something useful.",
   *     "systemPrompt": "When the user asks about X, prefer this mini tool's tools.",
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
   *   "name": "我的小工具",
   *   "description": "做一些有用的事。",
   *   "systemPrompt": "当用户询问 X 时，优先使用这个小工具的工具。"
   * }
   */
  export interface MiniToolManifest {
    /** 必须为 `1`。 */
    readonly manifestVersion: 1;
    /**
     * 加载此小工具所需的最低 Finch 应用版本。必须是完整 SemVer（如 `1.6.0`），
     * 不支持 `>=1.6.0` 等范围表达式。省略时兼容所有支持当前 manifestVersion 的 Finch 版本。
     */
    readonly minVersion?: string;
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
    readonly promptGuides?: readonly MiniToolPromptGuide[];
    /** 编译后入口文件相对路径，默认 `dist/index.js`。 */
    readonly main: string;
    readonly activationEvents?: ActivationEvent[];
    readonly contributes?: {
      /** 是否贡献 Agent 工具。 */
      readonly tools?: boolean;
      /** 贡献的 Composer 工具栏按钮（静态声明）。 */
      readonly composerActions?: ComposerActionDeclaration[];
      /**
       * 小工具唯一的统一设置菜单入口（静态声明），运行时通过
       * `ctx.settingsMenu.register()` 填充内容。声明后按钮会同时出现在该小工具的
       * 会话容器页头部，以及小工具箱卡片（开关左侧）与详情页操作行。
       * `icon` 省略时回退为 `sliders-horizontal`，`tooltip` 省略时回退为「设置」。
       * 文案可在 `i18n/<locale>.json` 里用 `contributes.settingsMenu.tooltip` 覆盖。
       */
      readonly settingsMenu?: { readonly icon?: IconRef; readonly tooltip?: LocalizedString; };
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
      /** ctx.sessions.create() 可使用的 owner-scoped 容器声明。 */
      readonly sessionContainers?: readonly SessionContainerContribution[];
      /**
       * 小工具唯一的静态 App Panel 启动入口（一个小工具最多一个）。默认
       * 出现在右侧 Panel 的「+」菜单与起始页，点击直接打开该小工具的 App
       * Panel（无需 Agent 调用）。`showInLauncher: false` 可隐藏这两个入口。
       */
      readonly appPanel?: AppPanelContribution;
      /** One application-level page shown above Toolcase in the left sidebar. */
      readonly appView?: AppViewContribution;
    };
    readonly permissions?: MiniToolPermissions;
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
    readonly provides?: MiniToolCapabilitySpec;
    /** 本插件依赖的能力，如社区插件声明需要 mcp.client。 */
    readonly requires?: MiniToolCapabilitySpec;
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
   */
  export interface MiniToolPermissions {
    /** 文件系统访问级别。`'none'` = 禁止，`'read'` = 只读，`'readwrite'` = 读写。 */
    readonly filesystem?: 'none' | 'read' | 'readwrite';
    /** 是否允许发起网络请求。 */
    readonly network?: boolean;
    /** 是否允许执行 shell 命令。 */
    readonly shell?: boolean;
    /** 可访问的密钥 key 或末尾通配符前缀；通过系统安全存储加密。 */
    readonly secrets?: string[];
    /** 可通过 `ctx.oauth` 配置的 provider id 列表。 */
    readonly oauth?: string[];
    /** 是否允许创建并收发当前小工具自己拥有的 Session。 */
    readonly sessions?: boolean;
    /**
     * 是否允许代替用户应答自己 Session 里的等待（权限卡 / 提问卡 / 表单卡）。
     * 独立于 `sessions`：读取等待只需 `sessions`，应答才需要本权限。
     * destructive 权限卡可由程序拒绝以安全继续，但永远只能由真人批准。
     */
    readonly sessionInteractions?: boolean;
  }

} // end declare module 'finch'
