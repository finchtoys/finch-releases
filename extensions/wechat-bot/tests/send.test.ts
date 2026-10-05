import assert from 'node:assert/strict';
import test from 'node:test';
import type * as finch from 'finch';
import en from '../i18n/en-US.json';
import zh from '../i18n/zh-CN.json';
import { ContextStore } from '../src/context';
import { IlinkClient, type IlinkAccount } from '../src/ilink-client';
import { MediaManager } from '../src/media';
import { AuthManager } from '../src/auth';
import {
  KEY_TOKEN, KEY_BASE_URL, KEY_BOT_ID, KEY_OWNER_USER,
  CTOKEN_PREFIX, SESSION_MAP_PREFIX, TURN_MAP_PREFIX, createBotState,
  type SendMessageResponse, type StatusResponse,
} from '../src/types';

const peer = 'test-peer';
const account: IlinkAccount = { botId: 'test-bot', botToken: 'test-auth-secret', baseUrl: 'https://test.invalid' };

function fixture(locale: 'en' | 'zh' = 'en') {
  const values = new Map<string, unknown>([
    [KEY_TOKEN, account.botToken], [KEY_BASE_URL, account.baseUrl],
    [KEY_BOT_ID, account.botId], [KEY_OWNER_USER, peer],
  ]);
  const secrets = new Map<string, string>();
  const logs: unknown[][] = [];
  const storage: finch.Storage = {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async set<T>(key: string, value: T) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
    async keys() { return [...values.keys()]; },
    async clear() { values.clear(); },
  };
  const ctx = {
    storage,
    secrets: {
      async get(key: string) { return secrets.get(key); },
      async set(key: string, value: string) { secrets.set(key, value); },
      async delete(key: string) { secrets.delete(key); },
    },
    logger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args: unknown[]) => logs.push(args)])),
    i18n: { t(key: string) {
      const messages = locale === 'zh' ? zh.runtime.send : en.runtime.send;
      return messages[key.replace('runtime.send.', '') as keyof typeof messages] ?? key;
    } },
  } as unknown as finch.MiniToolContext;
  const calls: { endpoint: string; body: unknown; token?: string }[] = [];
  let response: SendMessageResponse = { ret: 0 };
  let postHook: (() => Promise<unknown>) | undefined;
  class FakeIlink extends IlinkClient {
    override async post<T>(_base: string, endpoint: string, body: unknown, token?: string): Promise<T> {
      calls.push({ endpoint, body, token });
      return (postHook ? await postHook() : response) as T;
    }
  }
  const ilink = new FakeIlink(ctx, 'test-agent');
  const contexts = new ContextStore(ctx);
  const media = new MediaManager(ctx, ilink, contexts);
  return {
    ctx, values, secrets, logs, calls, ilink, contexts, media,
    respond(next: SendMessageResponse) { response = next; },
    onPost(hook: () => Promise<unknown>) { postHook = hook; },
    async inbound(token = 'test-context-secret') { await contexts.capture(peer, token, (await ilink.getAccount())!); },
  };
}

function fakeUpload(f: ReturnType<typeof fixture>, hook?: () => Promise<void>) {
  let count = 0;
  f.media.uploadMediaToCdn = async () => {
    count++;
    await hook?.();
    return { downloadEncryptedQueryParam: 'test-cdn', aeskeyHex: '00'.repeat(16), fileSize: 1, fileSizeCiphertext: 16 };
  };
  return () => count;
}

function lastToken(f: ReturnType<typeof fixture>): string | undefined {
  return (f.calls.at(-1)?.body as { msg?: { context_token?: string } })?.msg?.context_token;
}

test('缺少上下文时阻止文本发送并提供操作指引', async () => {
  const f = fixture();
  await assert.rejects(f.media.sendText(peer, 'hello'), /no message context.*message.*Bot first/);
  assert.equal(f.calls.length, 0);
});

test('中文错误提示可用，且不伪称上下文不够新', async () => {
  const f = fixture('zh');
  await assert.rejects(f.media.sendText(peer, 'hello'), /当前登录下没有收件人的消息上下文/);
  assert.doesNotMatch(JSON.stringify(f.logs), /recent/);
});

test('未登录与没有消息上下文分别提示', async () => {
  const f = fixture();
  f.values.delete(KEY_TOKEN);
  await assert.rejects(f.media.sendText(peer, 'hello'), /not logged in/);
  assert.equal(f.calls.length, 0);
});

for (const kind of ['image', 'video', 'file'] as const) {
  test(`${kind} 缺少上下文时不上传 CDN`, async () => {
    const f = fixture();
    const uploads = fakeUpload(f);
    const data = Buffer.from('x');
    const send = kind === 'image' ? f.media.sendImage(peer, data)
      : kind === 'video' ? f.media.sendVideo(peer, data) : f.media.sendFile(peer, data, 'test.txt');
    await assert.rejects(send, /no message context/);
    assert.equal(uploads(), 0);
    assert.equal(f.calls.length, 0);
  });
}

test('当前登录的入站消息建立上下文，且每次发送采用最新 token', async () => {
  const f = fixture();
  await f.inbound('context-1');
  await f.media.sendText(peer, 'hello');
  assert.equal(lastToken(f), 'context-1');
  await f.inbound('context-2');
  await f.media.sendText(peer, 'again');
  assert.equal(lastToken(f), 'context-2');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => call.endpoint === 'ilink/bot/sendmessage'));
});

test('新上下文只进入安全存储，KV 只保存接收时间', async () => {
  const f = fixture();
  await f.inbound();
  assert.ok([...f.secrets.keys()].every((key) => key.startsWith('wechat.context.')));
  assert.doesNotMatch(JSON.stringify([...f.values.entries()]), /test-context-secret/);
  assert.equal((await f.contexts.get(peer, account))?.token, 'test-context-secret');
});

test('接收时间只用于诊断，不臆造服务端 TTL', async () => {
  const f = fixture();
  await f.inbound();
  for (const key of f.values.keys()) {
    if (key.startsWith('context-meta:')) f.values.set(key, { receivedAt: 1 });
  }
  await f.media.sendText(peer, 'hello');
  assert.equal(f.calls.length, 1);
});

test('同一收件人在另一 bot 下不能沿用上下文', async () => {
  const f = fixture();
  await f.inbound();
  f.values.set(KEY_BOT_ID, 'another-bot');
  await assert.rejects(f.media.sendText(peer, 'hello'), /no message context/);
  assert.equal(f.calls.length, 0);
});

test('同一 bot 的新登录也不能沿用旧上下文', async () => {
  const f = fixture();
  await f.inbound();
  f.values.set(KEY_TOKEN, 'new-auth-secret');
  await assert.rejects(f.media.sendText(peer, 'hello'), /no message context/);
  await f.inbound('new-context');
  await f.media.sendText(peer, 'hello');
  assert.equal(lastToken(f), 'new-context');
});

test('迟到的旧轮询响应不能缓存到新登录下', async () => {
  const f = fixture();
  f.values.set(KEY_TOKEN, 'new-auth-secret');
  await f.contexts.capture(peer, 'old-response-token', account);
  assert.equal(f.secrets.size, 0);
});

test('prepare failed 提示可能失效并保留全部错误字段，不限流、不重试', async () => {
  const f = fixture();
  await f.inbound();
  f.respond({ ret: -2, errcode: 123, errmsg: 'prepare failed' });
  await assert.rejects(f.media.sendText(peer, 'private-text'), /may be stale.*ret=-2 errcode=123 prepare failed/);
  assert.equal(f.calls.length, 1);
  const logs = JSON.stringify(f.logs);
  assert.match(logs, /contextAgeMs/);
  assert.doesNotMatch(logs, /test-context-secret|test-auth-secret|private-text|test-peer/);
});

test('只有 errcode 非零也必须报失败', async () => {
  const f = fixture();
  await f.inbound();
  f.respond({ ret: 0, errcode: 9, errmsg: 'denied' });
  await assert.rejects(f.media.sendText(peer, 'hello'), /ret=0 errcode=9 denied/);
});

test('其他 ret=-2 不被误诊为上下文失效', async () => {
  const f = fixture();
  await f.inbound();
  f.respond({ ret: -2, errmsg: 'frequency limit' });
  await assert.rejects(f.media.sendText(peer, 'hello'), (err: Error) => {
    assert.doesNotMatch(err.message, /may be stale/);
    assert.match(err.message, /frequency limit/);
    return true;
  });
});

test('登录失效错误提示重新扫码', async () => {
  const f = fixture();
  await f.inbound();
  f.respond({ ret: 0, errcode: -14, errmsg: 'expired' });
  await assert.rejects(f.media.sendText(peer, 'hello'), /login has expired.*errcode=-14/);
});

test('服务端错误文本回显凭证时去敏，其他响应字段不进入日志', async () => {
  const f = fixture();
  await f.inbound();
  f.respond({ ret: 1, errmsg: `${account.botToken} test-context-secret ${peer}` });
  await assert.rejects(f.media.sendText(peer, 'hello'), (err: Error) => {
    assert.doesNotMatch(err.message, /test-auth-secret|test-context-secret|test-peer/);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(f.logs), /test-auth-secret|test-context-secret|test-peer/);
});

test('网络异常不自动重试', async () => {
  const f = fixture();
  await f.inbound();
  f.onPost(async () => { throw new Error('network timeout'); });
  await assert.rejects(f.media.sendText(peer, 'hello'), /network timeout/);
  assert.equal(f.calls.length, 1);
});

test('caption 业务失败时停止，不继续发送媒体', async () => {
  const f = fixture();
  await f.inbound();
  fakeUpload(f);
  f.respond({ ret: 0, errcode: 9, errmsg: 'caption rejected' });
  await assert.rejects(f.media.sendImage(peer, Buffer.from('x'), 'caption'), /caption rejected/);
  assert.equal(f.calls.length, 1);
  assert.equal((f.calls[0].body as { msg: { item_list: { type: number }[] } }).msg.item_list[0].type, 1);
});

test('caption 和媒体各自发送时重新读取最新上下文', async () => {
  const f = fixture();
  await f.inbound('first-context');
  fakeUpload(f);
  f.onPost(async () => {
    if (f.calls.length === 1) await f.inbound('second-context');
    return { ret: 0 };
  });
  await f.media.sendImage(peer, Buffer.from('x'), 'caption');
  assert.equal(f.calls.length, 2);
  assert.equal(lastToken(f), 'second-context');
});

test('caption 成功但媒体失败时明确报告部分成功', async () => {
  const f = fixture();
  await f.inbound();
  fakeUpload(f);
  f.onPost(async () => f.calls.length === 1 ? { ret: 0 } : { ret: -2, errmsg: 'prepare failed' });
  await assert.rejects(f.media.sendImage(peer, Buffer.from('x'), 'caption'), /caption was sent.*media delivery failed/);
  assert.equal(f.calls.length, 2);
});

test('媒体上传中切换账号，不把旧账号的媒体投递到新账号', async () => {
  const f = fixture();
  await f.inbound();
  fakeUpload(f, async () => {
    f.values.set(KEY_TOKEN, 'new-auth-secret');
    await f.inbound('new-context');
  });
  await assert.rejects(f.media.sendImage(peer, Buffer.from('x')), /login changed/);
  assert.equal(f.calls.length, 0);
});

test('安全存储不可用时不回退到明文', async () => {
  const f = fixture();
  f.ctx.secrets.set = async () => { throw new Error('secure storage unavailable'); };
  await assert.rejects(f.inbound(), /secure storage unavailable/);
  assert.equal(f.secrets.size, 0);
  assert.ok(![...f.values.keys()].some((key) => key.startsWith('context-meta:')));
});

test('旧缓存与 Session/turn 的 token 被移除，历史映射和任务保留', async () => {
  const f = fixture();
  f.values.set(`${CTOKEN_PREFIX}${peer}`, 'unsafe-legacy-context');
  f.values.set(`${SESSION_MAP_PREFIX}s1`, { peerId: peer, contextToken: 'unsafe-legacy-context', other: 1 });
  f.values.set(`${TURN_MAP_PREFIX}t1`, { peerId: peer, contextToken: 'unsafe-legacy-context' });
  f.values.set('task:t1', { status: 'completed' });
  await f.contexts.discardLegacy();
  assert.equal(f.values.has(`${CTOKEN_PREFIX}${peer}`), false);
  assert.deepEqual(f.values.get(`${SESSION_MAP_PREFIX}s1`), { peerId: peer, other: 1 });
  assert.deepEqual(f.values.get(`${TURN_MAP_PREFIX}t1`), { peerId: peer });
  assert.deepEqual(f.values.get('task:t1'), { status: 'completed' });
  await assert.rejects(f.media.sendText(peer, 'hello'), /no message context/);
});

test('清理上下文不会清空登录凭证或其他业务存储', async () => {
  const f = fixture();
  await f.inbound();
  f.values.set('task:t1', { status: 'completed' });
  await f.contexts.clear();
  assert.equal(f.secrets.size, 0);
  assert.equal(f.values.get(KEY_TOKEN), account.botToken);
  assert.deepEqual(f.values.get('task:t1'), { status: 'completed' });
  await assert.rejects(f.media.sendText(peer, 'hello'), /no message context/);
});

test('退出登录清理上下文，保留收件箱历史', async () => {
  const f = fixture();
  await f.inbound();
  f.values.set(`${SESSION_MAP_PREFIX}s1`, { peerId: peer });
  const auth = new AuthManager(f.ctx, f.ilink, f.contexts, createBotState(), () => {}, () => {});
  await auth.logout();
  assert.equal(f.values.has(KEY_TOKEN), false);
  assert.equal(f.secrets.size, 0);
  assert.deepEqual(f.values.get(`${SESSION_MAP_PREFIX}s1`), { peerId: peer });
});

test('扫码重新登录成功前清理旧上下文', async () => {
  const f = fixture();
  await f.inbound();
  const state = createBotState();
  state.loginAttempt = 1;
  let started = false;
  const qrClient = {
    async get(): Promise<StatusResponse> {
      return { status: 'confirmed', bot_token: 'new-auth-secret', ilink_bot_id: account.botId, ilink_user_id: peer };
    },
  } as unknown as IlinkClient;
  const auth = new AuthManager(f.ctx, qrClient, f.contexts, state, () => {}, () => { started = true; });
  // 只验证登录状态迁移，不触发二维码弹窗或真实网络。
  await (auth as unknown as {
    runLoginPolling(qr: { qrcode: string; qrcode_img_content: string }, attempt: number): Promise<void>;
  }).runLoginPolling({ qrcode: 'test', qrcode_img_content: 'test' }, 1);
  assert.equal(started, true);
  assert.equal(f.secrets.size, 0);
  assert.equal(f.values.get(KEY_TOKEN), 'new-auth-secret');
  await assert.rejects(f.media.sendText(peer, 'hello'), /no message context/);
});
