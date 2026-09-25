import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelForegroundGenerationRoot,
  foregroundGenerationHeaders,
} from '@/lib/generation/foreground-root-client';

describe('foreground generation client fence', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares one session within a run and rotates it before a cancelled run can return', async () => {
    const first = foregroundGenerationHeaders('stage-fenced');
    const repeated = foregroundGenerationHeaders('stage-fenced');
    expect(repeated).toEqual(first);

    let releaseRequest: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        releaseRequest = init;
        return new Response('{}', { status: 200 });
      }),
    );
    await cancelForegroundGenerationRoot('stage-fenced');

    expect(new Headers(releaseRequest?.headers).get('x-generation-root-session-id')).toBe(
      first['x-generation-root-session-id'],
    );
    const next = foregroundGenerationHeaders('stage-fenced');
    expect(next['x-generation-root-session-id']).not.toBe(first['x-generation-root-session-id']);
  });
});
