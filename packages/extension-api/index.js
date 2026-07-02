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
export {};
