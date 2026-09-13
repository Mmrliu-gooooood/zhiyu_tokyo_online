import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/lib/utils/model-config', () => ({ refreshPlatformModelConfig: refresh }));
import { syncGenerationModelSnapshot } from '@/lib/generation/model-snapshot-client';

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => refresh.mockReset());

describe('generation model snapshot client', () => {
  it.each(['old', undefined])(
    'refreshes an outdated or not-yet-hydrated platform catalog (%s) before retrying a rejected snapshot',
    async (revision) => {
      const context = {
        source: 'platform' as const,
        defaultId: 'zhiyu-default-text' as const,
        revision,
      };
      const ref = { id: crypto.randomUUID(), revision: 1 };
      const signal = new AbortController().signal;
      const request = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ errorCode: 'PRO_MODEL_CONNECTION_STALE' }, { status: 409 }),
        )
        .mockResolvedValueOnce(Response.json({ ref }));
      refresh.mockResolvedValue({ ...context, revision: 'new' });
      vi.stubGlobal('fetch', request);

      await expect(syncGenerationModelSnapshot(context, signal)).resolves.toEqual(ref);

      expect(refresh).toHaveBeenCalledExactlyOnceWith(context, signal);
      expect(JSON.parse(request.mock.calls[1][1].body).revision).toBe('new');
      expect(request.mock.calls[1][1].signal).toBe(signal);
    },
  );
  it('does not retry snapshot creation again if a catalog refresh still returns a conflict', async () => {
    const context = {
      source: 'platform' as const,
      defaultId: 'zhiyu-default-text' as const,
      revision: 'old',
    };
    const request = vi.fn(async () =>
      Response.json({ errorCode: 'PRO_MODEL_CONNECTION_STALE' }, { status: 409 }),
    );
    refresh.mockResolvedValue({ ...context, revision: 'new' });
    vi.stubGlobal('fetch', request);

    await expect(syncGenerationModelSnapshot(context)).rejects.toMatchObject({
      code: 'PRO_MODEL_CONNECTION_STALE',
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('does not refresh the catalog or retry unrelated snapshot failures', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json({ errorCode: 'GENERATION_MODEL_SNAPSHOT_UNAVAILABLE' }, { status: 503 }),
      );
    vi.stubGlobal('fetch', request);

    await expect(
      syncGenerationModelSnapshot({
        source: 'platform',
        defaultId: 'zhiyu-default-text',
        revision: 'current',
      }),
    ).rejects.toThrow();

    expect(request).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
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
