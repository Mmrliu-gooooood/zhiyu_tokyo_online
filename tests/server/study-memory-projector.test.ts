/**
 * The Memory page's catch-up sync (learning plan B06): a request that arrives
 * while a sync for the same owner is running waits for it instead of reading
 * early (found in browser acceptance: React's double effect in dev read the
 * page before the first request's records were written), and throttled
 * requests do not replay again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resetLearningEventSyncThrottle,
  syncLearningEvents,
} from '@/lib/server/study/memory/projector';

function fakeDb(delayMs: number) {
  const calls: string[] = [];
  return {
    calls,
    async query(text: string) {
      calls.push(text.replace(/\s+/g, ' ').trim().slice(0, 40));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { rows: [] };
    },
  };
}

afterEach(() => {
  resetLearningEventSyncThrottle();
  vi.unstubAllEnvs();
});

describe('learning-event catch-up sync', () => {
  it('makes a concurrent request wait for the running sync', async () => {
    vi.stubEnv('ZHIYU_STUDY_MEMORY_ENABLED', '1');
    const db = fakeDb(20);
    const order: string[] = [];
    const first = syncLearningEvents(db as never, 'user:a').then((outcome) => {
      order.push('first');
      return outcome;
    });
    const second = syncLearningEvents(db as never, 'user:a').then((outcome) => {
      order.push('second');
      return outcome;
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.ran).toBe(true);
    expect(b.ran).toBe(false);
    expect(order).toEqual(['first', 'second']);
    // Only one replay ran.
    const controlReads = db.calls.filter((call) => call.includes('study_memory_controls'));
    const afterFirst = controlReads.length;
    expect((await syncLearningEvents(db as never, 'user:a')).ran).toBe(false);
    expect(db.calls.filter((call) => call.includes('study_memory_controls'))).toHaveLength(
      afterFirst,
    );
    // Another owner is not throttled by this one.
    expect((await syncLearningEvents(db as never, 'user:b')).ran).toBe(true);
  });
});
