import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': resolve('.') } },
  test: { include: ['docs/investigations/pro-generation-2026-09-13/repro.test.mjs'] },
});
