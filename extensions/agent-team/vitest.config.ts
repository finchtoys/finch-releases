import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: { reporter: ['text', 'json-summary'] },
  },
});
