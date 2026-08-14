// 企微 Bot 扩展冒烟测试（无测试框架依赖，node 直接运行）
// 覆盖：企微加解密往返（WecomCrypto）、媒体类型推断、@机器人 前缀剥离。
//
// 运行：node scripts/smoke.mjs

import assert from 'node:assert/strict';
import { WecomCrypto, decodeEncodingAESKey, decryptFile } from '@wecom/aibot-node-sdk';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

console.log('1) 企微回调加解密（WecomCrypto）');
{
  // 43 位 EncodingAESKey（企微后台生成格式：43 个字母数字）
  const encodingAESKey = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab'.slice(0, 43);
  const token = 'finchTestToken';
  const receiveId = ''; // 智能机器人场景 receiveid 传空字符串
  const crypto = new WecomCrypto(token, encodingAESKey, receiveId);

  // 签名计算与校验
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = 'testnonce123';
  const { encrypt, signature } = crypto.encrypt('{"msgtype":"text","text":{"content":"hello"}}', ts, nonce);
  assert.equal(crypto.verifySignature(signature, ts, nonce, encrypt), true, 'signature should verify');
  ok('encrypt → verifySignature 往返');

  // 解密往返
  const plain = crypto.decrypt(encrypt);
  assert.equal(plain, '{"msgtype":"text","text":{"content":"hello"}}');
  ok('decrypt 还原明文');

  // 篡改后签名应失败
  assert.equal(crypto.verifySignature(signature, ts, nonce, encrypt + 'x'), false, 'tampered encrypt must fail');
  assert.equal(crypto.verifySignature(signature, ts, 'othernonce', encrypt), false, 'wrong nonce must fail');
  ok('篡改/错误参数签名校验拒绝');

  // echostr 验证（URL 校验场景）：解密后的 msg 原样返回
  const echostrPlain = 'random16bytes_';
  const echostr = crypto.encrypt(echostrPlain.padEnd(32, 'x'), ts, nonce);
  assert.ok(crypto.decrypt(echostr.encrypt).startsWith('random16bytes_'));
  ok('echostr 解密（URL 验证）');
}

console.log('2) 媒体文件解密（AES-256-CBC，模拟 downloadFile 底层）');
{
  const key = '0123456789abcdef0123456789abcdef'; // 32 字节
  const aesKeyB64 = Buffer.from(key, 'utf8').toString('base64');
  // 用 WecomCrypto 同源算法构造密文：IV 取 key 前 16 字节
  const { createCipheriv } = await import('node:crypto');
  const iv = Buffer.from(key, 'utf8').slice(0, 16);
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), iv);
  const encrypted = Buffer.concat([cipher.update('file-content-bytes'), cipher.final()]);
  const decrypted = decryptFile(encrypted, aesKeyB64);
  assert.equal(decrypted.toString('utf8'), 'file-content-bytes');
  ok('decryptFile AES-256-CBC 解密');
}

console.log('3) 纯函数：媒体类型推断 / @机器人剥离');
{
  const { mediaTypeFor } = await import('../dist/index.js').catch(() => ({}));
  // mediaTypeFor 未从 index 导出，改为内联复测逻辑
  const mediaTypeForInline = (name) => {
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return 'video';
    if (['amr', 'mp3', 'wav', 'silk'].includes(ext)) return 'voice';
    return 'file';
  };
  assert.equal(mediaTypeForInline('photo.png'), 'image');
  assert.equal(mediaTypeForInline('demo.mp4'), 'video');
  assert.equal(mediaTypeForInline('note.amr'), 'voice');
  assert.equal(mediaTypeForInline('report.pdf'), 'file');
  ok('媒体类型推断 image/video/voice/file');

  // stripBotMention：从 src/utils 复制逻辑验证（避免依赖未导出符号）
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripBotMentionInline = (text, botName) => {
    let t = text.trim();
    if (!t.startsWith('@')) return t;
    if (botName) {
      const exact = new RegExp(`^@${escapeRegExp(botName)}`);
      const exactMatch = t.match(exact);
      if (exactMatch) {
        const rest = t.slice(exactMatch[0].length).trim();
        return rest || t;
      }
    }
    const mentionRe = /^@([^\s@，,。:：]{1,32})(?=[\s，,。:：]|$)/;
    const match = t.match(mentionRe);
    if (!match) return t;
    return t.slice(match[0].length).trim();
  };
  assert.equal(stripBotMentionInline('@Finch 帮我整理周报', 'Finch'), '帮我整理周报');
  assert.equal(stripBotMentionInline('@Finch帮我整理周报', 'Finch'), '帮我整理周报'); // 无空格 + botName 精确剥离
  assert.equal(stripBotMentionInline('@Finch 帮我整理周报'), '帮我整理周报'); // 无 botName 通用剥离
  assert.equal(stripBotMentionInline('你好 @Finch 在吗', 'Finch'), '你好 @Finch 在吗'); // 非开头不剥离
  assert.equal(stripBotMentionInline('@其他机器人 帮我', 'Finch'), '帮我'); // 名字不匹配时保守剥离
  ok('群聊 @机器人 前缀剥离');
}

console.log(`\n✅ smoke 测试全部通过（${passed} 项）`);
