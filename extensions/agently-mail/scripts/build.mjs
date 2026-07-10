import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(extensionRoot, '../..');
const adapterRoot = resolve(repoRoot, 'packages/agently-mail-mcp');

const buildAdapter = spawnSync('npm', ['run', 'build', '--workspace=@finchtoys/agently-mail-mcp'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (buildAdapter.status !== 0) process.exit(buildAdapter.status ?? 1);

const output = resolve(extensionRoot, 'dist/mcp-server.js');
await mkdir(dirname(output), { recursive: true });
await copyFile(resolve(adapterRoot, 'dist/index.js'), output);

const iconNames = ['mail', 'link', 'circle-check', 'send', 'inbox', 'search'];
const iconsDir = resolve(extensionRoot, 'icons');
await mkdir(iconsDir, { recursive: true });
await Promise.all(iconNames.map((name) => copyFile(
  resolve(extensionRoot, 'node_modules/lucide-static/icons', `${name}.svg`),
  resolve(iconsDir, `${name}.svg`),
)));

const buildExtension = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], {
  cwd: extensionRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(buildExtension.status ?? 1);
