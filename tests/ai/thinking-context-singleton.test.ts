import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ThinkingConfig } from '@/lib/types/provider';

type ThinkingCarrier = {
  run<T>(config: ThinkingConfig | undefined, body: () => T): T;
  getStore(): ThinkingConfig | undefined;
};

describe('thinking context carrier', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__thinkingContext;
    vi.resetModules();
  });

  it('reuses one carrier across module copies and isolates concurrent preferences', async () => {
    delete (globalThis as Record<string, unknown>).__thinkingContext;
    vi.resetModules();
    const first = await import('@/lib/ai/thinking-context');
    vi.resetModules();
    const second = await import('@/lib/ai/thinking-context');
    const globalCarrier = (globalThis as Record<string, unknown>)
      .__thinkingContext as ThinkingCarrier;

    expect(second.thinkingContext).toBe(first.thinkingContext);
    const [disabled, enabled] = await Promise.all([
      first.thinkingContext.run({ mode: 'disabled', effort: 'none' }, async () => {
        await Promise.resolve();
        return globalCarrier.getStore();
      }),
      second.thinkingContext.run({ mode: 'enabled', effort: 'high' }, async () => {
        await Promise.resolve();
        return globalCarrier.getStore();
      }),
    ]);

    expect(disabled).toMatchObject({ mode: 'disabled', effort: 'none' });
    expect(enabled).toMatchObject({ mode: 'enabled', effort: 'high' });
  });
});
