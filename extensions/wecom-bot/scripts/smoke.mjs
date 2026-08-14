// WeCom Box 冒烟测试（无测试框架依赖，node 直接运行）
// 覆盖：企微加解密往返（WecomCrypto）、媒体文件解密、媒体类型推断、@机器人剥离。
// 说明：WecomBridge 依赖 Finch 运行时（ctx），无法脱离桌面端单测；这里只测纯函数与 SDK 原语。
//
// 运行：node scripts/smoke.mjs

import assert from 'node:assert/strict';
import { WecomCrypto, decryptFile } from '@wecom/aibot-node-sdk';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

console.log('1) 企微回调加解密（WecomCrypto）');
{
  const encodingAESKey = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab'.slice(0, 43);
  const token = 'finchTestToken';
  const receiveId = ''; // 智能机器人场景 receiveid 传空字符串
  const crypto = new WecomCrypto(token, encodingAESKey, receiveId);

  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = 'testnonce123';
  const { encrypt, signature } = crypto.encrypt('{"msgtype":"text","text":{"content":"hello"}}', ts, nonce);
  assert.equal(crypto.verifySignature(signature, ts, nonce, encrypt), true, 'signature should verify');
  ok('encrypt → verifySignature 往返');

  const plain = crypto.decrypt(encrypt);
  assert.equal(plain, '{"msgtype":"text","text":{"content":"hello"}}');
  ok('decrypt 还原明文');

  assert.equal(crypto.verifySignature(signature, ts, nonce, encrypt + 'x'), false, 'tampered encrypt must fail');
  assert.equal(crypto.verifySignature(signature, ts, 'othernonce', encrypt), false, 'wrong nonce must fail');
  ok('篡改/错误参数签名校验拒绝');

  const echostrPlain = 'random16bytes_';
  const echostr = crypto.encrypt(echostrPlain.padEnd(32, 'x'), ts, nonce);
  assert.ok(crypto.decrypt(echostr.encrypt).startsWith('random16bytes_'));
  ok('echostr 解密（URL 验证）');
}

console.log('2) 媒体文件解密（AES-256-CBC，模拟 downloadFile 底层）');
{
  const key = '0123456789abcdef0123456789abcdef'; // 32 字节
  const aesKeyB64 = Buffer.from(key, 'utf8').toString('base64');
  const { createCipheriv } = await import('node:crypto');
  const iv = Buffer.from(key, 'utf8').slice(0, 16);
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), iv);
  const encrypted = Buffer.concat([cipher.update('file-content-bytes'), cipher.final()]);
  const decrypted = decryptFile(encrypted, aesKeyB64);
  assert.equal(decrypted.toString('utf8'), 'file-content-bytes');
  ok('decryptFile AES-256-CBC 解密');
}

console.log('3) 纯函数：媒体类型推断 / @机器人剥离（与 src/utils 保持一致）');
{
  const mediaTypeForInline = (fileName) => {
    const ext = fileName.toLowerCase().split('.').pop() ?? '';
    if (['jpg', 'jpeg', 'png', 'gif'].includes(ext)) return 'image';
    if (ext === 'mp4') return 'video';
    if (ext === 'amr') return 'voice';
    return 'file';
  };
  assert.equal(mediaTypeForInline('photo.png'), 'image');
  assert.equal(mediaTypeForInline('demo.mp4'), 'video');
  assert.equal(mediaTypeForInline('note.amr'), 'voice');
  assert.equal(mediaTypeForInline('report.pdf'), 'file');
  ok('媒体类型推断 image/video/voice/file');

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripBotMentionInline = (text, botName) => {
    const value = text.trim();
    if (!value.startsWith('@')) return value;
    const name = botName?.trim();
    if (name) {
      const match = value.match(new RegExp(`^@${escapeRegExp(name)}`));
      if (match) {
        const rest = value.slice(match[0].length).trim();
        return rest || value;
      }
    }
    const generic = value.match(/^@([^\s@，,。:：]{1,32})(?=[\s，,。:：]|$)/);
    if (!generic) return value;
    return value.slice(generic[0].length).trim() || value;
  };
  assert.equal(stripBotMentionInline('@Finch 帮我整理周报', 'Finch'), '帮我整理周报');
  assert.equal(stripBotMentionInline('@Finch帮我整理周报', 'Finch'), '帮我整理周报'); // 无空格 + botName 精确剥离
  assert.equal(stripBotMentionInline('@Finch', 'Finch'), '@Finch'); // 纯 @ 消息保留原文
  assert.equal(stripBotMentionInline('@Finch 帮我整理周报'), '帮我整理周报'); // 无 botName 通用剥离
  assert.equal(stripBotMentionInline('你好 @Finch 在吗', 'Finch'), '你好 @Finch 在吗'); // 非开头不剥离
  ok('群聊 @机器人 前缀剥离');
}

console.log(`\n✅ smoke 测试全部通过（${passed} 项）`);
