import assert from 'node:assert/strict';
import test from 'node:test';
import type * as finch from 'finch';
import en from '../i18n/en-US.json';
import zh from '../i18n/zh-CN.json';
import { ContextStore } from '../src/context';
import { IlinkClient, type IlinkAccount } from '../src/ilink-client';
import { MediaManager } from '../src/media';
import { AuthManager } from '../src/auth';
import { splitText, TEXT_CHUNK_UTF8_BYTES } from '../src/text-chunks';
import { executeWechatSend } from '../src/send-tool';
import { OBSERVATIONS_KEY, OBSERVATION_RETENTION_MS } from '../src/send-observations';
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

test('prepare failed 不武断归因于过期，保留错误码且不重试', async () => {
  const f = fixture();
  await f.inbound();
  f.respond({ ret: -2, errcode: 123, errmsg: 'prepare failed' });
  await assert.rejects(f.media.sendText(peer, 'private-text'), /cause is not confirmed.*ret=-2 errcode=123 prepare failed/);
  assert.equal(f.calls.length, 1);
  const logs = JSON.stringify(f.logs);
  assert.match(logs, /contextReceivedAt/);
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
  // A non-secret pending marker keeps incomplete writes enumerable for logout cleanup.
  const metadata = [...f.values.entries()].filter(([key]) => key.startsWith('context-meta:'));
  assert.equal(metadata.length, 1);
  assert.equal((metadata[0][1] as { pending: boolean }).pending, true);
  assert.doesNotMatch(JSON.stringify(metadata), /test-context-secret/);
  assert.equal(await f.contexts.get(peer, account), undefined);
  await assert.rejects(f.media.sendText(peer, 'hello'), /no message context/);
  assert.equal(f.calls.length, 0);
  await f.contexts.clear();
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

// 0.5.23 observation release: no live API calls or real credentials.
function sentTexts(f: ReturnType<typeof fixture>): string[] {
  return f.calls.map((call) => (call.body as { msg: { item_list: { text_item?: { text: string } }[] } }).msg.item_list[0].text_item?.text ?? '');
}

for (const [label, text] of [
  ['ASCII', 'x'.repeat(12_005)],
  ['中文', '微信观察版'.repeat(1500)],
  ['emoji', '👨‍👩‍👧‍👦🙂'.repeat(600)],
  ['空白与边界', 'x'.repeat(3999) + '🙂\n\n 中文\t' + 'a'.repeat(4001)],
] as const) {
  test(`${label} 无损分段，单段不超过保守 UTF-8 上限`, () => {
    const chunks = splitText(text);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length > 0);
      assert.ok(Buffer.byteLength(chunk) <= TEXT_CHUNK_UTF8_BYTES);
      assert.ok([...chunk].length <= 4000);
      assert.doesNotMatch(chunk, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
  });
}

test('短文本不改变，空文本不制造成功', async () => {
  assert.deepEqual(splitText('  hello\n中文 🙂\t'), ['  hello\n中文 🙂\t']);
  assert.deepEqual(splitText(''), []);
  const f = fixture();
  await f.inbound();
  await assert.rejects(f.media.sendText(peer, ''), /no text/);
  assert.equal(f.calls.length, 0);
});

test('长文本按序投递，诊断记录逐段大小、序号与上下文版本', async () => {
  const f = fixture();
  await f.inbound();
  const text = '🙂汉'.repeat(1800);
  await f.media.sendText(peer, text);
  assert.deepEqual(sentTexts(f), splitText(text));
  const rows = await f.media.observations.list();
  assert.equal(rows.length, f.calls.length);
  rows.forEach((row, i) => {
    assert.equal(row.outcome, 'accepted');
    assert.equal(row.part, i + 1);
    assert.equal(row.parts, rows.length);
    assert.equal(row.textUtf8Bytes, Buffer.byteLength(sentTexts(f)[i]));
    assert.equal(row.textCharacters, [...sentTexts(f)[i]].length);
    assert.equal(row.contextRevision, rows[0].contextRevision);
    assert.equal(row.recentSendCount, i + 1);
  });
  assert.match(rows[0].contextRevision!, /^[0-9a-f-]{36}$/);
});

test('同一收件人的并发逻辑消息不会分段交错', async () => {
  const f = fixture();
  await f.inbound();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.onPost(async () => { if (f.calls.length === 1) await gate; return { ret: 0 }; });
  const first = f.media.sendText(peer, 'a'.repeat(8001));
  const second = f.media.sendText(peer, 'b'.repeat(5000));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(sentTexts(f), [...splitText('a'.repeat(8001)), ...splitText('b'.repeat(5000))]);
});

test('不同收件人不互相阻塞', async () => {
  const f = fixture();
  await f.inbound();
  await f.contexts.capture('other-peer', 'other-context', account);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.onPost(async () => { if (f.calls.length === 1) await gate; return { ret: 0 }; });
  const first = f.media.sendText(peer, 'first');
  await new Promise<void>((resolve) => setImmediate(resolve));
  await f.media.sendText('other-peer', 'second');
  assert.equal(f.calls.length, 2);
  release();
  await first;
});

test('分段中途业务失败立即停止且提示部分受理，队列不被失败污染', async () => {
  const f = fixture();
  await f.inbound();
  f.onPost(async () => f.calls.length === 2 ? { ret: -2, errmsg: 'prepare failed' } : { ret: 0 });
  await assert.rejects(f.media.sendText(peer, 'a'.repeat(12_000)), /Some text parts.*1\/3.*diagnostic=/);
  assert.equal(f.calls.length, 2);
  await f.media.sendText(peer, 'new logical request');
  assert.equal(f.calls.length, 3);
  assert.equal((await f.media.observations.list())[1].outcome, 'business_rejected');
  assert.equal((await f.media.observations.list())[1].reason, 'prepare_failed');
  assert.equal(lastToken(f), 'test-context-secret');
});

test('长 caption 也分段且位于媒体之前，不与并发文字交错', async () => {
  const f = fixture();
  await f.inbound();
  fakeUpload(f);
  await Promise.all([
    f.media.sendImage(peer, Buffer.from('x'), 'c'.repeat(8001)),
    f.media.sendText(peer, 'next-message'),
  ]);
  const types = f.calls.map((c) => (c.body as { msg: { item_list: { type: number }[] } }).msg.item_list[0].type);
  assert.deepEqual(types, [1, 1, 1, 2, 1]);
  assert.deepEqual(sentTexts(f).slice(0, 3), splitText('c'.repeat(8001)));
});

test('长 caption 中途失败后不发送余下文字或媒体', async () => {
  const f = fixture();
  await f.inbound();
  fakeUpload(f);
  f.onPost(async () => f.calls.length === 1 ? { ret: 0 } : { ret: -2, errmsg: 'prepare failed' });
  await assert.rejects(f.media.sendImage(peer, Buffer.from('x'), 'c'.repeat(8001)), /Some text parts/);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => (c.body as { msg: { item_list: { type: number }[] } }).msg.item_list[0].type === 1));
});

test('未知响应不假报成功，也不自动重试', async () => {
  for (const response of [null, [], undefined, false, 0, 'ok', { ret: '0' }, { errcode: '0' }, { ret: null }, { ret: NaN }, { errcode: Infinity }]) {
    const f = fixture();
    await f.inbound();
    f.onPost(async () => response);
    await assert.rejects(f.media.sendText(peer, 'hello'), /unconfirmed send response/);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.media.observations.list())[0].outcome, 'response_unknown');
  }
});

test('超时记录未知投递状态，停止剩余分段且不删上下文', async () => {
  const f = fixture();
  await f.inbound();
  f.onPost(async () => { throw new Error('network timeout'); });
  await assert.rejects(f.media.sendText(peer, 'x'.repeat(8000)), /network timeout/);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.media.observations.list())[0].outcome, 'transport_unknown');
  assert.equal((await f.contexts.get(peer, account))!.token, 'test-context-secret');
});

test('取消后不启动发送，分段中途取消也不继续', async () => {
  const f = fixture();
  await f.inbound();
  const before = new AbortController();
  before.abort();
  await assert.rejects(f.media.sendText(peer, 'hello', before.signal), /cancelled/);
  assert.equal(f.calls.length, 0);
  const during = new AbortController();
  f.onPost(async () => { during.abort(); return { ret: 0 }; });
  await assert.rejects(f.media.sendText(peer, 'x'.repeat(8000), during.signal), /Some text parts.*cancelled/);
  assert.equal(f.calls.length, 1);
});

test('诊断不保存服务端正文回显、token、收件人或任意额外字段', async () => {
  const f = fixture();
  await f.inbound();
  f.respond({ ret: -1, errmsg: 'test-auth- test-context- private-message user-secret-value' });
  await assert.rejects(f.media.sendText(peer, 'private-message'), (error: Error) => {
    assert.doesNotMatch(error.message, /test-auth-|test-context-|private-message|user-secret-value/);
    return true;
  });
  const data = JSON.stringify({ logs: f.logs, rows: await f.media.observations.list() });
  assert.doesNotMatch(data, /test-auth-|test-context-|test-peer|private-message|user-secret-value|test\.invalid/);
  const rows = await f.media.observations.list();
  f.values.set(OBSERVATIONS_KEY, [{ ...rows[0], secret: 'injected-secret', contextRevision: 'injected-secret' }]);
  assert.doesNotMatch(JSON.stringify(await f.media.observations.list()), /injected-secret/);
});

test('诊断并发写入不丢记录，最多100条，七天之外不可见', async () => {
  const f = fixture();
  await f.inbound();
  await f.media.sendText(peer, 'hello');
  const sample = (await f.media.observations.list())[0];
  await Promise.all(Array.from({ length: 105 }, () => f.media.observations.record({ ...sample, id: f.media.observations.newId() })));
  assert.equal((await f.media.observations.list(999)).length, 100);
  assert.equal((await f.media.observations.list()).length, 20);
  f.values.set(OBSERVATIONS_KEY, [
    { ...sample, at: Date.now() - OBSERVATION_RETENTION_MS - 1000 }, sample,
  ]);
  assert.equal((await f.media.observations.list(100)).length, 1);
  f.values.set(OBSERVATIONS_KEY, 'corrupt');
  assert.deepEqual(await f.media.observations.list(), []);
});

test('诊断存储或日志失败不改变发送成功/业务失败且不触发重试', async () => {
  const f = fixture();
  await f.inbound();
  const original = f.ctx.storage.set.bind(f.ctx.storage);
  f.ctx.storage.set = async (key, value) => {
    if (key === OBSERVATIONS_KEY) throw new Error('private-storage-error');
    await original(key, value);
  };
  f.ctx.logger.warn = () => { throw new Error('private-logger-error'); };
  f.ctx.logger.info = () => { throw new Error('private-logger-error'); };
  await f.media.sendText(peer, 'success');
  f.respond({ ret: -2, errmsg: 'prepare failed' });
  await assert.rejects(f.media.sendText(peer, 'failure'), /cause is not confirmed/);
  assert.equal(f.calls.length, 2);
});

test('工具失败走异常链路，成功文案只确认服务端受理', async () => {
  const f = fixture();
  await assert.rejects(executeWechatSend(f.ctx, f.media, {}), /Provide message/);
  await assert.rejects(executeWechatSend(f.ctx, f.media, { message: 'hello' }), /Failed to send.*no message context/);
  await f.inbound();
  f.respond({ ret: -2, errmsg: 'prepare failed' });
  await assert.rejects(executeWechatSend(f.ctx, f.media, { message: 'hello' }), /Failed to send.*cause is not confirmed/);
  f.respond({ ret: 0 });
  const result = await executeWechatSend(f.ctx, f.media, { message: 'hello' });
  assert.notEqual(result.isError, true);
  assert.match(JSON.stringify(result), /accepted.*not a device delivery receipt/);
});

test('队列有界，超出20项不发送也不影响已排队的请求', async () => {
  const f = fixture();
  await f.inbound();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.onPost(async () => { if (f.calls.length === 1) await gate; return { ret: 0 }; });
  const pending = Array.from({ length: 20 }, (_, i) => f.media.sendText(peer, `queued-${i}`));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(f.media.sendText(peer, 'overflow'), /queue is full/);
  assert.equal(f.calls.length, 1);
  release();
  await Promise.all(pending);
  assert.equal(f.calls.length, 20);
});

test('上下文更新期间读取等待完整快照，不把新 token 配旧时间或版本', async () => {
  const f = fixture();
  await f.inbound('old-context');
  const old = (await f.contexts.get(peer, account))!;
  const original = f.ctx.storage.set.bind(f.ctx.storage);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.ctx.storage.set = async (key, value) => {
    if (key.startsWith('context-meta:') && !(value as { pending?: boolean }).pending) await gate;
    await original(key, value);
  };
  const capture = f.inbound('new-context');
  await new Promise<void>((resolve) => setImmediate(resolve));
  let readFinished = false;
  const read = f.contexts.get(peer, account).then((snapshot) => { readFinished = true; return snapshot; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(readFinished, false);
  release();
  await capture;
  const snapshot = (await read)!;
  assert.equal(snapshot.token, 'new-context');
  assert.notEqual(snapshot.revision, old.revision);
});

test('上下文写入中断后不可发送，退出清理仍能枚举并删除该记录', async () => {
  const f = fixture();
  await f.inbound('old-context');
  const original = f.ctx.storage.set.bind(f.ctx.storage);
  f.ctx.storage.set = async (key, value) => {
    if (key.startsWith('context-meta:') && !(value as { pending?: boolean }).pending) throw new Error('write failed');
    await original(key, value);
  };
  await assert.rejects(f.inbound('new-context'), /write failed/);
  assert.equal(await f.contexts.get(peer, account), undefined);
  await assert.rejects(f.media.sendText(peer, 'hello'), /no message context/);
  assert.equal(f.calls.length, 0);
  await f.contexts.clear();
  assert.equal(f.secrets.size, 0);
  assert.equal(f.values.get(KEY_TOKEN), account.botToken);
});

test('真实 HTTP 客户端将工具取消传递到 fetch，无实际网络访问', async (t) => {
  const f = fixture();
  let requestSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    requestSignal = options.signal as AbortSignal;
    await new Promise<void>((resolve) => requestSignal!.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('simulated aborted fetch');
  });
  const client = new IlinkClient(f.ctx, 'test-agent');
  const controller = new AbortController();
  const post = client.post('https://test.invalid', 'ilink/bot/sendmessage', {}, 'fake-auth', 1000, controller.signal);
  assert.equal(requestSignal?.aborted, false);
  controller.abort();
  assert.equal(requestSignal?.aborted, true);
  await assert.rejects(post, /simulated aborted fetch/);
});

// 0.5.24: official sender accepts JSON responses whose zero business codes are omitted.
test('省略零值返回码的成功响应正常受理，诊断不编造 ret 或 errcode', async () => {
  const responses: SendMessageResponse[] = [
    {}, { errcode: 0 }, { message_id: '18446744073709551615' },
    { ret: 0 }, { ret: 0, errcode: 0 }, { errcode: 0, message_id: 'opaque-server-receipt' },
  ];
  for (const response of responses) {
    const f = fixture();
    await f.inbound();
    f.respond(response);
    const result = await executeWechatSend(f.ctx, f.media, { message: 'hello' });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result), /accepted.*not a device delivery receipt/);
    assert.equal(f.calls.length, 1);
    const [row] = await f.media.observations.list();
    assert.equal(row.outcome, 'accepted');
    assert.equal(row.ret, response.ret);
    assert.equal(row.errcode, response.errcode);
    assert.doesNotMatch(JSON.stringify({ row, logs: f.logs }), /18446744073709551615|opaque-server-receipt/);
    assert.equal(lastToken(f), 'test-context-secret');
  }
});

test('只要任一业务返回码非零仍拒绝，缺省 ret 不吞 errcode 错误', async () => {
  const responses: SendMessageResponse[] = [
    { errcode: 9 }, { errcode: -14 }, { ret: -2, errmsg: 'prepare failed' },
    { ret: 0, errcode: 9 }, { ret: 1, errcode: 0 },
  ];
  for (const response of responses) {
    const f = fixture();
    await f.inbound();
    f.respond(response);
    await assert.rejects(executeWechatSend(f.ctx, f.media, { message: 'hello' }), /Failed to send WeChat message/);
    assert.equal(f.calls.length, 1);
    const [row] = await f.media.observations.list();
    assert.equal(row.outcome, 'business_rejected');
    assert.equal(row.ret, response.ret);
    assert.equal(row.errcode, response.errcode);
    assert.equal((await f.contexts.get(peer, account))!.token, 'test-context-secret');
  }
});

test('caption 与媒体的可省略零码响应共用成功判定，不误报部分失败', async () => {
  const f = fixture();
  await f.inbound();
  fakeUpload(f);
  f.respond({});
  await f.media.sendImage(peer, Buffer.from('x'), 'caption');
  assert.equal(f.calls.length, 2);
  const rows = await f.media.observations.list();
  assert.deepEqual(rows.map((row) => row.outcome), ['accepted', 'accepted']);
  assert.ok(rows.every((row) => row.ret === undefined && row.errcode === undefined));
});

test('真实 HTTP 解析链路：200 空对象成功，HTTP 错误或非法 JSON 不成功且不重试', async (t) => {
  let requests = 0;
  let response = new Response('{}', { status: 200 });
  t.mock.method(globalThis, 'fetch', async () => { requests++; return response; });
  for (const mode of ['empty-object', 'http-error', 'invalid-json'] as const) {
    requests = 0;
    response = mode === 'empty-object' ? new Response('{}', { status: 200 })
      : mode === 'http-error' ? new Response('{}', { status: 500 })
        : new Response('not-json', { status: 200 });
    const f = fixture();
    await f.inbound();
    const realClient = new IlinkClient(f.ctx, 'test-agent');
    const media = new MediaManager(f.ctx, realClient, f.contexts);
    if (mode === 'empty-object') {
      await media.sendText(peer, 'hello');
      const [row] = await media.observations.list();
      assert.equal(row.outcome, 'accepted');
      assert.equal(row.ret, undefined);
    } else {
      await assert.rejects(media.sendText(peer, 'hello'));
      assert.notEqual((await media.observations.list())[0].outcome, 'accepted');
    }
    assert.equal(requests, 1);
  }
});
