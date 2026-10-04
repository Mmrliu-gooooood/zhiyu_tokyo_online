// @vitest-environment jsdom
/**
 * Client progress sync (learning plan B01): throttled writes based on the
 * known revision, the conflict rule (a newer position retries on the current
 * revision, an older one is dropped), and stopping for courses the server
 * does not hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const account = vi.hoisted(() => ({ userId: 'user-a' as string | undefined }));
vi.mock('@/lib/auth/account-environment', () => ({
  peekAccountUserId: () => account.userId,
}));

import { resetStudyCapabilityCache } from '@/lib/study/spaces/client';
import {
  FLUSH_DELAY_MS,
  flushStudyProgress,
  primeStudyProgress,
  reportStudyProgress,
  resetStudyProgressSync,
} from '@/lib/study/progress/sync';
import type { StudyCourseProgressView } from '@/lib/study/spaces/contracts';

function view(overrides: Partial<StudyCourseProgressView> = {}): StudyCourseProgressView {
  return {
    stageId: 'stage-1',
    courseName: 'c',
    sceneId: 's1',
    sceneIndex: 0,
    sceneCount: 3,
    actionIndex: 0,
    actionId: null,
    furthestSceneIndex: 0,
    reachedEnd: false,
    sceneChanged: false,
    sceneMissing: false,
    resumeSceneId: 's1',
    resumeActionIndex: 0,
    revision: 1,
    observedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

type Reply = { status: number; body: unknown };
let replies: Reply[];
let puts: Array<{ url: string; body: Record<string, unknown>; keepalive?: boolean }>;

beforeEach(() => {
  vi.useFakeTimers();
  account.userId = 'user-a';
  resetStudyCapabilityCache();
  resetStudyProgressSync();
  replies = [];
  puts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/study/capabilities') return Response.json({ spaces: true });
      puts.push({ url, body: JSON.parse(String(init?.body)), keepalive: init?.keepalive });
      const reply = replies.shift() ?? { status: 200, body: { progress: view({ revision: 99 }) } };
      return Response.json(reply.body, { status: reply.status });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('study progress sync', () => {
  it('coalesces positions into one write per interval, based on the primed revision', async () => {
    primeStudyProgress('stage-1', view({ revision: 4 }));
    replies.push({ status: 200, body: { progress: view({ revision: 5 }) } });
    reportStudyProgress('stage-1', 's1', 1);
    reportStudyProgress('stage-1', 's1', 2);
    reportStudyProgress('stage-1', 's2', 0);
    expect(puts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      url: '/api/study/progress/stage-1',
      body: { sceneId: 's2', actionIndex: 0, baseRevision: 4 },
    });
    // The next write builds on the revision the server returned.
    reportStudyProgress('stage-1', 's2', 1);
    await flushStudyProgress('stage-1');
    expect(puts[1]?.body.baseRevision).toBe(5);
  });

  it('keeps the queued action index when only the same scene is reported again', async () => {
    reportStudyProgress('stage-1', 's1', 3);
    reportStudyProgress('stage-1', 's1', null);
    await flushStudyProgress('stage-1');
    expect(puts[0]?.body).toMatchObject({ sceneId: 's1', actionIndex: 3 });
  });

  it('retries a newer position on the current revision after a conflict', async () => {
    const older = new Date(Date.now() - 60_000).toISOString();
    replies.push({
      status: 409,
      body: { error: 'STUDY_REVISION_CONFLICT', current: view({ revision: 7, observedAt: older }) },
    });
    reportStudyProgress('stage-1', 's2', 0);
    await flushStudyProgress('stage-1');
    expect(puts.map((put) => put.body.baseRevision)).toEqual([null, 7]);
  });

  it('drops an older position instead of overwriting newer progress from another device', async () => {
    reportStudyProgress('stage-1', 's1', 0);
    const newer = new Date(Date.now() + 60_000).toISOString();
    replies.push({
      status: 409,
      body: { error: 'STUDY_REVISION_CONFLICT', current: view({ revision: 9, observedAt: newer }) },
    });
    await flushStudyProgress('stage-1');
    expect(puts).toHaveLength(1);
    // Later positions build on the adopted revision.
    reportStudyProgress('stage-1', 's3', 0);
    await flushStudyProgress('stage-1');
    expect(puts[1]?.body.baseRevision).toBe(9);
  });

  it('stops syncing a course the server does not hold, and keeps positions when offline', async () => {
    replies.push({ status: 404, body: { error: 'STUDY_COURSE_NOT_FOUND' } });
    reportStudyProgress('local-only', 's1', 0);
    await flushStudyProgress('local-only');
    reportStudyProgress('local-only', 's1', 1);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 2);
    expect(puts).toHaveLength(1);

    replies.push({ status: 503, body: { error: 'STUDY_UNAVAILABLE' } });
    reportStudyProgress('stage-1', 's1', 2);
    await flushStudyProgress('stage-1');
    expect(puts).toHaveLength(2);
    // Retried later with the same position.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(puts).toHaveLength(3);
    expect(puts[2]?.body).toMatchObject({ sceneId: 's1', actionIndex: 2 });
  });

  it('sends nothing while signed out, and never carries a queue across accounts', async () => {
    account.userId = undefined;
    reportStudyProgress('stage-1', 's1', 0);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(puts).toHaveLength(0);

    account.userId = 'user-a';
    reportStudyProgress('stage-1', 's1', 1);
    account.userId = 'user-b';
    // The new account starts clean: A's queued position is not sent as B.
    reportStudyProgress('stage-2', 's1', 0);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    expect(puts.map((put) => put.url)).toEqual(['/api/study/progress/stage-2']);
  });

  it('flushes with keepalive when the page is hidden', async () => {
    reportStudyProgress('stage-1', 's1', 1);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(puts[0]?.keepalive).toBe(true);
  });
});
