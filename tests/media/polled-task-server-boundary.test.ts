import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const STATIC_BOUNDARY_RULE = 'no-restricted-imports';
const DYNAMIC_BOUNDARY_RULE = 'no-restricted-syntax';
const PROBE_FILE_PATH = 'components/polled-task-boundary-probe.tsx';
const eslint = new ESLint({ cwd: process.cwd() });
const warmupConfig = await eslint.calculateConfigForFile(PROBE_FILE_PATH);
if (!warmupConfig) throw new Error(`ESLint warm-up path is not configured: ${PROBE_FILE_PATH}`);
const [warmupResult] = await eslint.lintText('export const lintBoundaryWarmup = true;\n', {
  filePath: PROBE_FILE_PATH,
  warnIgnored: false,
});
const warmupErrors = (warmupResult?.messages ?? []).filter((message) => message.severity === 2);
if (!warmupResult || warmupErrors.length > 0) {
  throw new Error(`ESLint warm-up failed: ${JSON.stringify(warmupErrors)}`);
}

async function boundaryErrors(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: PROBE_FILE_PATH,
    warnIgnored: false,
  });
  return (result?.messages ?? [])
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId ?? 'unknown');
}

describe('polled task server carrier boundary', () => {
  it('allows client code to use the browser-safe persistence accessor', async () => {
    expect(
      await boundaryErrors(`
        import { readPolledTaskPersistence } from '@/lib/media/polled-task-context';
        export const currentTask = readPolledTaskPersistence();
      `),
    ).toEqual([]);
  });

  it.each([
    [
      'path alias',
      "import { withPolledTaskPersistence } from '@/lib/server/generation-jobs/polled-task-persistence'; export { withPolledTaskPersistence };",
    ],
    [
      'relative path',
      "import { withPolledTaskPersistence } from '../lib/server/generation-jobs/polled-task-persistence'; export { withPolledTaskPersistence };",
    ],
  ])('rejects a client import through a %s', async (_label, code) => {
    expect(await boundaryErrors(code)).toContain(STATIC_BOUNDARY_RULE);
  });

  it.each([
    [
      'dynamic path alias',
      "export async function load() { return import('@/lib/server/generation-jobs/polled-task-persistence'); }",
    ],
    [
      'dynamic relative path',
      "export async function load() { return import('../lib/server/generation-jobs/polled-task-persistence'); }",
    ],
    [
      'require path alias',
      "export const carrier = require('@/lib/server/generation-jobs/polled-task-persistence');",
    ],
  ])('rejects a client import through a %s', async (_label, code) => {
    expect(await boundaryErrors(code)).toContain(DYNAMIC_BOUNDARY_RULE);
  });
});
