import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { reportInboundFailure, type InboundFailureLogger } from '../src/inbound';

function recorder(): { logger: InboundFailureLogger; calls: Array<[string, Record<string, unknown> | undefined]> } {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  return { calls, logger: { error: (message, data) => { calls.push([message, data]); } } };
}

test('inbound failure keeps the session pointer: only logs, never throws', () => {
  const { logger, calls } = recorder();
  assert.doesNotThrow(() => reportInboundFailure(logger, {
    accountId: 'acc_1', peerId: 'peer-1', error: new Error('model unavailable'),
  }));
  assert.equal(calls.length, 1);
  const [message, data] = calls[0];
  assert.equal(message, 'handle inbound failed');
  assert.equal(data?.accountId, 'acc_1');
  assert.equal(data?.peerId, 'peer-1');
  assert.deepEqual(
    { name: (data?.detail as { name: string }).name, message: (data?.detail as { message: string }).message },
    { name: 'Error', message: 'model unavailable' },
  );
  assert.match(String((data?.detail as { stack?: string }).stack), /model unavailable/);
});

test('non-Error failures are stringified instead of being dropped', () => {
  const { logger, calls } = recorder();
  reportInboundFailure(logger, { accountId: 'acc_1', error: { ret: -14 } });
  assert.deepEqual(calls[0][1]?.detail, { value: '[object Object]' });
  assert.equal(calls[0][1]?.peerId, undefined);
});

test('the message loop no longer deletes the active-session pointer on inbound failure', () => {
  // 测试被打包到临时目录执行，源文件按扩展根目录（npm test 的 cwd）读取。
  const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
  // 唯一会删掉「当前会话指针」的入站路径：删了它下一条来信就会新建会话、切断上下文。
  assert.equal(source.includes('delete(activeSessionKey(accountId))'), false);
  assert.match(source, /reportInboundFailure\(ctx\.logger/);
});
