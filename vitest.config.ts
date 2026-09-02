import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/performance/zhiyu-workspace-profiler-baseline.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
  },
});
