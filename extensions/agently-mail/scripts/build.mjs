import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Copy Lucide SVG icons
const iconNames = ['mail', 'link', 'circle-check', 'send', 'inbox', 'search'];
const iconsDir = resolve(extensionRoot, 'icons');
await mkdir(iconsDir, { recursive: true });
const { copyFile } = await import('node:fs/promises');
await Promise.all(iconNames.map((name) => copyFile(
  resolve(extensionRoot, 'node_modules/lucide-static/icons', `${name}.svg`),
  resolve(iconsDir, `${name}.svg`),
)));

// Compile extension + MCP adapter in one tsc pass (src/ → dist/)
const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], {
  cwd: extensionRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
