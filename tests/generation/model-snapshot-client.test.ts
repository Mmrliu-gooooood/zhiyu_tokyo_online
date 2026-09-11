import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncGenerationModelSnapshot } from '@/lib/generation/model-snapshot-client';

afterEach(() => vi.unstubAllGlobals());

describe('generation model snapshot client', () => {
  it('sends platform thinking intent without browser provider overrides', async () => {
    const ref = { id: crypto.randomUUID(), revision: 1 };
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ref }),
    );
    vi.stubGlobal('fetch', request);

    await expect(
      syncGenerationModelSnapshot({
        source: 'platform',
        defaultId: 'zhiyu-default-text',
        revision: 'text-r1',
        modelString: 'deepseek:must-not-leak',
        apiKey: 'must-not-leak',
        baseUrl: 'https://must-not-leak.example/v1',
        thinkingConfig: { mode: 'disabled', effort: 'none' },
      }),
    ).resolves.toEqual(ref);

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'text-r1',
      thinkingConfig: { mode: 'disabled', effort: 'none' },
    });
  });
});
