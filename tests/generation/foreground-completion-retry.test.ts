import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  completeForegroundGenerationRoot,
  foregroundGenerationHeaders,
  ForegroundCompletionError,
  hasPendingForegroundGenerationSession,
} from '@/lib/generation/foreground-root-client';

const noSleep = { retryDelaysMs: [1, 1, 1], sleep: async () => undefined };

function stubFetch(...outcomes: Array<number | 'network'>) {
  const calls: RequestInit[] = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (outcome === 'network') throw new TypeError('Failed to fetch');
    return new Response('{}', { status: outcome });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('foreground completion bounded retry', () => {
  it('retries 5xx and network errors, then succeeds and clears the session', async () => {
    const session = foregroundGenerationHeaders('stage-retry-ok')['x-generation-root-session-id'];
    const { calls } = stubFetch(503, 'network', 200);
    await completeForegroundGenerationRoot('stage-retry-ok', noSleep);
    expect(calls).toHaveLength(3);
    for (const init of calls) {
      expect(new Headers(init.headers).get('x-generation-root-session-id')).toBe(session);
    }
    expect(hasPendingForegroundGenerationSession('stage-retry-ok')).toBe(false);
  });

  it('gives up after the bounded attempts and keeps the session for reopen repair', async () => {
    foregroundGenerationHeaders('stage-retry-exhausted');
    const { calls } = stubFetch(500);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const failure = await completeForegroundGenerationRoot('stage-retry-exhausted', {
      retryDelaysMs: [10, 20, 30],
      sleep,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ForegroundCompletionError);
    expect((failure as ForegroundCompletionError).terminal).toBe(false);
    expect(calls).toHaveLength(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20, 30]);
    expect(hasPendingForegroundGenerationSession('stage-retry-exhausted')).toBe(true);
  });

  it.each([403, 404])('does not retry %d', async (status) => {
    foregroundGenerationHeaders(`stage-${status}`);
    const { calls } = stubFetch(status);
    const failure = await completeForegroundGenerationRoot(`stage-${status}`, noSleep).catch(
      (error: unknown) => error,
    );
    expect(calls).toHaveLength(1);
    expect(failure).toMatchObject({ status, terminal: true });
  });

  it('re-sends the same session after a lost response (server steps are idempotent)', async () => {
    const session = foregroundGenerationHeaders('stage-lost')['x-generation-root-session-id'];
    const { calls } = stubFetch('network', 200);
    await completeForegroundGenerationRoot('stage-lost', noSleep);
    expect(
      calls.map((init) => new Headers(init.headers).get('x-generation-root-session-id')),
    ).toEqual([session, session]);
  });

  it('sends no session headers when this tab never held a foreground session', async () => {
    const { calls } = stubFetch(200);
    await completeForegroundGenerationRoot('stage-no-session', noSleep);
    expect(new Headers(calls[0].headers).has('x-generation-root-session-id')).toBe(false);
  });
});
