/**
 * @finch/extension-api — Finch 扩展开发者契约（纯类型，零运行时依赖）
 *
 * 这是扩展作者唯一需要了解的模块。扩展导出命名的 `activate(ctx)` 函数，
 * 通过传入的 `ctx` 上下文声明能力：
 *
 * ```ts
 * import type * as finch from 'finch';
 *
 * export function activate(ctx: finch.ExtensionContext) {
 *   ctx.tools.register({ ... });
 *   ctx.composerActions.register('my-action', { ... });
 * }
 * ```
 *
 * 完整指南见 skills/finch-extension-creator/ 与 packages/extension-api/finch.d.ts。
 *
 * ──────────────────────────────────────────────────────────────────
 *  命名空间总览
 *   ctx.extension         扩展自身元信息
 *   ctx.tools             向 Agent 贡献工具（Agent Tools）
 *   ctx.composerActions   向 Composer 工具栏贡献按钮（UI 扩展）
 *   ctx.storage           扩展私有 KV 存储
 *   ctx.secrets           只读密钥访问
 *   ctx.logger            带扩展 id 前缀的日志
 * ──────────────────────────────────────────────────────────────────
 */

// ── 通用工具 ───────────────────────────────────────────────────────────────────

/** 用于注销已注册能力的句柄（与 VS Code Disposable 模型一致）。 */
export interface Disposable {
  dispose(): void;
}

/**
 * JSON Schema 描述工具的输入结构。Finch 故意使用原生 JSON Schema
 * 而非 zod/typebox，保证扩展零 schema 运行时依赖。会原样传给模型。
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  required?: string[];
  enum?: unknown[];
  description?: string;
  [key: string]: unknown;
}

// ── 服务 ───────────────────────────────────────────────────────────────────────

/** 带扩展 id 前缀的日志，落到扩展日志文件。 */
export interface FinchExtensionLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 扩展私有 KV 存储（不要存密钥，密钥用 secrets）。 */
export interface FinchExtensionStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 对 manifest `permissions.secrets` 中声明的密钥的只读访问。 */
export interface FinchExtensionSecrets {
  get(key: string): Promise<string | undefined>;
}

/** 扩展自身元信息（只读）。 */
export interface FinchExtensionInfo {
  /** 扩展稳定 id（小写字母/数字/连字符）。 */
  id: string;
  displayName: string;
  version: string;
  /** 扩展安装目录的绝对路径。 */
  directory: string;
  scope: "global" | "space";
  spaceId?: string;
}

// ── finch.tools ────────────────────────────────────────────────────────────────

/** 工具执行时传入的上下文。 */
export interface FinchToolExecutionContext {
  toolCallId: string;
  sessionId: string;
  spaceId?: string;
  /** 当前 session 的工作目录（如有）。 */
  cwd?: string;
  /** 用户停止或工具超时时会收到中止信号。 */
  signal?: AbortSignal;
  logger: FinchExtensionLogger;
  storage: FinchExtensionStorage;
  secrets: FinchExtensionSecrets;
}

/** 工具向模型返回的内容块。 */
export type FinchToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** 工具执行结果。 */
export interface FinchToolResult<TDetails = unknown> {
  /** 给模型看的内容，至少一个块。 */
  content: FinchToolContent[];
  /** 可选结构化数据，供日志/未来 UI 渲染使用。 */
  details?: TDetails;
  /** 设为 true 则告知模型本次调用出错。 */
  isError?: boolean;
}

/** 扩展贡献的 Agent 工具定义。 */
export interface FinchToolDefinition<
  TInput = Record<string, unknown>,
  TDetails = unknown,
> {
  /** 扩展内工具名（小写/数字/下划线）。模型看到的是 `<extensionId>_<name>`。 */
  name: string;
  /** UI 展示短名。 */
  title: string;
  /** 给模型读的描述，决定何时调用。写清楚触发条件。 */
  description: string;
  /** JSON Schema，会原样发给模型。 */
  inputSchema: JsonSchema;
  defaultEnabled?: boolean;
  /** 风险提示，影响权限卡的呈现方式。 */
  risk?: "low" | "medium" | "high";
  execute(input: TInput, ctx: FinchToolExecutionContext): Promise<FinchToolResult<TDetails>>;
}

/** Agent 工具注册表（`finch.tools`）。 */
export interface FinchToolRegistry {
  register(tool: FinchToolDefinition): Disposable;
}

// ── finch.composerActions ──────────────────────────────────────────────────────
//
// VS Code 启发的 Contribution Point 模型：
//   - Manifest 在 contributes.composerActions[] 中静态声明按钮外观（id / icon / tooltip）
//   - activate() 中注册数据处理器（getBadge / getMenu / execute）
//   - Finch 负责渲染，扩展不需要接触任何 UI 库
//
// 示例：
//   // package.json#finch.contributes.composerActions
//   [{ "id": "git-branch", "icon": "GitBranch", "tooltip": "切换分支" }]
//
//   // activate()
//   finch.composerActions.register("git-branch", {
//     async getBadge(ctx) { return getCurrentBranch(ctx.cwd); },
//     async getMenu(ctx)  { return listBranches(ctx.cwd); },
//     async execute(ctx, itemId) { await checkout(ctx.cwd, itemId); },
//   });

/** 传给 composerAction 处理器的上下文。 */
export interface FinchComposerActionContext {
  /** 当前有效工作目录（Space 目录 或 workspace.projectPath）。 */
  cwd?: string;
  sessionId?: string;
  spaceId?: string;
}

/** 下拉菜单中的一项。 */
export interface FinchComposerActionMenuItem {
  id: string;
  label: string;
  /** 标记当前激活项（显示勾选标记）。 */
  current?: boolean;
  disabled?: boolean;
  /** 在此项前渲染分割线。 */
  separator?: boolean;
}

/**
 * ComposerAction 数据处理器。Manifest 声明按钮后，activate() 中
 * 通过 finch.composerActions.register(id, provider) 提供动态数据。
 */
export interface FinchComposerActionProvider {
  /**
   * 返回按钮徽标文字（如当前分支名）。返回 undefined 则只显示图标。
   * 也用于判断按钮是否可见：provider 不存在或 getBadge 抛出，则按钮隐藏。
   */
  getBadge?(ctx: FinchComposerActionContext): Promise<string | undefined>;
  /** 用户点击按钮后拉取的下拉菜单项。 */
  getMenu(ctx: FinchComposerActionContext): Promise<FinchComposerActionMenuItem[]>;
  /** 用户选中菜单项时执行。 */
  execute(ctx: FinchComposerActionContext, itemId: string): Promise<void>;
}

/** Composer 工具栏扩展注册表（`finch.composerActions`）。 */
export interface FinchComposerActionRegistry {
  /**
   * 将 actionId 对应的数据处理器注册到 Finch。
   * actionId 必须与 manifest contributes.composerActions[].id 对应。
   * 返回 Disposable，调用 dispose() 可注销。
   */
  register(actionId: string, provider: FinchComposerActionProvider): Disposable;
}

// ── FinchExtensionAPI（顶层 API 对象）─────────────────────────────────────────

/**
 * 传入 activate() 的顶层 API 对象。
 * 命名空间对照：
 *   finch.extension       → 扩展元信息
 *   finch.tools           → Agent 工具注册
 *   finch.composerActions → Composer 工具栏按钮注册
 *   finch.storage         → 私有 KV 存储
 *   finch.secrets         → 密钥访问
 *   finch.logger          → 日志
 */
export interface FinchExtensionAPI {
  readonly extension: FinchExtensionInfo;
  readonly tools: FinchToolRegistry;
  readonly composerActions: FinchComposerActionRegistry;
  readonly storage: FinchExtensionStorage;
  readonly secrets: FinchExtensionSecrets;
  readonly logger: FinchExtensionLogger;
}

/** 扩展入口，以模块默认导出形式提供。 */
export type FinchExtensionActivate = (finch: FinchExtensionAPI) => void | Promise<void>;

/** 扩展可选的清理钩子（disable/卸载时调用）。 */
export type FinchExtensionDeactivate = () => void | Promise<void>;
