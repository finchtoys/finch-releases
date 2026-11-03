#!/usr/bin/env node
/**
 * 把本扩展打包成 Finch 本地安装包（.fapp）。
 *
 * .fapp 是一个 ZIP，内容与 `npm publish` 完全一致（以 package.json#files 为准），
 * Finch 侧用严格 ZIP 解析器读取：不允许 ZIP64 / 0x7075 扩展字段、不允许符号链接、
 * 路径必须安全、package.json 必须在根目录。因此这里打包后立刻按同一套规则自校验，
 * 校验不过直接失败，避免产出装不上的包。
 *
 * 用法：node scripts/pack-fapp.mjs  （或 npm run pack:fapp）
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, `${pkg.name}-${pkg.version}.fapp`);

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });

// 与 Finch 侧 FMP_LIMITS 保持一致。
const LIMITS = { archiveBytes: 128 * 1024 * 1024, entryBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, entries: 10_000 };

/** 严格按 Finch 的解析规则校验：任何一项不符都抛出。 */
function validate(buffer) {
  const fail = (message) => { throw new Error(`.fapp 校验失败：${message}`); };
  if (buffer.length > LIMITS.archiveBytes) fail('压缩包超过 128MB');

  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) fail('找不到 EOCD');
  const disk = buffer.readUInt16LE(end + 4);
  const cdDisk = buffer.readUInt16LE(end + 6);
  const countThis = buffer.readUInt16LE(end + 8);
  const count = buffer.readUInt16LE(end + 10);
  const cdSize = buffer.readUInt32LE(end + 12);
  const cdOffset = buffer.readUInt32LE(end + 16);
  if (disk || cdDisk || countThis !== count || count === 0xffff || cdOffset + cdSize !== end || !count) fail('EOCD 字段非法');
  if (count > LIMITS.entries) fail('条目数超限');

  const seen = new Map();
  const files = [];
  let cursor = cdOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) fail('中央目录签名错误');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameSize = buffer.readUInt16LE(cursor + 28);
    const extraSize = buffer.readUInt16LE(cursor + 30);
    const commentSize = buffer.readUInt16LE(cursor + 32);
    const external = buffer.readUInt32LE(cursor + 38);
    const local = buffer.readUInt32LE(cursor + 42);
    if (flags & ~0x080e || flags & 1) fail(`标志位非法 0x${flags.toString(16)}`);
    if (method !== 0 && method !== 8) fail(`压缩方法非法 ${method}`);
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameSize);
    if (!(flags & 0x0800) && nameBytes.some((byte) => byte >= 128)) fail('非 ASCII 文件名缺少 UTF-8 标志');
    const name = nameBytes.toString('utf8');

    for (let extra = cursor + 46 + nameSize, stop = extra + extraSize; extra < stop;) {
      const id = buffer.readUInt16LE(extra);
      if (id === 0x0001 || id === 0x7075) fail(`不允许的扩展字段 0x${id.toString(16)}`);
      extra += 4 + buffer.readUInt16LE(extra + 2);
    }

    if (!name || name.length > 1024 || /[\\\x00-\x1f\x7f:*?"<>|]/.test(name)) fail(`路径非法 ${name}`);
    const isDir = name.endsWith('/');
    const parts = (isDir ? name.slice(0, -1) : name).split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) fail(`路径非法 ${name}`);
    if (['.enabled', '.finch-id', '.bundled', '.git'].includes(parts[0].toLowerCase())) fail(`包含运行时标记 ${name}`);

    const mode = (external >>> 16) & 0xf000;
    if (mode && mode !== 0x8000 && mode !== 0x4000) fail(`文件类型不允许（符号链接？）${name}`);
    if ((mode === 0x4000 && !isDir) || (mode === 0x8000 && isDir)) fail(`类型与目录标志不一致 ${name}`);
    if (isDir && size) fail(`目录条目带数据 ${name}`);
    if (size > LIMITS.entryBytes || (total += size) > LIMITS.totalBytes) fail('解压体积超限');

    const key = name.normalize('NFC').toLowerCase();
    if (seen.has(key)) fail(`路径重复 ${name}`);
    seen.set(key, true);

    if (local + 30 > cdOffset || buffer.readUInt32LE(local) !== 0x04034b50) fail(`本地文件头错误 ${name}`);
    if (buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method) fail(`本地头与中央目录不一致 ${name}`);
    const localNameSize = buffer.readUInt16LE(local + 26);
    if (!buffer.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes)) fail(`文件名不一致 ${name}`);

    if (!isDir) files.push(name);
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== end) fail('中央目录长度不一致');
  for (const required of ['package.json', 'finch.json']) {
    if (!files.includes(required)) fail(`缺少 ${required}（需位于压缩包根目录）`);
  }
  return files;
}

const stage = mkdtempSync(join(tmpdir(), 'wechat-bot-fapp-'));
try {
  // 用 npm pack 得到与发布完全一致的文件集合，再从 tarball 展开到暂存目录。
  const tarball = run('npm', ['pack', '--silent'], root).toString().trim().split('\n').pop();
  try {
    run('tar', ['-xzf', join(root, tarball), '-C', stage], root);
    for (const entry of readdirSync(join(stage, 'package'))) {
      renameSync(join(stage, 'package', entry), join(stage, entry));
    }
    rmSync(join(stage, 'package'), { recursive: true, force: true });

    rmSync(out, { force: true });
    const entries = readdirSync(stage);
    if (!statSync(join(stage, 'package.json')).isFile()) throw new Error('暂存目录缺少 package.json');
    run('zip', ['-r', '-X', '-9', out, ...entries], stage);

    const files = validate(readFileSync(out));
    const { size } = statSync(out);
    console.log(`✓ ${out}`);
    console.log(`  ${pkg.name}@${pkg.version} · ${files.length} 个文件 · ${(size / 1024).toFixed(1)} KB`);
    console.log(`  入口：${JSON.parse(readFileSync(join(stage, 'finch.json'), 'utf8')).main}`);
  } finally {
    rmSync(join(root, tarball), { force: true });
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
