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
    // Each worker holds ~0.5 GB of module graph. The default (CPUs - 1 = 19 on
    // the 16 GB dev laptop) exhausted memory, froze the machine and pushed
    // cold-import tests past their timeouts; 4 runs the full suite cleanly.
    maxWorkers: 4,
  },
});
