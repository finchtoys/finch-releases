import { build } from 'esbuild';

await build({
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  external: ['finch', 'onnxruntime-node', 'sharp', 'node:fs', 'node:path', 'node:child_process'],
});
