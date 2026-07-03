/**
 * @finch/extension-api — Finch 扩展开发者契约（纯类型，零运行时依赖）
 *
 * ⚠️ 唯一权威类型来源是同目录下的 `finch.d.ts`（`declare module 'finch'`）。
 * 本文件不再重复定义一份类型，避免和 `finch.d.ts` 产生第二份可能过期的 API 定义。
 *
 * 正确用法 —— 在扩展的 `tsconfig.json` 里把 `finch` 模块说明符映射到 `finch.d.ts`：
 *
 * ```json
 * // tsconfig.json
 * {
 *   "compilerOptions": {
 *     "paths": { "finch": ["./node_modules/@finch/extension-api/finch.d.ts"] }
 *   }
 * }
 * ```
 *
 * ```ts
 * // src/index.ts
 * import type * as finch from 'finch';   // 类型 only，编译时完全擦除
 *
 * export function activate(ctx: finch.ExtensionContext) {
 *   ctx.subscriptions.push(
 *     ctx.tools.register({ ... }),
 *     ctx.composerActions.register('my-action', { ... }),
 *   );
 * }
 *
 * export function deactivate() {}
 * ```
 *
 * 完整指南见 `skills/finch-extension-creator/SKILL.md` 与 `finch.d.ts` 内的 JSDoc 注释。
 *
 * ──────────────────────────────────────────────────────────────────
 *  命名空间总览（详见 finch.d.ts 对应章节）
 *   ctx.extension         扩展自身元信息
 *   ctx.tools             向 Agent 贡献工具（Agent Tools）
 *   ctx.composerActions   向 Composer 工具栏贡献按钮（UI 扩展）
 *   ctx.capabilities      扩展间能力协作（provide/get）
 *   ctx.extensions        读取其它已启用扩展的 manifest contribution 快照
 *   ctx.storage           扩展私有 KV 存储
 *   ctx.settings          用户在扩展详情页配置的只读设置
 *   ctx.secrets           只读密钥访问
 *   ctx.logger            带扩展 id 前缀的日志
 *   ctx.session / ctx.workspace  当前 session / Space 只读快照
 * ──────────────────────────────────────────────────────────────────
 *
 * 禁止导入的旧风格（`export default function activate(finch: FinchPluginAPI)`）
 * 已从代码库和类型中彻底移除，不要按该风格编写扩展。
 */
export {};
