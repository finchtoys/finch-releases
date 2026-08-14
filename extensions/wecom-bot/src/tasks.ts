import type * as finch from 'finch';
import {
  TASK_PREFIX,
  TASK_INDEX_KEY,
  type TaskRecord,
} from './types';
import { idempotencyKey } from './utils';

/**
 * Space 任务管理器：企微 Bot 派发到 Space 的任务会话 CRUD 与状态推进。
 * 与 wechat-bot 的 TaskManager 对齐，仅把 notifyPeerId 换成 peerKey + kind。
 */
export class TaskManager {
  constructor(private ctx: finch.MiniToolContext) {}

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

  async list(filter?: { spaceId?: string }): Promise<TaskRecord[]> {
    const index = (await this.ctx.storage.get<string[]>(TASK_INDEX_KEY)) ?? [];
    const out: TaskRecord[] = [];
    for (const id of index) {
      const t = await this.get(id);
      if (!t) continue;
      if (filter?.spaceId && t.spaceId !== filter.spaceId) continue;
      out.push(t);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 丢弃已不存在的任务（backing Session 被删除/在其他地方结算）。 */
  async remove(sessionId: string): Promise<void> {
    await this.ctx.storage.delete(`${TASK_PREFIX}${sessionId}`);
    const index = (await this.ctx.storage.get<string[]>(TASK_INDEX_KEY)) ?? [];
    await this.ctx.storage.set(TASK_INDEX_KEY, index.filter((id) => id !== sessionId));
  }

  private async applyTerminal(
    task: TaskRecord,
    event: Extract<finch.SessionDurableEvent, { type: 'turn.completed' | 'turn.failed' }>,
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
    if (event.type === 'turn.wait_resolved') {
      if (!task.lastTurnId || task.lastTurnId === event.turnId) {
        task.status = 'running';
        task.lastTurnId = event.turnId;
        task.updatedAt = Date.now();
        await this.save(task);
      }
      return true;
    }
    await this.applyTerminal(task, event);
    return true;
  }

  /** 等待当前任务 turn 的终态（供 status 工具的 waitMs 使用）。 */
  async waitFor(task: TaskRecord, timeoutMs: number): Promise<TaskRecord> {
    if (task.status === 'waiting' || task.status !== 'running' || !task.lastTurnId) return task;
    try {
      const outcome = await Promise.race([
        this.ctx.sessions.waitForTurn(task.sessionId, task.lastTurnId, { timeoutMs })
          .then((result) => ({ type: 'terminal' as const, result })),
        this.ctx.sessions.waitForWait(task.sessionId, { timeoutMs })
          .then((wait) => ({ type: 'wait' as const, wait })),
      ]);
      if (outcome.type === 'wait') {
        if (!outcome.wait) return task;
        task.status = 'waiting';
        task.lastTurnId = outcome.wait.turnId ?? task.lastTurnId;
        task.updatedAt = Date.now();
        await this.save(task);
        return task;
      }
      const result = outcome.result;
      if (result.state === 'timeout' || task.lastTurnId !== result.turnId) return task;
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

  /** 一行一个任务，无输出正文（索引列表 token 成本恒定）。 */
  static formatTaskSummary(task: TaskRecord): string {
    const ago = TaskManager.formatRelativeTime(task.updatedAt);
    return `${task.title || 'Untitled task'} · ${task.status} · taskId: ${task.sessionId} · spaceId: ${task.spaceId} · updated ${ago}`;
  }

  private static formatRelativeTime(ts: number): string {
    const diffMs = Date.now() - ts;
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  static idempotencyKey(prefix: string): string {
    return idempotencyKey(prefix);
  }
}
