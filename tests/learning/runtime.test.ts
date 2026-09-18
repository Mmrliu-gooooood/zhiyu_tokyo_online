import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@openmaic/storage';
import type { RuntimeStore } from '@openmaic/storage';
import { HttpRuntimeStore } from '@openmaic/storage/runtime/http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { learningCheckRuntimePayloadValidator } from '@/lib/learning/contracts';
import {
  LearningCheckGradeConflictError,
  LearningCheckIncompleteReviewError,
  LearningCheckImmutableEvidenceError,
  listLearningCheckAttempts,
  recordLearningCheckPhase,
  saveLearningCheckQuestionSet,
} from '@/lib/learning/runtime';
import { learningPayload } from './fixtures';

const databases = new Set<string>();

function store(name: string) {
  databases.add(name);
  return new BrowserRuntimeStore({
    dbName: name,
    payloadValidators: { learningCheck: learningCheckRuntimePayloadValidator },
  });
}

function httpStore(backing: BrowserRuntimeStore): HttpRuntimeStore {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    const segments = url.pathname.split('/').filter(Boolean);
    try {
      if (method === 'POST' && url.pathname === '/api/runtime/sessions') {
        return Response.json(await backing.createSession(body as never), { status: 201 });
      }
      if (
        method === 'GET' &&
        segments[1] === 'runtime' &&
        segments[2] === 'stages' &&
        segments[4] === 'learners'
      ) {
        return Response.json(
          await backing.listSessions(
            decodeURIComponent(segments[3]!),
            decodeURIComponent(segments[5]!),
          ),
        );
      }
      if (segments[1] === 'runtime' && segments[2] === 'sessions' && segments[4] === 'records') {
        const sessionId = decodeURIComponent(segments[3]!);
        if (method === 'GET') return Response.json(await backing.listRecords(sessionId));
        if (method === 'POST') {
          const { expectedLastSeq, sessionTransition, ...record } = body!;
          return Response.json(
            await backing.appendRecord(record as never, {
              expectedLastSeq: expectedLastSeq as number | null,
              sessionTransition: sessionTransition as never,
            }),
            { status: 201 },
          );
        }
      }
      if (method === 'GET' && segments[1] === 'runtime' && segments[2] === 'sessions') {
        const session = await backing.getSession(decodeURIComponent(segments[3]!));
        if (session) return Response.json(session);
        return Response.json(
          { error: { code: 'SESSION_NOT_FOUND', message: 'missing' } },
          { status: 404 },
        );
      }
      return Response.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, { status: 404 });
    } catch (error) {
      return Response.json(
        { error: { code: 'HTTP_BACKING_ERROR', message: String(error) } },
        { status: 500 },
      );
    }
  };
  return new HttpRuntimeStore({ baseUrl: 'http://runtime.test/api', fetch });
}

function concurrentTabStores(backing: RuntimeStore): [RuntimeStore, RuntimeStore] {
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tab = () =>
    new Proxy(backing, {
      get(target, property) {
        if (property === 'listRecords') {
          return async (...args: Parameters<RuntimeStore['listRecords']>) => {
            const records = await target.listRecords(...args);
            reads += 1;
            if (reads <= 2) {
              if (reads === 2) release();
              await bothRead;
            }
            return records;
          };
        }
        const member = Reflect.get(target, property, target) as unknown;
        return typeof member === 'function' ? member.bind(target) : member;
      },
    }) as RuntimeStore;
  return [tab(), tab()];
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    [...databases].map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => resolve();
        }),
    ),
  );
  databases.clear();
});

describe('learning-check runtime', () => {
  it('enforces an exact source-specific identity shape at the runtime boundary', () => {
    const courseWithParent = learningPayload();
    courseWithParent.identity.parentAttemptId = 'unexpected-parent';
    courseWithParent.identity.questionId = 'unexpected-question';
    expect(learningCheckRuntimePayloadValidator(courseWithParent)).toMatchObject({ valid: false });

    const remediationWithoutParent = learningPayload();
    remediationWithoutParent.identity.source = 'remediation_check';
    expect(learningCheckRuntimePayloadValidator(remediationWithoutParent)).toMatchObject({
      valid: false,
    });

    const remediation = learningPayload();
    remediation.identity.source = 'remediation_check';
    remediation.identity.parentAttemptId = 'parent-attempt';
    remediation.identity.questionId = 'parent-question';
    expect(learningCheckRuntimePayloadValidator(remediation)).toEqual({ valid: true });

    const identityWithExtra = remediation.identity as typeof remediation.identity & {
      unexpected?: string;
    };
    identityWithExtra.unexpected = 'not-allowed';
    expect(learningCheckRuntimePayloadValidator(remediation)).toMatchObject({ valid: false });
  });

  it('validates lifecycle answers and grades at the Browser/HTTP payload boundary', () => {
    expect(learningCheckRuntimePayloadValidator(learningPayload('reviewed'))).toEqual({
      valid: true,
    });
    const invalid = learningPayload('reviewed') as unknown as Record<string, unknown>;
    const lifecycle = invalid.lifecycle as Record<string, unknown>;
    lifecycle.grading = {
      q1: { status: 'graded', score: 99, comment: 'Invented score', basis: 'model' },
    };
    expect(learningCheckRuntimePayloadValidator(invalid)).toMatchObject({ valid: false });
  });

  it('persists the immutable question set before returning it and completes reviewed atomically', async () => {
    const runtime = store(`learning-${crypto.randomUUID()}`);
    const draft = learningPayload('draft');
    await saveLearningCheckQuestionSet('stage-1', draft, {
      store: runtime,
      learnerKey: 'learner-1',
      now: () => '2026-09-14T00:00:00.000Z',
      mintRecordId: () => 'record-1',
    });

    expect(
      (await listLearningCheckAttempts('stage-1', { store: runtime, learnerKey: 'learner-1' }))[0],
    ).toMatchObject({
      payload: { questionSet: { questionSetId: 'question-set-1' } },
      status: 'active',
    });

    await recordLearningCheckPhase('stage-1', learningPayload('submitted'), {
      store: runtime,
      learnerKey: 'learner-1',
      now: () => '2026-09-14T00:01:00.000Z',
      mintRecordId: () => 'record-2',
    });
    await recordLearningCheckPhase('stage-1', learningPayload('reviewed'), {
      store: runtime,
      learnerKey: 'learner-1',
      now: () => '2026-09-14T00:02:00.000Z',
      mintRecordId: () => 'record-3',
    });

    const attempts = await listLearningCheckAttempts('stage-1', {
      store: runtime,
      learnerKey: 'learner-1',
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 'completed',
      payload: { lifecycle: { phase: 'reviewed' } },
    });
    await expect(
      runtime.appendRecord({
        id: 'late',
        sessionId: 'attempt-1',
        createdAt: '2026-09-14T00:03:00.000Z',
        payload: learningPayload('reviewed'),
      }),
    ).rejects.toThrow(/cannot append/i);
  });

  it('rejects replacing source evidence or the question set in an active attempt', async () => {
    const runtime = store(`learning-${crypto.randomUUID()}`);
    await saveLearningCheckQuestionSet('stage-1', learningPayload(), {
      store: runtime,
      learnerKey: 'learner-1',
    });
    const changed = learningPayload('submitted');
    changed.questionSet.questions[0]!.prompt = 'A different historical question';

    await expect(
      recordLearningCheckPhase('stage-1', changed, { store: runtime, learnerKey: 'learner-1' }),
    ).rejects.toBeInstanceOf(LearningCheckImmutableEvidenceError);
  });

  it('does not complete a reviewed attempt while any question is pending or unavailable', async () => {
    const runtime = store(`learning-${crypto.randomUUID()}`);
    await saveLearningCheckQuestionSet('stage-1', learningPayload('draft'), {
      store: runtime,
      learnerKey: 'learner-1',
    });
    await recordLearningCheckPhase('stage-1', learningPayload('submitted'), {
      store: runtime,
      learnerKey: 'learner-1',
    });
    const incomplete = learningPayload('reviewed');
    incomplete.lifecycle.grading.q1 = { status: 'error', message: 'grading-unavailable' };
    expect(learningCheckRuntimePayloadValidator(incomplete)).toMatchObject({ valid: false });

    await expect(
      recordLearningCheckPhase('stage-1', incomplete, {
        store: runtime,
        learnerKey: 'learner-1',
      }),
    ).rejects.toBeInstanceOf(LearningCheckIncompleteReviewError);
    expect(
      (
        await listLearningCheckAttempts('stage-1', {
          store: runtime,
          learnerKey: 'learner-1',
        })
      )[0],
    ).toMatchObject({ status: 'active', payload: { lifecycle: { phase: 'submitted' } } });
  });

  it('merges different graded questions from concurrent tabs without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    const runtime = store(`learning-${crypto.randomUUID()}`);
    const submitted = learningPayload('submitted');
    submitted.questionSet.questions.push({
      ...submitted.questionSet.questions[0]!,
      id: 'q2',
      conceptId: 'acceleration',
    });
    submitted.lifecycle.answers.q2 = ['B'];
    submitted.lifecycle.grading = { q1: { status: 'pending' }, q2: { status: 'pending' } };
    await saveLearningCheckQuestionSet(
      'stage-1',
      {
        ...submitted,
        lifecycle: {
          ...submitted.lifecycle,
          phase: 'draft',
          answers: {},
          grading: {},
          submittedAt: undefined,
        },
      },
      { store: runtime, learnerKey: 'learner-1' },
    );
    await recordLearningCheckPhase('stage-1', submitted, {
      store: runtime,
      learnerKey: 'learner-1',
    });
    const tabA = structuredClone(submitted);
    tabA.lifecycle.grading.q1 = {
      status: 'graded',
      score: 2,
      comment: 'Tab A graded q1.',
      basis: 'model',
    };
    const tabB = structuredClone(submitted);
    tabB.lifecycle.grading.q2 = {
      status: 'graded',
      score: 0,
      comment: 'Tab B graded q2.',
      basis: 'model',
    };
    const [storeA, storeB] = concurrentTabStores(runtime);

    await Promise.all([
      recordLearningCheckPhase('stage-1', tabA, { store: storeA, learnerKey: 'learner-1' }),
      recordLearningCheckPhase('stage-1', tabB, { store: storeB, learnerKey: 'learner-1' }),
    ]);

    const latest = (
      await listLearningCheckAttempts('stage-1', { store: runtime, learnerKey: 'learner-1' })
    )[0]!.payload;
    expect(latest.lifecycle.answers).toEqual(submitted.lifecycle.answers);
    expect(latest.lifecycle.grading).toMatchObject({
      q1: { status: 'graded', score: 2, comment: 'Tab A graded q1.' },
      q2: { status: 'graded', score: 0, comment: 'Tab B graded q2.' },
    });
  });

  it('rejects a different grade for a question whose first grade is already durable', async () => {
    const runtime = store(`learning-${crypto.randomUUID()}`);
    const draft = learningPayload('draft');
    await saveLearningCheckQuestionSet('stage-1', draft, {
      store: runtime,
      learnerKey: 'learner-1',
    });
    const submitted = learningPayload('submitted');
    submitted.lifecycle.grading.q1 = { status: 'pending' };
    await recordLearningCheckPhase('stage-1', submitted, {
      store: runtime,
      learnerKey: 'learner-1',
    });
    const first = structuredClone(submitted);
    first.lifecycle.grading.q1 = {
      status: 'graded',
      score: 2,
      comment: 'First durable grade.',
      basis: 'model',
    };
    await recordLearningCheckPhase('stage-1', first, {
      store: runtime,
      learnerKey: 'learner-1',
    });
    const conflicting = structuredClone(submitted);
    conflicting.lifecycle.grading.q1 = {
      status: 'graded',
      score: 0,
      comment: 'Conflicting grade.',
      basis: 'model',
    };

    await expect(
      recordLearningCheckPhase('stage-1', conflicting, {
        store: runtime,
        learnerKey: 'learner-1',
      }),
    ).rejects.toBeInstanceOf(LearningCheckGradeConflictError);
    expect(
      (
        await listLearningCheckAttempts('stage-1', {
          store: runtime,
          learnerKey: 'learner-1',
        })
      )[0]!.payload.lifecycle.grading.q1,
    ).toMatchObject({ status: 'graded', score: 2, comment: 'First durable grade.' });
  });

  it('lists every attempt instead of projecting only the latest session', async () => {
    const runtime = store(`learning-${crypto.randomUUID()}`);
    await saveLearningCheckQuestionSet('stage-1', learningPayload(), {
      store: runtime,
      learnerKey: 'learner-1',
    });
    const second = learningPayload();
    second.identity.checkId = 'check-2';
    second.identity.attemptId = 'attempt-2';
    second.identity.requestId = 'request-2';
    second.questionSet.questionSetId = 'question-set-2';
    await saveLearningCheckQuestionSet('stage-1', second, {
      store: runtime,
      learnerKey: 'learner-1',
    });

    expect(
      (await listLearningCheckAttempts('stage-1', { store: runtime, learnerKey: 'learner-1' })).map(
        (attempt) => attempt.payload.identity.attemptId,
      ),
    ).toEqual(['attempt-1', 'attempt-2']);
  });

  it('persists and reads the same learning payload through the HTTP RuntimeStore provider', async () => {
    const backing = store(`learning-http-${crypto.randomUUID()}`);
    const runtime = httpStore(backing);
    await saveLearningCheckQuestionSet('stage-1', learningPayload(), {
      store: runtime,
      learnerKey: 'learner-http',
    });

    expect(
      await listLearningCheckAttempts('stage-1', { store: runtime, learnerKey: 'learner-http' }),
    ).toMatchObject([{ payload: { identity: { attemptId: 'attempt-1' } } }]);
  });
});
