/** 只依赖一个最小的日志口子，便于在测试里断言而不引入 Finch 运行时。 */
export interface InboundFailureLogger {
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * 一封来信处理失败时只记录，**不丢弃当前会话绑定**。
 *
 * `ensureActiveWechatSession()` 每条收信都会先用 `ctx.sessions.get()` 校验指针是否
 * 仍然存在，所以「会话真的被删了」这条路径下一条消息就会自动新建；在这里删掉
 * `active-session` 反而只会在下一次来信时重新建一条会话，把上下文切断——换模型、
 * 模型暂时不可用、附件读取失败这类一次性错误都会白白付一次会话。
 *
 * 这条规则写在没有 storage 口的模块里，避免以后又顺手加回「出错就清指针」。
 */
export const reportInboundFailure = (
  logger: InboundFailureLogger,
  input: { accountId: string; peerId?: string; error: unknown },
): void => {
  const detail = input.error instanceof Error
    ? { name: input.error.name, message: input.error.message, stack: input.error.stack }
    : { value: String(input.error) };
  logger.error('handle inbound failed', { accountId: input.accountId, peerId: input.peerId, detail });
};
