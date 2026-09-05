import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertGenerationConfigSnapshot,
  generationProviderConfigVersion,
  generationRequestHash,
} from '@/lib/server/generation-jobs/config-snapshot';
import { parseGenerationInput } from '@/lib/server/generation-jobs/contracts';
describe('frozen generation provider configuration', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('detects a model-route change before any provider request', () => {
    vi.stubEnv('MODEL_ROUTES', '{}');
    const input = parseGenerationInput({
      version: 1,
      requirements: { requirement: 'test' },
      model: { configVersion: generationProviderConfigVersion() },
    });
    expect(() => assertGenerationConfigSnapshot(input)).not.toThrow();
    vi.stubEnv('MODEL_ROUTES', '{"scene-content":"openai:different-model"}');
    expect(() => assertGenerationConfigSnapshot(input)).toThrow('GENERATION_CONFIG_CHANGED');
  });
  it('keeps request idempotency stable when the server stamps a config version', () => {
    const input = parseGenerationInput({ version: 1, requirements: { requirement: 'test' } });
    expect(generationRequestHash(input)).toBe(
      generationRequestHash({ ...input, model: { configVersion: 'abc' } }),
    );
    expect(generationRequestHash(input)).not.toBe(
      generationRequestHash({ ...input, requirements: { requirement: 'different' } }),
    );
  });
});
