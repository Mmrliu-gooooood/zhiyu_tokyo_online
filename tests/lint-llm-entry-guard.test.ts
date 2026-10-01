import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

/**
 * Executable contract for the single model boundary lint guard (#1003, plan 3.2).
 *
 * The guard is the thing that keeps text-model runtimes (`generateText` /
 * `streamText`, `@ai-sdk/*` providers, the pi-ai runtime) reachable only through
 * the model gateway (`@/lib/model-gateway`). Its weak spot is not the
 * rules — it is their SCOPE, and review found three separate holes in it: two
 * `@openmaic` package directories excluded from the dynamic-import ban, and both
 * blocks matching only `ts,tsx` so a `route.js` or a `scripts/*.mjs` could import
 * the SDK freely.
 *
 * Each hole was closed and then verified by hand, which is exactly the process
 * that produced the next hole. So the matrix lives here instead: every import
 * form — including `require('ai')`, which an inherited repo-wide rule happens to
 * cover — × every source extension × the production paths that must be covered
 * and the paths that are deliberately exempt. A future edit that narrows `files`,
 * adds an `ignores` entry, or swaps the rule key fails this test rather than
 * quietly reopening the door.
 *
 * Runs the real eslint against the real `eslint.config.mjs` on in-memory text, so
 * there is no fixture drift and nothing is written to the tree.
 */

const BYPASS_FORMS = {
  named: "import { streamText } from 'ai';\nexport const a = streamText;\n",
  namespace: "import * as ai from 'ai';\nexport const a = ai.generateText;\n",
  dynamic: "export async function a() {\n  return import('ai');\n}\n",
  dynamicTemplate: 'export async function a() {\n  return import(`ai`);\n}\n',
  // Blocked by the inherited repo-wide `@typescript-eslint/no-require-imports`
  // rather than by the guard's own rules. Pinned here anyway: if that rule is ever
  // relaxed (allowing require in .cjs, say), this row goes red and whoever relaxes
  // it has to add an explicit `'ai'` selector instead of silently reopening the door.
  require: "const ai = require('ai');\nmodule.exports = ai;\n",
  aiSdkProvider: "import { createOpenAI } from '@ai-sdk/openai';\nexport const a = createOpenAI;\n",
  piRuntime:
    "import { streamSimple } from '@earendil-works/pi-ai';\nexport const a = streamSimple;\n",
  piProviderSubpath:
    "import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';\nexport const a = deepseekProvider;\n",
  piDynamic: "export async function a() {\n  return import('@earendil-works/pi-ai');\n}\n",
  piDynamicTemplate:
    'export async function a() {\n  return import(`@earendil-works/pi-ai/providers/deepseek`);\n}\n',
} as const;

/** The guard's own rules. Guarded paths assert the PROPERTY (the import is
 *  rejected, by whichever rule); exempt paths assert specifically that these two
 *  do not fire, since an unrelated repo-wide rule legitimately may. */
const GUARD_RULES = ['@typescript-eslint/no-restricted-imports', 'no-restricted-syntax'];

/** Production paths: an SDK import here must be an error. */
const GUARDED_PATHS = [
  'lib/pbl/v2/agents/probe',
  'lib/server/probe',
  'app/api/probe/route',
  'components/probe',
  'packages/@openmaic/renderer/src/probe',
  'packages/@openmaic/storage/src/probe',
  'packages/@openmaic/generation/src/probe',
  'lib/choreography/probe',
  'lib/video-export/probe',
  'scripts/probe',
] as const;

/** Deliberate exemptions: the gateway's runtime module, adapters and test doubles,
 *  the legacy stack until P3-6 removes it, offline harnesses, and tests. */
const EXEMPT_PATHS = [
  'lib/model-gateway/runtime/pi-registry',
  'lib/model-gateway/adapters/probe',
  'lib/model-gateway/testing/probe',
  'lib/ai/llm',
  'eval/probe',
  'tests/probe',
] as const;

const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'] as const;

const eslint = new ESLint({ cwd: process.cwd() });
const warmupFilePath = 'lib/server/lint-entry-guard-warmup.ts';
const warmupConfig = await eslint.calculateConfigForFile(warmupFilePath);
if (!warmupConfig) throw new Error(`ESLint warm-up path is not configured: ${warmupFilePath}`);
const [warmupResult] = await eslint.lintText('export const lintEntryGuardWarmup = true;\n', {
  filePath: warmupFilePath,
  warnIgnored: false,
});
const warmupErrors = (warmupResult?.messages ?? []).filter((message) => message.severity === 2);
if (!warmupResult || warmupErrors.length > 0) {
  throw new Error(`ESLint warm-up failed: ${JSON.stringify(warmupErrors)}`);
}

async function errorsFor(filePath: string, code: string): Promise<string[]> {
  // A path ESLint would ignore (build output, vendored trees) returns no result;
  // treat that as "not covered" so an ignored path can never look like a pass.
  if (await eslint.isPathIgnored(filePath)) return ['<path is eslint-ignored>'];
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return (result?.messages ?? []).filter((m) => m.severity === 2).map((m) => m.ruleId ?? 'unknown');
}

describe('LLM entry-point lint guard — coverage matrix', () => {
  for (const [form, code] of Object.entries(BYPASS_FORMS)) {
    for (const ext of EXTENSIONS) {
      // A namespace or named import of a value is not valid in a .cjs/.mjs mix
      // only in principle; eslint parses all of these fine, so no exclusions.
      it(`blocks the ${form} import in every guarded path (.${ext})`, async () => {
        for (const base of GUARDED_PATHS) {
          const filePath = `${base}.${ext}`;
          const errors = await errorsFor(filePath, code);
          expect(errors, `${filePath} should reject the ${form} form`).not.toHaveLength(0);
        }
      });
    }
  }

  it('leaves the entry point, eval harnesses and tests exempt', async () => {
    for (const base of EXEMPT_PATHS) {
      for (const [form, code] of Object.entries(BYPASS_FORMS)) {
        const filePath = `${base}.ts`;
        const errors = await errorsFor(filePath, code);
        expect(
          errors.filter((rule) => GUARD_RULES.includes(rule)),
          `${filePath} should not trip the LLM entry-point guard on the ${form} form`,
        ).toEqual([]);
      }
    }
  });

  it('still enforces the pre-existing module boundaries it shares a rule key with', async () => {
    // The dynamic-import ban uses `no-restricted-syntax`, a key several boundary
    // blocks configure. Flat config REPLACES rule options per key, so a careless
    // edit to the guard silently deletes those boundaries — assert two of them.
    const hostPathImport = "import x from '@/lib/foo';\nexport default x;\n";
    for (const filePath of [
      'packages/@openmaic/renderer/src/probe.ts',
      'packages/@openmaic/storage/src/probe.ts',
      'packages/@openmaic/generation/src/probe.ts',
      'lib/choreography/probe.ts',
    ]) {
      const errors = await errorsFor(filePath, hostPathImport);
      expect(errors, `${filePath} must still reject a host-app @/ import`).toContain(
        'no-restricted-syntax',
      );
    }

    const reactImport = "import 'react';\nexport const a = 1;\n";
    const choreographyErrors = await errorsFor('lib/choreography/probe.ts', reactImport);
    expect(choreographyErrors).toContain('no-restricted-imports');
  });

  it('allows type-only pi-ai imports and the AI SDK UI types everywhere', async () => {
    const typeImports =
      "import type { AssistantMessage } from '@earendil-works/pi-ai';\n" +
      "import type { UIMessage } from 'ai';\n" +
      'export type A = AssistantMessage | UIMessage;\n';
    for (const filePath of [
      'lib/server/probe.ts',
      'lib/pbl/v2/agents/probe.ts',
      'components/probe.tsx',
    ]) {
      const errors = await errorsFor(filePath, typeImports);
      expect(
        errors.filter((rule) => GUARD_RULES.includes(rule)),
        filePath,
      ).toEqual([]);
    }
  });
});

describe('model gateway client boundary', () => {
  const CLIENT_PATHS = [
    'components/probe.tsx',
    'lib/store/probe.ts',
    'lib/utils/probe.ts',
    'app/probe/page.tsx',
  ] as const;
  const importOf = (specifier: string) =>
    `import * as gateway from '${specifier}';\nexport const a = gateway;\n`;

  it('rejects the server gateway surface from client entries', async () => {
    for (const specifier of [
      '@/lib/model-gateway',
      '@/lib/model-gateway/runtime/gateway',
      '@/lib/model-gateway/selection/resolve-binding',
      '@/lib/model-gateway/credentials/handles',
    ]) {
      for (const filePath of CLIENT_PATHS) {
        const errors = await errorsFor(filePath, importOf(specifier));
        expect(errors, `${filePath} must reject ${specifier}`).toContain('no-restricted-imports');
      }
    }
  });

  it('allows the isomorphic types and catalog in client entries', async () => {
    for (const specifier of [
      '@/lib/model-gateway/types',
      '@/lib/model-gateway/catalog/client-catalog',
      '@/lib/model-gateway/catalog/descriptors',
    ]) {
      for (const filePath of CLIENT_PATHS) {
        const errors = await errorsFor(filePath, importOf(specifier));
        expect(errors, `${filePath} may import ${specifier}`).not.toContain(
          'no-restricted-imports',
        );
      }
    }
  });

  it('keeps the server-only polled-task carrier ban on the same client entries', async () => {
    const errors = await errorsFor(
      'components/probe.tsx',
      importOf('@/lib/server/generation-jobs/polled-task-persistence'),
    );
    expect(errors).toContain('no-restricted-imports');
  });
});
