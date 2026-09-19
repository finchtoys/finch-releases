import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/app',
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src/app', import.meta.url)) },
  },
  build: {
    outDir: '../../dist/appview',
    emptyOutDir: false,
    sourcemap: false,
  },
});
