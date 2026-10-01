import { describe, expect, it, vi } from 'vitest';
import { GatewayError } from '@/lib/model-gateway/runtime/errors';
import { PostgresGenerationLimiter } from '@/lib/server/generation-jobs/limiter';

/** A limiter whose database operations are stubbed; only `run`'s failure handling is real. */
function limiter() {
  const instance = new PostgresGenerationLimiter({} as never, { llm: 1, tts: 1, media: 1 });
  const slot = { group: 'llm:deployment', slot: 0, holder: 'h', epoch: 1 };
  vi.spyOn(instance, 'acquire').mockResolvedValue(slot);
  vi.spyOn(instance, 'release').mockResolvedValue(undefined as never);
  const cooldown = vi.spyOn(instance, 'cooldown').mockResolvedValue(undefined);
  return { instance, cooldown };
}

const failure = (code: GatewayError['code'], init: Partial<{ retryAfterMs: number }> = {}) =>
  new GatewayError(code, { providerId: 'deepseek', modelId: 'deepseek-flash', ...init });

describe('PostgresGenerationLimiter — gateway failures', () => {
  it('cools the group down for the provider retry-after on a rate limit', async () => {
    const { instance, cooldown } = limiter();
    const error = failure('MODEL_RATE_LIMITED', { retryAfterMs: 2_500 });
    await expect(
      instance.run('llm', 'deployment', new AbortController().signal, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(cooldown).toHaveBeenCalledWith('llm:deployment', 2_500, expect.anything());
  });

  it('does not cool down for other gateway failures, even pre-send network ones', async () => {
    const { instance, cooldown } = limiter();
    const error = new GatewayError('MODEL_NETWORK', {
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
      safeToRetry: true,
    });
    await expect(
      instance.run('llm', 'deployment', new AbortController().signal, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(cooldown).not.toHaveBeenCalled();
  });
});
