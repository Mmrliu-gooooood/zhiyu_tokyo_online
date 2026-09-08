import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertGenerationConfigSnapshot,
  generationConfigVersions,
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
  it('keeps server and owner media versions separate and hashes only opaque refs', () => {
    const first = parseGenerationInput({
      version: 1,
      requirements: { requirement: 'test' },
      mediaConfigRef: { id: 'a652e716-0e2e-47f5-8432-4ee60f6f0977', revision: 1 },
    });
    const second = parseGenerationInput({
      ...first,
      mediaConfigRef: { id: 'b652e716-0e2e-47f5-8432-4ee60f6f0977', revision: 1 },
    });
    const versions = generationConfigVersions(first);
    expect(versions.server).toBe(generationProviderConfigVersion());
    expect(versions.media).toMatch(/^[a-f0-9]{64}$/);
    expect(versions.media).not.toContain(first.mediaConfigRef!.id);
    expect(generationRequestHash(first)).not.toBe(generationRequestHash(second));
  });
});
