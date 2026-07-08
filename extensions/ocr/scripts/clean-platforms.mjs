#!/usr/bin/env node
/**
 * postinstall script: remove unused platform binaries from onnxruntime-node
 * to reduce extension size from ~258MB to ~80MB.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const platform = process.platform;  // 'darwin', 'linux', 'win32'
const arch = process.arch;          // 'arm64', 'x64'

const binDir = join('node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
if (!existsSync(binDir)) {
  console.log('[clean-platforms] onnxruntime-node not found, skipping');
  process.exit(0);
}

const keep = `${platform}/${arch}`;
console.log(`[clean-platforms] keeping: ${keep}`);

for (const dir of ['darwin', 'linux', 'win32']) {
  if (dir === platform) {
    // Keep current platform, remove other architectures
    for (const a of ['arm64', 'x64', 'armhf', 'aarch64']) {
      if (a !== arch) {
        const target = join(binDir, dir, a);
        if (existsSync(target)) {
          rmSync(target, { recursive: true, force: true });
          console.log(`[clean-platforms] removed: ${dir}/${a}`);
        }
      }
    }
  } else {
    // Remove entire platform directory
    const target = join(binDir, dir);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      console.log(`[clean-platforms] removed: ${dir}/`);
    }
  }
}

console.log('[clean-platforms] done');
