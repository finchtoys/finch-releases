import { build } from 'esbuild';

// Shared config
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
};

// MCP server — bundle everything except native deps and Node.js builtins
await build({
  ...shared,
  entryPoints: ['src/mcp-server.ts'],
  outfile: 'dist/mcp-server.js',
  external: ['onnxruntime-node', 'sharp'],
  banner: {
    js: '// Bundled with esbuild — @modelcontextprotocol/sdk and zod are inlined.\n// onnxruntime-node and sharp must be installed in node_modules at runtime.\n',
  },
});

// Extension entry — bundle everything except finch (provided by runtime)
await build({
  ...shared,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  external: ['finch'],
  banner: {
    js: '// Bundled with esbuild — finch types provided by the Finch runtime.\n',
  },
});

console.log('Build complete.');
