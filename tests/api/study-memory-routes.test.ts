/**
 * Memory and preference APIs (learning plan B06) end to end on PGlite:
 * hidden unless the switch is on; learning records are projected by rule from
 * saved progress, classroom quiz attempts and after-class chat messages
 * (idempotent, replayable, never a mastery claim); a deleted record stays
 * deleted when projection runs again; the switches stop projection and
 * personalised reads; preferences and facts are edited only explicitly;
 * clearing keeps raw quiz attempts unless asked; owners are isolated; and
 * none of it calls a model.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
} from '@openmaic/storage/agent-session/pg';
import { ensureSchema as ensureRuntimeSchema } from '@openmaic/storage/runtime/pg';

const owner = vi.hoisted(() => ({ id: 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
const database = vi.hoisted(() => ({ pg: null as unknown, store: null as unknown }));

vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: (_req: Request, handler: (ownerId: string, headers: Headers) => unknown) =>
    handler(owner.id, new Headers()),
}));
vi.mock('@/lib/server/stage-access', async () => {
  const { createOwnerBoundQueryable } = await import('@/lib/db/request-queryable');
  return {
    getOwnerBoundStageAccessDb: vi.fn(async (ownerId: string) =>
      createOwnerBoundQueryable(
        {
          connect: async () => ({
            query: (text: string, params?: unknown[]) =>
              (database.pg as PGlite).query(text, params),
            release() {},
          }),
        } as never,
        ownerId,
      ),
    ),
    probeStageAccess: vi.fn(async () => ({ kind: 'owned' })),
  };
});
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: vi.fn(async () => database.store),
}));

import { gateway } from '@/lib/model-gateway';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { resolveMemoryContext } from '@/lib/server/study/memory/context';
import { resetLearningEventSyncThrottle } from '@/lib/server/study/memory/projector';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import { GET as overview } from '@/app/api/study/memory/route';
import { PUT as putControl } from '@/app/api/study/memory/controls/route';
import { POST as addFact } from '@/app/api/study/memory/facts/route';
import {
  DELETE as deleteFact,
  PATCH as patchFact,
} from '@/app/api/study/memory/facts/[factId]/route';
import { DELETE as deleteRecord } from '@/app/api/study/memory/records/[seq]/route';
import { POST as decline } from '@/app/api/study/memory/suggestions/route';
import { POST as clear } from '@/app/api/study/memory/clear/route';
import {
  DELETE as deletePref,
  GET as listPrefs,
  PUT as putPref,
} from '@/app/api/study/preferences/route';
import { PUT as putProgress } from '@/app/api/study/progress/[stageId]/route';
import { POST as openChat } from '@/app/api/study/classmates/[classmateId]/chats/route';
import type { MemoryOverview } from '@/lib/study/memory/overview';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CM = 'cm-0123456789abcdef';
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const request = (method: string, body?: unknown, url = 'https://zhiyu.test/api/study/memory') =>
  new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as never;

const pg = () => database.pg as PGlite;

async function seed() {
  await pg().query(
    `INSERT INTO study_spaces (id, owner_id, name, goal, exam_date) VALUES
       ('space-a', $1, '高数', '期末 85 分', '2026-12-20'), ('space-c', $1, '物理', NULL, NULL),
       ('space-b', $2, '英语', NULL, NULL)`,
    [OWNER, OTHER],
  );
  await pg().query(
    `INSERT INTO study_classmates (id, owner_id, name, role, learning_style, speech_policy, avatar, color)
     VALUES ($1, $2, '小林', 'student', 'peer', 'active', '/avatars/curious.png', '#10b981')`,
    [CM, OWNER],
  );
  await pg().query(
    `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
     VALUES ('stage-a', '导数入门', 0, 0, $1, '{"id":"stage-a"}'),
            ('stage-b', '英语语法', 0, 0, $2, '{"id":"stage-b"}')`,
    [OWNER, OTHER],
  );
  await pg().query(
    `INSERT INTO stage_meta (stage_id, owner_id) VALUES ('stage-a', $1), ('stage-b', $2)`,
    [OWNER, OTHER],
  );
  const scene = (id: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, type: 'slide', title: id, actions: [{ id: `${id}-a1` }], ...extra });
  await pg().query(
    `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES
       ('stage-a', 's1', 0, $1::jsonb), ('stage-a', 's2', 1, $2::jsonb), ('stage-a', 'quiz', 2, $3::jsonb)`,
    [
      scene('s1'),
      scene('s2'),
      scene('quiz', {
        type: 'quiz',
        content: {
          type: 'quiz',
          questions: [
            { id: 'q1', type: 'single', question: '1+1?', answer: ['B'] },
            { id: 'q2', type: 'single', question: '2+2?', answer: ['D'] },
          ],
        },
      }),
    ],
  );
  await pg().query(
    `INSERT INTO study_space_courses (owner_id, space_id, stage_id) VALUES ($1, 'space-a', 'stage-a')`,
    [OWNER],
  );
}

async function quizAttempt(sessionId: string, answers: Record<string, string>) {
  const snapshot = [
    { id: 'q1', type: 'single', question: '1+1?', answer: ['B'], points: 1 },
    { id: 'q2', type: 'single', question: '2+2?', answer: ['D'], points: 1 },
  ];
  const payload = {
    payloadVersion: 2,
    phase: 'submitted',
    questionSnapshot: snapshot,
    contentRevision: 'x',
    answers,
    // The browser claims every question correct; the server re-grades.
    grading: {
      q1: { status: 'graded', result: { earned: 1 } },
      q2: { status: 'graded', result: { earned: 1 } },
    },
    results: [],
    gradeProvenance: {},
  };
  const now = new Date().toISOString();
  await pg().query(
    `INSERT INTO runtime_sessions (id, stage_id, learner_key, kind, status, created_at, updated_at, data)
     VALUES ($1, 'stage-a', $2, 'quizAttempt', 'active', $3, $3, '{}'::jsonb)`,
    [sessionId, OWNER, now],
  );
  await pg().query(
    `INSERT INTO runtime_records (id, session_id, seq, scene_id, created_at, data)
     VALUES ($1, $2, 0, 'quiz', $3, $4::jsonb)`,
    [`${sessionId}-r0`, sessionId, now, JSON.stringify({ payload })],
  );
}

async function readOverview(): Promise<MemoryOverview> {
  resetLearningEventSyncThrottle();
  const response = await overview(request('GET'));
  expect(response.status).toBe(200);
  return (await response.json()) as MemoryOverview;
}

async function progress(sceneId: string, baseRevision: number | null, actionIndex = 0) {
  const response = await putProgress(
    request(
      'PUT',
      { sceneId, actionIndex, baseRevision, observedAt: new Date().toISOString() },
      'https://zhiyu.test/api/study/progress/stage-a',
    ),
    params({ stageId: 'stage-a' }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { progress: { revision: number } }).progress.revision;
}

const types = (data: MemoryOverview) => data.records.map((record) => record.type).sort();

beforeEach(async () => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_MEMORY_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_CLASSMATES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_COMPANION_CHAT_ENABLED', '1');
  vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
  vi.stubEnv('AGENT_RUNTIME_ENABLED', 'true');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = OWNER;
  const db = new PGlite();
  await ensureDocumentSchema(db as never);
  await ensureStageMetaSchema(db as never);
  await ensureStudySchema(db as never);
  await ensureAgentSessionSchema(db as never);
  await ensureRuntimeSchema(db as never);
  database.pg = db;
  database.store = new PgAgentSessionStore(db as never, {
    withTransaction: (body) => db.transaction((tx) => body(tx as unknown as Queryable)),
  });
  await seed();
  vi.spyOn(gateway, 'complete');
  vi.spyOn(gateway, 'stream');
});

afterEach(async () => {
  // The rule-based Memory path never calls a model.
  expect(gateway.complete).not.toHaveBeenCalled();
  expect(gateway.stream).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await pg().close();
});

describe('Memory routes', () => {
  it('stay hidden unless the switch is on', async () => {
    expect((await (await capabilities()).json()).memory).toBe(true);
    vi.stubEnv('ZHIYU_STUDY_MEMORY_ENABLED', '');
    expect((await (await capabilities()).json()).memory).toBe(false);
    expect((await overview(request('GET'))).status).toBe(404);
    expect((await listPrefs(request('GET'))).status).toBe(404);
    // Progress still saves, without records.
    await progress('s1', null);
    expect((await pg().query('SELECT * FROM study_learning_events')).rows).toEqual([]);
  });

  it('projects progress, quiz and chat records by rule, with no mastery claim', async () => {
    let revision = await progress('s1', null);
    revision = await progress('s2', revision);
    revision = await progress('quiz', revision);
    // The end of the last page: watched to the end (a viewing record).
    await progress('quiz', revision, 1);
    await quizAttempt('quiz-attempt:1', { q1: 'B', q2: 'A' });
    const opened = await openChat(
      request('POST', { spaceId: 'space-a', question: '以后先举例子：导数是什么？' }),
      params({ classmateId: CM }),
    );
    expect(opened.status).toBe(202);

    const data = await readOverview();
    expect(types(data)).toEqual([
      'companion_question',
      'course_finished',
      'course_progressed',
      'course_progressed',
      'course_started',
      'quiz_graded',
      'quiz_submitted',
    ]);
    const graded = data.records.find((record) => record.type === 'quiz_graded')!;
    // The browser claimed 2/2; the server's answer key says 1/2.
    expect(graded.payload).toMatchObject({
      verification: 'server_checked',
      objective: { correct: 1, total: 2 },
    });
    const chat = data.records.find((record) => record.type === 'companion_question')!;
    expect(chat).toMatchObject({ spaceIds: ['space-a'], classmate: { id: CM, name: '小林' } });
    expect(data.records.find((record) => record.type === 'course_finished')).toMatchObject({
      course: { stageId: 'stage-a', title: '导数入门' },
      spaceIds: ['space-a'],
    });
    expect(JSON.stringify(data)).not.toMatch(/master/i);
    expect(data.recentState.all).toMatchObject({
      coursesViewed: 1,
      coursesFinished: 1,
      quizzesGraded: 1,
      objective: { correct: 1, total: 2 },
      companionQuestions: 1,
    });
    // Replaying adds nothing.
    const again = await readOverview();
    expect(again.records).toHaveLength(data.records.length);
    expect(again.sync.recorded).toBe(0);
  });

  it('keeps a deleted record deleted when projection runs again', async () => {
    await progress('s1', null);
    const data = await readOverview();
    const started = data.records.find((record) => record.type === 'course_started')!;
    const response = await deleteRecord(request('DELETE'), params({ seq: String(started.seq) }));
    expect(response.status).toBe(200);
    // Projection replays (inline and catch-up) but the source key is suppressed.
    await progress('s2', 1);
    const after = await readOverview();
    expect(types(after)).toEqual(['course_progressed']);
    const missing = await deleteRecord(request('DELETE'), params({ seq: String(started.seq) }));
    expect(missing.status).toBe(404);
  });

  it('stops projection and personalised reads while off, and skips the off period', async () => {
    await putPref(request('PUT', { key: 'example_order', value: 'example_first' }));
    const on = await resolveMemoryContext(pg() as never, OWNER, 'space-a');
    expect(on.state).toBe('on');
    expect(on.items.map((item) => item.ref)).toEqual(['pref:example_order@global', 'goal:space']);
    expect(on.block).toContain('先举一个具体例子');

    const off = await putControl(
      request('PUT', { spaceId: null, enabled: false, baseRevision: 0 }),
    );
    expect(off.status).toBe(200);
    expect(await resolveMemoryContext(pg() as never, OWNER, 'space-a')).toMatchObject({
      state: 'off',
      block: '',
      info: { state: 'off', refs: [] },
    });
    await progress('s1', null);
    expect((await readOverview()).records).toEqual([]);

    // A stale revision conflicts.
    expect(
      (await putControl(request('PUT', { spaceId: null, enabled: true, baseRevision: 0 }))).status,
    ).toBe(409);
    expect(
      (await putControl(request('PUT', { spaceId: null, enabled: true, baseRevision: 1 }))).status,
    ).toBe(200);
    // What happened while off is never recorded; new facts are.
    expect((await readOverview()).records).toEqual([]);
    await progress('s2', 1);
    expect(types(await readOverview())).toEqual(['course_progressed']);

    // Per subject: off for 高数 only.
    await putControl(request('PUT', { spaceId: 'space-a', enabled: false }));
    expect((await resolveMemoryContext(pg() as never, OWNER, 'space-a')).state).toBe('space_off');
    expect((await resolveMemoryContext(pg() as never, OWNER, 'space-c')).state).toBe('on');
    await progress('quiz', 2);
    expect(types(await readOverview())).toEqual(['course_progressed']);
    expect((await putControl(request('PUT', { spaceId: 'space-b', enabled: false }))).status).toBe(
      404,
    );
  });

  it('records facts saved before switching off, so turning back on loses nothing earlier', async () => {
    // A classroom quiz is caught up only on demand: nothing has projected it yet.
    await quizAttempt('quiz-attempt:before-off', { q1: 'B', q2: 'A' });
    expect(
      (await pg().query('SELECT count(*)::int AS n FROM study_learning_events')).rows[0],
    ).toEqual({ n: 0 });
    resetLearningEventSyncThrottle();
    expect((await putControl(request('PUT', { spaceId: null, enabled: false }))).status).toBe(200);
    expect((await putControl(request('PUT', { spaceId: null, enabled: true }))).status).toBe(200);
    expect(types(await readOverview())).toEqual(
      expect.arrayContaining(['quiz_submitted', 'quiz_graded']),
    );
  });

  it('edits preferences and facts explicitly, with suppression on delete', async () => {
    expect((await putPref(request('PUT', { key: 'mood', value: 'x' }))).status).toBe(400);
    expect((await putPref(request('PUT', { key: 'hint_mode', value: 'maybe' }))).status).toBe(400);
    expect(
      (await putPref(request('PUT', { key: 'hint_mode', value: 'direct', spaceId: 'space-b' })))
        .status,
    ).toBe(404);
    const confirmed = await putPref(
      request('PUT', {
        key: 'hint_mode',
        value: 'hint_first',
        spaceId: 'space-a',
        origin: 'confirmed_prompt',
        evidence: { sessionId: 's-1', excerpt: '以后先给提示' },
      }),
    );
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).preference).toMatchObject({
      origin: 'confirmed_prompt',
      spaceId: 'space-a',
      evidence: { excerpt: '以后先给提示' },
      revision: 1,
    });
    const deleted = await deletePref(
      request(
        'DELETE',
        undefined,
        'https://zhiyu.test/api/study/preferences?key=hint_mode&spaceId=space-a',
      ),
    );
    expect(deleted.status).toBe(200);
    await decline(request('POST', { key: 'example_order', value: 'definition_first' }));
    const prefs = await (await listPrefs(request('GET'))).json();
    expect(prefs.preferences).toEqual([]);
    expect(prefs.suppressedSuggestions.sort()).toEqual([
      'example_order=definition_first',
      'hint_mode=hint_first',
    ]);

    const created = await addFact(request('POST', { text: '我是高二学生', spaceId: null }));
    expect(created.status).toBe(201);
    const fact = (await created.json()).fact;
    expect(fact).toMatchObject({ origin: 'manual', revision: 1 });
    const patched = await patchFact(
      request('PATCH', { text: '我是高三学生', baseRevision: 1 }),
      params({ factId: fact.id }),
    );
    expect((await patched.json()).fact).toMatchObject({ text: '我是高三学生', revision: 2 });
    const stale = await patchFact(
      request('PATCH', { text: '旧', baseRevision: 1 }),
      params({ factId: fact.id }),
    );
    expect(stale.status).toBe(409);
    const context = await resolveMemoryContext(pg() as never, OWNER, 'space-c');
    expect(context.block).toContain('我是高三学生');
    expect((await deleteFact(request('DELETE'), params({ factId: fact.id }))).status).toBe(200);
    expect((await resolveMemoryContext(pg() as never, OWNER, 'space-c')).items).toEqual([]);
  });

  it('attaches corrections to records and clears raw quiz attempts only when asked', async () => {
    await quizAttempt('quiz-attempt:2', { q1: 'B', q2: 'D' });
    const data = await readOverview();
    const graded = data.records.find((record) => record.type === 'quiz_graded')!;
    const correction = await addFact(
      request('POST', { text: '这次是看了答案后做的', correctsKey: graded.sourceKey }),
    );
    expect(correction.status).toBe(201);
    expect(
      (await addFact(request('POST', { text: 'x', correctsKey: 'quiz:none:graded' }))).status,
    ).toBe(404);
    const corrected = await readOverview();
    expect(
      corrected.records.find((record) => record.sourceKey === graded.sourceKey)?.correction?.text,
    ).toBe('这次是看了答案后做的');
    // Corrections are notes on records, not facts injected into chats.
    expect((await resolveMemoryContext(pg() as never, OWNER, 'space-a')).block).not.toContain(
      '看了答案',
    );

    const cleared = await clear(request('POST', { records: true }));
    expect((await cleared.json()).cleared).toMatchObject({
      records: 2,
      facts: 1,
      rawQuizAttempts: 0,
    });
    expect((await readOverview()).records).toEqual([]);
    expect((await pg().query(`SELECT count(*)::int AS n FROM runtime_sessions`)).rows[0]).toEqual({
      n: 1,
    });
    await clear(request('POST', { rawQuizAttempts: true }));
    expect((await pg().query(`SELECT count(*)::int AS n FROM runtime_sessions`)).rows[0]).toEqual({
      n: 0,
    });
    expect((await clear(request('POST', {}))).status).toBe(400);
  });

  it('isolates accounts', async () => {
    await progress('s1', null);
    await putPref(request('PUT', { key: 'example_order', value: 'example_first' }));
    const mine = await readOverview();
    owner.id = OTHER;
    const theirs = await readOverview();
    expect(theirs.records).toEqual([]);
    expect(theirs.preferences).toEqual([]);
    expect(theirs.spaces.map((space) => space.spaceId)).toEqual(['space-b']);
    const seq = String(mine.records[0]!.seq);
    expect((await deleteRecord(request('DELETE'), params({ seq }))).status).toBe(404);
    expect(
      (await putPref(request('PUT', { key: 'hint_mode', value: 'direct', spaceId: 'space-a' })))
        .status,
    ).toBe(404);
    expect((await resolveMemoryContext(pg() as never, OTHER, 'space-b')).items).toEqual([]);
  });
});
