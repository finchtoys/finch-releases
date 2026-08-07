import type * as finch from 'finch';
import {
  CTOKEN_PREFIX, TASK_PREFIX, TASK_INDEX_KEY,
  type TaskRecord,
} from './types';
import { MediaManager } from './media';
import { randomHex } from './utils';

/**
 * Space 任务管理器：Bot 派发到 Space 的任务会话的 CRUD 和状态推进。
 */
export class TaskManager {
  constructor(
    private ctx: finch.MiniToolContext,
    private media: MediaManager,
  ) {}

  get(sessionId: string): Promise<TaskRecord | undefined> {
    return this.ctx.storage.get<TaskRecord>(`${TASK_PREFIX}${sessionId}`);
  }

  async save(task: TaskRecord): Promise<void> {
    await this.ctx.storage.set(`${TASK_PREFIX}${task.sessionId}`, task);
    const index = (await this.ctx.storage.get<string[]>(TASK_INDEX_KEY)) ?? [];
    if (!index.includes(task.sessionId)) {
      index.push(task.sessionId);
      await this.ctx.storage.set(TASK_INDEX_KEY, index);
    }
  }

  async list(): Promise<TaskRecord[]> {
    const index = (await this.ctx.storage.get<string[]>(TASK_INDEX_KEY)) ?? [];
    const out: TaskRecord[] = [];
    for (const id of index) {
      const t = await this.get(id);
      if (t) out.push(t);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 把任务执行状态回馈到微信联系人。 */
  private async notifyResult(task: TaskRecord): Promise<void> {
    if (!task.notifyPeerId) return;
    const contextToken = await this.ctx.storage.get<string>(`${CTOKEN_PREFIX}${task.notifyPeerId}`);
    const label = task.title ? `「${task.title}」` : '任务';
    const body = task.status === 'completed'
      ? `✅ ${label}已完成：\n${(task.lastOutput ?? '').trim() || '（无文本输出）'}`
      : `❌ ${label}执行失败：${task.lastError ?? '未知错误'}`;
    try {
      await this.media.sendText(task.notifyPeerId, contextToken, body);
      this.ctx.logger.info('task result pushed to wechat', { sessionId: task.sessionId, status: task.status });
    } catch (error) {
      this.ctx.logger.error('notify task result failed', error);
    }
  }

  private async applyTerminal(
    task: TaskRecord,
    event: Extract<finch.SessionDurableEvent, { type: 'turn.completed' | 'turn.failed' }>,
    notify: boolean,
  ): Promise<void> {
    if (task.lastTurnId && task.lastTurnId !== event.turnId) return;
    task.lastTurnId = event.turnId;
    task.updatedAt = Date.now();
    if (event.type === 'turn.completed') {
      task.status = 'completed';
      task.lastOutput = event.outputText || task.lastOutput;
      task.lastError = undefined;
    } else {
      task.status = 'failed';
      task.lastError = event.code;
    }
    await this.save(task);
    if (notify) await this.notifyResult(task);
  }

  /** 处理 Space 任务事件，返回 true 表示已消费。 */
  async handleEvent(event: finch.SessionBridgeEvent): Promise<boolean> {
    if (event.type === 'assistant.delta' || event.type === 'assistant.message') return false;
    const task = await this.get(event.sessionId);
    if (!task) return false;
    if (event.type === 'turn.waiting') {
      if (!task.lastTurnId || task.lastTurnId === event.turnId) {
        task.status = 'waiting';
        task.lastTurnId = event.turnId;
        task.updatedAt = Date.now();
        await this.save(task);
      }
      return true;
    }
    await this.applyTerminal(task, event, true);
    return true;
  }

  /** 等待当前任务 turn 的终态。 */
  async waitFor(task: TaskRecord, timeoutMs: number): Promise<TaskRecord> {
    if ((task.status !== 'running' && task.status !== 'waiting') || !task.lastTurnId) return task;
    try {
      const result = await this.ctx.sessions.waitForTurn(task.sessionId, task.lastTurnId, { timeoutMs });
      if (result.state === 'timeout') return task;
      if (task.lastTurnId !== result.turnId) return task;
      task.updatedAt = Date.now();
      if (result.state === 'completed') {
        task.status = 'completed';
        task.lastOutput = result.outputText || task.lastOutput;
        task.lastError = undefined;
      } else {
        task.status = 'failed';
        task.lastError = result.code;
      }
      await this.save(task);
    } catch (error) {
      this.ctx.logger.debug('task wait failed', { sessionId: task.sessionId, error: String(error) });
    }
    return task;
  }

  static formatTask(task: TaskRecord): string {
    return [
      `${task.title || 'Untitled task'} · ${task.status}`,
      `taskId: ${task.sessionId}`,
      `spaceId: ${task.spaceId}`,
      task.lastError ? `Error: ${task.lastError}` : '',
      task.lastOutput ? `Latest output:\n${task.lastOutput}` : '',
    ].filter(Boolean).join('\n');
  }

  /** 生成唯一 idempotencyKey 的辅助。 */
  static idempotencyKey(prefix: string): string {
    return `${prefix}:${Date.now()}-${randomHex(4)}`;
  }
}
