import { describe, expect, test } from 'vitest';
import nextConfig from '../../next.config';

describe('standalone prompt assets', () => {
  test('traces every runtime-loaded prompt directory into the server bundle', () => {
    const includes = nextConfig.outputFileTracingIncludes?.['/*'] ?? [];

    expect(includes).toEqual(
      expect.arrayContaining([
        'lib/prompts/**',
        // PBL v2 runtime agents (instructor / evaluator / simulator).
        'lib/pbl/v2/prompts/**',
        'packages/@openmaic/generation/templates/**',
        'packages/@openmaic/generation/snippets/**',
        'packages/@openmaic/generation/prompts-pbl/**',
      ]),
    );
  });
});
