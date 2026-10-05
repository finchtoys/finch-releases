import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

// 临时构建测试，不将测试代码打进发布包；不访问微信或用户凭证。
const directory = await mkdtemp(join(tmpdir(), 'finch-wechat-tests-'));
try {
  const outfile = join(directory, 'send.test.mjs');
  await build({
    entryPoints: ['tests/send.test.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    outfile,
  });
  const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
