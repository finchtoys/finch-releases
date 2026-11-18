import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

// 临时构建测试，不将测试代码打进发布包；不访问微信或用户凭证。
const entries = ['inbound', 'send'];
const directory = await mkdtemp(join(tmpdir(), 'finch-wechat-tests-'));
try {
  const outputs = [];
  for (const entry of entries) {
    const outfile = join(directory, `${entry}.test.mjs`);
    await build({
      entryPoints: [`tests/${entry}.test.ts`],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      outfile,
    });
    outputs.push(outfile);
  }
  const result = spawnSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
