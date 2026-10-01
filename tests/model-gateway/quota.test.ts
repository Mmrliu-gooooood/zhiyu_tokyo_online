import { describe, expect, it } from 'vitest';
import { leaseFrom, type QuotaLimiter } from '@/lib/model-gateway/runtime/quota';
import { GatewayError } from '@/lib/model-gateway';

/** A one-slot limiter that records slot lifetime like PostgresGenerationLimiter.run. */
function mockLimiter() {
  const state = {
    held: 0,
    maxHeld: 0,
    failures: [] as unknown[],
    lose: undefined as undefined | ((e: unknown) => void),
  };
  const limiter: QuotaLimiter = {
    async run(_kind, _group, signal, work) {
      signal.throwIfAborted();
      state.held += 1;
      state.maxHeld = Math.max(state.maxHeld, state.held);
      const lost = new Promise<never>((_, reject) => {
        state.lose = reject;
      });
      try {
        return await Promise.race([work(), lost]);
      } catch (error) {
        state.failures.push(error);
        throw error;
      } finally {
        state.held -= 1;
      }
    },
  };
  return { limiter, state };
}

describe('quota leases', () => {
  it('holds the slot until release', async () => {
    const { limiter, state } = mockLimiter();
    const lease = await leaseFrom(limiter, new AbortController().signal);
    expect(state.held).toBe(1);
    await lease.release();
    expect(state.held).toBe(0);
    await lease.release();
    expect(state.held).toBe(0);
  });

  it('passes a release error to the limiter (429 cooldown path)', async () => {
    const { limiter, state } = mockLimiter();
    const lease = await leaseFrom(limiter, new AbortController().signal);
    const error = new GatewayError('MODEL_RATE_LIMITED', {
      providerId: 'p',
      modelId: 'm',
      status: 429,
      retryAfterMs: 2000,
    });
    await lease.release(error);
    expect(state.failures).toEqual([error]);
    expect((state.failures[0] as GatewayError).statusCode).toBe(429);
    expect((state.failures[0] as GatewayError).responseHeaders).toEqual({ 'retry-after': '2' });
    expect(state.held).toBe(0);
  });

  it('aborts the lease signal when the limiter loses the slot', async () => {
    const { limiter, state } = mockLimiter();
    const lease = await leaseFrom(limiter, new AbortController().signal);
    state.lose?.(new Error('PROVIDER_SLOT_LEASE_LOST'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(lease.signal.aborted).toBe(true);
    await lease.release();
  });

  it('rejects when the slot cannot be acquired', async () => {
    const { limiter } = mockLimiter();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(leaseFrom(limiter, controller.signal)).rejects.toThrow('cancelled');
  });
});
