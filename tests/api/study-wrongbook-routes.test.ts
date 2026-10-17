/**
 * The wrong-answer book (learning plan B10) end to end on PGlite: hidden
 * unless switched on; a sync collects mistakes from a submitted paper, a
 * classroom quiz and a learning check of a course in the space; waiting open
 * items stay out until graded; replaying writes nothing; a later attempt at
 * the same bank question adds history instead of overwriting; filters and
 * facets; marking and archiving with revision checks; "look back" offers a
 * classroom page only while its content is unchanged; unlinking the course
 * hides its items; deleting a paper removes its rows; clearing raw quiz
 * attempts removes theirs; another owner reaches nothing; a classmate chat
 * gets a bounded server-made copy of the question.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureSchema as ensureRuntimeSchema } from '@openmaic/storage/runtime/pg';

const owner = vi.hoisted(() => ({ id: 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
const database = vi.hoisted(() => ({ pg: null as unknown }));

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
vi.mock('@/lib/server/heavy-task-admission/independent-request', () => ({
  runIndependentHeavyTaskRequest: (
    _req: Request,
    _kind: string,
    body: (signal: AbortSignal) => Promise<Response>,
  ) => body(new AbortController().signal),
}));
vi.mock('@/lib/model-gateway', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/model-gateway')>()),
  resolveRequestBinding: vi.fn(async () => ({
    modelString: 'test:grade-model',
    credentialReady: true,
    funding: { kind: 'operator' },
  })),
}));

import { gateway } from '@/lib/model-gateway';
import { createLearningContentSnapshot } from '@/lib/learning/content-snapshot';
import {
  LEARNING_PROMPT_VERSION,
  LEARNING_SCHEMA_VERSION,
  LEARNING_SCORING_VERSION,
  type LearningCheckPayloadV1,
} from '@/lib/learning/contracts';
import { createQuizQuestionSnapshot, quizContentRevision } from '@/lib/quiz/attempt-schema';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { getOwnerBoundStageAccessDb } from '@/lib/server/stage-access';
import { deleteQuizOccurrences } from '@/lib/server/study/wrongbook/repository';
import {
  resetWrongbookSyncThrottle,
  wrongItemChatContext,
} from '@/lib/server/study/wrongbook/service';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import { POST as imports } from '@/app/api/study/question-bank/imports/route';
import { POST as preview } from '@/app/api/study/exams/preview/route';
import { POST as publish } from '@/app/api/study/papers/route';
import { DELETE as deletePaper } from '@/app/api/study/papers/[paperId]/route';
import { POST as start } from '@/app/api/study/papers/[paperId]/attempts/route';
import { POST as submit } from '@/app/api/study/attempts/[attemptId]/submit/route';
import { POST as grade } from '@/app/api/study/attempts/[attemptId]/grading/route';
import { GET as list } from '@/app/api/study/wrongbook/route';
import { POST as sync } from '@/app/api/study/wrongbook/sync/route';
import { GET as getItem, PATCH as patchItem } from '@/app/api/study/wrongbook/[itemId]/route';
import type { AttemptView, PaperSummary } from '@/lib/study/assessments/contracts';
import type { PaperPreview } from '@/lib/study/questions/blueprint';
import type { StudyDb } from '@/lib/server/study/spaces/repository';
import type {
  WrongItemDetail,
  WrongbookPage,
  WrongbookSyncResult,
} from '@/lib/study/wrongbook/contracts';
import type { QuizQuestion, Scene } from '@/lib/types/stage';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const request = (method: string, url: string, body?: unknown) =>
  new NextRequest(`https://zhiyu.test${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as never;
const pg = () => database.pg as PGlite;

async function json<T>(response: Response, status: number): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

const QUESTIONS = [
  {
    type: 'single',
    stem: '2+2=?',
    options: ['4', '5'],
    answer: 'A',
    concepts: ['加法'],
    verified: true,
  },
  {
    type: 'single',
    stem: '3+3=?',
    options: ['6', '7'],
    answer: 'A',
    concepts: ['加法'],
    verified: true,
  },
  {
    type: 'single',
    stem: '3×3=?',
    options: ['9', '6'],
    answer: 'A',
    concepts: ['乘法'],
    verified: true,
  },
  {
    type: 'short_answer',
    stem: '简述导数的几何意义。',
    referenceAnswer: '函数图像在该点处切线的斜率。',
    points: 4,
    rubric: [
      { text: '说出切线', points: 2 },
      { text: '说出斜率', points: 2 },
    ],
    concepts: ['导数'],
    verified: true,
  },
];

const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: 'q1',
    type: 'single',
    question: '导数的几何意义是？',
    options: [
      { value: 'A', label: '切线斜率' },
      { value: 'B', label: '曲线下面积' },
    ],
    answer: ['A'],
    analysis: '导数是切线斜率。',
    points: 1,
  } as QuizQuestion,
  {
    id: 'q2',
    type: 'single',
    question: '常数的导数是？',
    options: [
      { value: 'A', label: '0' },
      { value: 'B', label: '1' },
    ],
    answer: ['A'],
    points: 1,
  } as QuizQuestion,
];

const SLIDE: Scene = {
  id: 's1',
  stageId: 'stage-a',
  type: 'slide',
  title: '导数定义',
  order: 0,
  content: {
    type: 'slide',
    canvas: {
      id: 'c',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {},
      elements: [{ id: 't', type: 'text', content: '<p>导数是切线的斜率</p>' }],
    },
  },
} as unknown as Scene;

const QUIZ_SCENE = {
  id: 'quiz',
  stageId: 'stage-a',
  type: 'quiz',
  title: '随堂小测',
  order: 1,
  content: { type: 'quiz', questions: QUIZ_QUESTIONS },
} as unknown as Scene;

async function seed() {
  await pg().query(
    `INSERT INTO study_spaces (id, owner_id, name, status) VALUES
       ('space-a', $1, '高数', 'active'), ('space-b', $2, '英语', 'active')`,
    [OWNER, OTHER],
  );
  await pg().query(
    `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
     VALUES ('stage-a', '导数入门', 0, 0, $1, '{"id":"stage-a"}')`,
    [OWNER],
  );
  await pg().query(`INSERT INTO stage_meta (stage_id, owner_id) VALUES ('stage-a', $1)`, [OWNER]);
  await pg().query(
    `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES
       ('stage-a', 's1', 0, $1::jsonb), ('stage-a', 'quiz', 1, $2::jsonb)`,
    [JSON.stringify(SLIDE), JSON.stringify(QUIZ_SCENE)],
  );
  await pg().query(
    `INSERT INTO study_space_courses (owner_id, space_id, stage_id) VALUES ($1, 'space-a', 'stage-a')`,
    [OWNER],
  );
}

async function runtimeRecord(
  sessionId: string,
  kind: 'quizAttempt' | 'learningCheck',
  sceneId: string | null,
  payloads: unknown[],
) {
  const at = (index: number) =>
    new Date(Date.parse('2026-10-16T08:00:00.000Z') + index * 1000).toISOString();
  await pg().query(
    `INSERT INTO runtime_sessions (id, stage_id, learner_key, kind, status, created_at, updated_at, data)
     VALUES ($1, 'stage-a', $2, $3, 'active', $4, $5, '{}'::jsonb)`,
    [sessionId, OWNER, kind, at(0), at(payloads.length)],
  );
  for (const [index, payload] of payloads.entries()) {
    await pg().query(
      `INSERT INTO runtime_records (id, session_id, seq, scene_id, created_at, data)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [`${sessionId}-r${index}`, sessionId, index, sceneId, at(index), JSON.stringify({ payload })],
    );
  }
}

function quizPayload(phase: 'draft' | 'submitted', graded: boolean) {
  const snapshot = createQuizQuestionSnapshot(QUIZ_QUESTIONS);
  const fact = (questionId: string, earned: number) => ({
    status: 'graded',
    result: {
      questionId,
      correct: earned > 0,
      status: earned > 0 ? 'correct' : 'incorrect',
      earned,
    },
    provenance: {
      ruleVersion: 'quiz-grading-v1',
      basis: 'answer-key',
      gradedAt: '2026-10-16T08:00:01.000Z',
    },
  });
  return {
    payloadVersion: 2,
    phase,
    questionSnapshot: snapshot,
    contentRevision: quizContentRevision(snapshot),
    answers: { q1: 'B', q2: 'A' },
    grading: graded ? { q1: fact('q1', 0), q2: fact('q2', 1) } : {},
    results: [],
    gradeProvenance: {},
  };
}

async function checkPayload(): Promise<LearningCheckPayloadV1> {
  const snapshot = await createLearningContentSnapshot({
    courseTitle: '导数入门',
    scenes: [SLIDE],
  });
  return {
    payloadVersion: 1,
    identity: {
      checkId: 'check-1',
      attemptId: 'check-attempt-1',
      source: 'course_check',
      requestId: 'req-1',
    },
    source: snapshot,
    questionSet: {
      questionSetId: 'set-1',
      scoringVersion: LEARNING_SCORING_VERSION,
      coverageNote: '覆盖第一页',
      questions: [
        {
          id: 'c1',
          type: 'short_answer',
          prompt: '用自己的话解释导数。',
          scoringGuide: '提到切线斜率或变化率',
          explanation: '导数描述变化率，几何上是切线斜率。',
          maxScore: 2,
          conceptId: '导数定义',
          sourceRefs: [snapshot.fragments[0]!.id],
        },
      ],
    },
    lifecycle: {
      phase: 'reviewed',
      answers: { c1: '变化' },
      grading: { c1: { status: 'graded', score: 1, comment: '只说了一半', basis: 'model' } },
      startedAt: '2026-10-16T09:00:00.000Z',
      submittedAt: '2026-10-16T09:05:00.000Z',
      reviewedAt: '2026-10-16T09:06:00.000Z',
    },
    generation: {
      promptVersion: LEARNING_PROMPT_VERSION,
      schemaVersion: LEARNING_SCHEMA_VERSION,
      model: 'deepseek:deepseek-flash',
      calls: 1,
      usage: 'unknown',
      review: { status: 'passed', notes: [] },
    },
  };
}

async function importQuestions() {
  const document = { format: 'zhiyu-question-bank', version: 1, questions: QUESTIONS };
  const previewed = await json<{ items: Array<{ content: unknown; verified: boolean }> }>(
    await imports(
      request('POST', '/api/study/question-bank/imports', { spaceId: 'space-a', document }),
    ),
    200,
  );
  await json(
    await imports(
      request('POST', '/api/study/question-bank/imports', {
        spaceId: 'space-a',
        commit: true,
        questions: previewed.items.map((item) => ({
          ...(item.content as object),
          verified: item.verified,
        })),
      }),
    ),
    200,
  );
}

const BLUEPRINT = {
  spaceId: 'space-a',
  sections: [
    { type: 'single', count: 3 },
    { type: 'short_answer', count: 1 },
  ],
};

async function publishPaper(key: string): Promise<PaperSummary> {
  const shown = await json<{ preview: PaperPreview }>(
    await preview(request('POST', '/api/study/exams/preview', { blueprint: BLUEPRINT })),
    200,
  );
  return (
    await json<{ paper: PaperSummary }>(
      await publish(
        request('POST', '/api/study/papers', {
          blueprint: { ...BLUEPRINT, seed: shown.preview.seed },
          title: `练习 ${key}`,
          idempotencyKey: key,
        }),
      ),
      201,
    )
  ).paper;
}

/** Answer by stem: `null` leaves an item blank. */
async function answerPaper(paperId: string, key: string, byStem: Record<string, unknown>) {
  const attempt = (
    await json<{ attempt: AttemptView }>(
      await start(request('POST', `/api/study/papers/${paperId}/attempts`), params({ paperId })),
      201,
    )
  ).attempt;
  const answers: Record<string, unknown> = {};
  for (const item of attempt.items) {
    const value = byStem[item.stem];
    if (value !== null && value !== undefined) answers[String(item.position)] = value;
  }
  await json(
    await submit(
      request('POST', `/api/study/attempts/${attempt.id}/submit`, {
        submitKey: `submit-${key}`,
        answers,
        baseRevision: 1,
      }),
      params({ attemptId: attempt.id }),
    ),
    200,
  );
  return attempt.id;
}

async function syncNow(spaceId = 'space-a', status = 200) {
  return json<WrongbookSyncResult & { error?: string }>(
    await sync(request('POST', '/api/study/wrongbook/sync', { spaceId, force: true })),
    status,
  );
}

async function listItems(query = '') {
  return json<WrongbookPage>(
    await list(request('GET', `/api/study/wrongbook?spaceId=space-a${query}`)),
    200,
  );
}

async function detail(itemId: string, status = 200) {
  return json<{ item: WrongItemDetail; error?: string }>(
    await getItem(request('GET', `/api/study/wrongbook/${itemId}`), params({ itemId })),
    status,
  );
}

function byStem(page: WrongbookPage, stem: string) {
  return page.items.find((item) => item.question.stem === stem);
}

beforeEach(async () => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_EXAMS_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_GRADING_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_WRONGBOOK_ENABLED', '1');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = OWNER;
  resetWrongbookSyncThrottle();
  const db = new PGlite();
  await ensureDocumentSchema(db as never);
  await ensureStageMetaSchema(db as never);
  await ensureRuntimeSchema(db as never);
  await ensureStudySchema(db as never);
  database.pg = db;
  await seed();
  vi.spyOn(gateway, 'complete');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await pg().close();
});

describe('wrong-answer book', () => {
  it('stays hidden unless the switch is on', async () => {
    expect((await (await capabilities()).json()).wrongbook).toBe(true);
    vi.stubEnv('ZHIYU_STUDY_WRONGBOOK_ENABLED', '');
    expect((await (await capabilities()).json()).wrongbook).toBe(false);
    expect(
      (await sync(request('POST', '/api/study/wrongbook/sync', { spaceId: 'space-a' }))).status,
    ).toBe(404);
    expect((await list(request('GET', '/api/study/wrongbook?spaceId=space-a'))).status).toBe(404);
  });

  it('collects mistakes from papers, quizzes and learning checks, keeps history and never duplicates', async () => {
    await importQuestions();
    const paper = await publishPaper('paper-key-1');
    const first = await answerPaper(paper.id, 'one', {
      '2+2=?': ['B'],
      '3+3=?': ['A'],
      '3×3=?': null,
      '简述导数的几何意义。': { text: '是切线。' },
    });
    // Classroom: a graded quiz (one wrong), a draft, a legacy v1 attempt and a learning check.
    await runtimeRecord('quiz-1', 'quizAttempt', 'quiz', [
      quizPayload('draft', false),
      quizPayload('submitted', true),
    ]);
    await runtimeRecord('quiz-draft', 'quizAttempt', 'quiz', [quizPayload('draft', false)]);
    await runtimeRecord('quiz-old', 'quizAttempt', 'quiz', [
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'B' } },
    ]);
    await runtimeRecord('check-attempt-1', 'learningCheck', null, [await checkPayload()]);

    const synced = await syncNow();
    expect(synced).toMatchObject({ ran: true, failed: [], legacy: 1, full: false });
    let page = await listItems();
    // The open item waits for grading: not wrong yet.
    expect(page.items.map((item) => item.question.stem).sort()).toEqual(
      ['2+2=?', '3×3=?', '导数的几何意义是？', '用自己的话解释导数。'].sort(),
    );
    expect(page.facets.sources).toEqual({ exam_attempt: 2, quiz_attempt: 1, learning_check: 1 });
    expect(byStem(page, '3×3=?')!.latest.outcome).toBe('unanswered');
    expect(gateway.complete).not.toHaveBeenCalled();

    // Grade the open item: half marks.
    vi.mocked(gateway.complete).mockImplementation(async (...call: unknown[]) => {
      const input = call[1] as { messages: Array<{ content: Array<{ text: string }> | string }> };
      const message = input.messages[0]!;
      const text = typeof message.content === 'string' ? message.content : message.content[0]!.text;
      const data = JSON.parse(
        text.replace(/^<grading_input_json>|<\/grading_input_json>[\s\S]*$/g, ''),
      );
      return {
        text: JSON.stringify({
          criteria: data.criteria.map(
            (criterion: { id: string; points: number }, index: number) => ({
              id: criterion.id,
              awarded: index === 0 ? criterion.points : 0,
              comment: index === 0 ? '说出了切线' : '没有说斜率',
            }),
          ),
          feedback: '还要说明斜率。',
          shortcomings: ['缺少“斜率”'],
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
      } as never;
    });
    await json(
      await grade(
        request('POST', `/api/study/attempts/${first}/grading`, {}),
        params({ attemptId: first }),
      ),
      200,
    );
    expect((await syncNow()).written).toBeGreaterThan(0);
    page = await listItems();
    const open = byStem(page, '简述导数的几何意义。')!;
    expect(open).toMatchObject({
      sourceType: 'exam_attempt',
      concepts: ['导数'],
      latest: { outcome: 'partial', earned: 2, points: 4 },
    });
    const openDetail = (await detail(open.id)).item;
    expect(openDetail.occurrences[0]!.grading).toMatchObject({
      by: 'server',
      method: 'rubric',
      feedback: '还要说明斜率。',
      criteria: [
        { text: '说出切线', awarded: 2, by: 'model' },
        { text: '说出斜率', awarded: 0, by: 'model' },
      ],
    });
    expect(openDetail.lookBack).toEqual([
      { kind: 'paper', attemptId: first, title: '练习 paper-key-1' },
    ]);

    // Replaying changes nothing.
    const counts = await pg().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM study_wrong_occurrences',
    );
    expect((await syncNow()).written).toBe(0);
    expect(
      (await pg().query<{ n: number }>('SELECT count(*)::int AS n FROM study_wrong_occurrences'))
        .rows[0]!.n,
    ).toBe(counts.rows[0]!.n);

    // A second attempt: 2+2 now right (history, not overwrite), 3+3 now wrong (new item).
    await answerPaper(paper.id, 'two', {
      '2+2=?': ['A'],
      '3+3=?': ['B'],
      '3×3=?': ['A'],
      '简述导数的几何意义。': null,
    });
    await syncNow();
    page = await listItems();
    const addition = byStem(page, '2+2=?')!;
    expect(addition).toMatchObject({
      wrongCount: 1,
      attemptCount: 2,
      latest: { outcome: 'correct' },
    });
    expect(byStem(page, '3+3=?')).toMatchObject({ wrongCount: 1, attemptCount: 1 });
    // The open item left blank the second time is a second mistake.
    expect(byStem(page, '简述导数的几何意义。')).toMatchObject({
      wrongCount: 2,
      latest: { outcome: 'unanswered' },
    });
    const history = (await detail(addition.id)).item.occurrences;
    expect(history.map((occurrence) => occurrence.outcome)).toEqual(['correct', 'incorrect']);
    expect(history[1]!.response).toEqual({ choices: ['B'] });

    // Filters and facets.
    expect(
      (await listItems('&source=quiz_attempt')).items.map((item) => item.question.stem),
    ).toEqual(['导数的几何意义是？']);
    expect(
      (await listItems('&concept=加法')).items.map((item) => item.question.stem).sort(),
    ).toEqual(['2+2=?', '3+3=?']);
    expect((await listItems('&concept=')).items.map((item) => item.question.stem)).toEqual([
      '导数的几何意义是？',
    ]);
    expect(page.facets.concepts.map((concept) => concept.name).sort()).toEqual(
      ['乘法', '加法', '导数', '导数定义'].sort(),
    );
    expect(
      (await list(request('GET', '/api/study/wrongbook?spaceId=space-a&state=nope'))).status,
    ).toBe(400);
  });

  it('marks and archives with revision checks', async () => {
    await runtimeRecord('quiz-1', 'quizAttempt', 'quiz', [quizPayload('submitted', true)]);
    await syncNow();
    const [item] = (await listItems()).items;
    const marked = await json<{ revision: number; reviewState: string; archived: boolean }>(
      await patchItem(
        request('PATCH', `/api/study/wrongbook/${item!.id}`, {
          revision: item!.revision,
          reviewState: 'to_review',
        }),
        params({ itemId: item!.id }),
      ),
      200,
    );
    expect(marked).toEqual({
      revision: item!.revision + 1,
      reviewState: 'to_review',
      archived: false,
    });
    expect((await listItems('&state=to_review')).items).toHaveLength(1);
    const stale = await json<{ error: string; current: { revision: number } }>(
      await patchItem(
        request('PATCH', `/api/study/wrongbook/${item!.id}`, {
          revision: item!.revision,
          archived: true,
        }),
        params({ itemId: item!.id }),
      ),
      409,
    );
    expect(stale).toMatchObject({
      error: 'STUDY_REVISION_CONFLICT',
      current: { revision: marked.revision },
    });
    await json(
      await patchItem(
        request('PATCH', `/api/study/wrongbook/${item!.id}`, {
          revision: marked.revision,
          archived: true,
        }),
        params({ itemId: item!.id }),
      ),
      200,
    );
    const page = await listItems();
    expect(page.items).toHaveLength(0);
    expect(page.facets.states).toEqual({ active: 0, toReview: 0, archived: 1 });
    expect((await listItems('&state=archived')).items).toHaveLength(1);
    expect(
      (
        await patchItem(
          request('PATCH', `/api/study/wrongbook/${item!.id}`, {
            revision: 9,
            reviewState: 'maybe',
          }),
          params({ itemId: item!.id }),
        )
      ).status,
    ).toBe(400);
  });

  it('offers a classroom page only while it is unchanged, and hides items of an unlinked course', async () => {
    await runtimeRecord('quiz-1', 'quizAttempt', 'quiz', [quizPayload('submitted', true)]);
    await runtimeRecord('check-attempt-1', 'learningCheck', null, [await checkPayload()]);
    await syncNow();
    const page = await listItems();
    const quizItem = byStem(page, '导数的几何意义是？')!;
    const checkItem = byStem(page, '用自己的话解释导数。')!;
    expect((await detail(quizItem.id)).item.lookBack).toEqual([
      {
        kind: 'scene',
        stageId: 'stage-a',
        sceneId: 'quiz',
        courseTitle: '导数入门',
        sceneTitle: '随堂小测',
      },
    ]);
    expect((await detail(checkItem.id)).item.lookBack).toEqual([
      {
        kind: 'scene',
        stageId: 'stage-a',
        sceneId: 's1',
        courseTitle: '导数入门',
        sceneTitle: '导数定义',
      },
    ]);

    // The course is edited: same scene ids, different content.
    const editedQuiz = {
      ...QUIZ_SCENE,
      content: { type: 'quiz', questions: [{ ...QUIZ_QUESTIONS[0]!, question: '改过的题' }] },
    };
    const editedSlide = JSON.parse(
      JSON.stringify(SLIDE).replace('导数是切线的斜率', '导数是变化率'),
    );
    await pg().query(
      `UPDATE document_scenes SET data = $1::jsonb WHERE stage_id = 'stage-a' AND id = 'quiz'`,
      [JSON.stringify(editedQuiz)],
    );
    await pg().query(
      `UPDATE document_scenes SET data = $1::jsonb WHERE stage_id = 'stage-a' AND id = 's1'`,
      [JSON.stringify(editedSlide)],
    );
    const changed = (await detail(quizItem.id)).item;
    expect(changed.lookBack).toEqual([
      {
        kind: 'scene_changed',
        stageId: 'stage-a',
        courseTitle: '导数入门',
        sceneTitle: '随堂小测',
      },
    ]);
    // The frozen question is still the original.
    expect(changed.occurrences[0]!.question.stem).toBe('导数的几何意义是？');
    expect((await detail(checkItem.id)).item.lookBack[0]).toMatchObject({ kind: 'scene_changed' });
    await pg().query(`DELETE FROM document_scenes WHERE stage_id = 'stage-a' AND id = 'quiz'`);
    expect((await detail(quizItem.id)).item.lookBack).toEqual([
      { kind: 'scene_missing', courseTitle: '导数入门' },
    ]);

    // Unlinking the course hides its items (nothing is deleted).
    await pg().query(`DELETE FROM study_space_courses WHERE stage_id = 'stage-a'`);
    expect((await listItems()).items).toHaveLength(0);
    expect((await detail(quizItem.id, 404)).error).toBe('STUDY_WRONG_ITEM_NOT_FOUND');
    expect((await pg().query('SELECT 1 FROM study_wrong_items')).rows).toHaveLength(2);
  });

  it('drops rows of a deleted paper and of cleared quiz attempts', async () => {
    await importQuestions();
    const paper = await publishPaper('paper-key-2');
    await answerPaper(paper.id, 'one', {
      '2+2=?': ['B'],
      '3+3=?': ['B'],
      '3×3=?': ['B'],
      '简述导数的几何意义。': null,
    });
    await runtimeRecord('quiz-1', 'quizAttempt', 'quiz', [quizPayload('submitted', true)]);
    await syncNow();
    expect((await listItems()).total).toBe(5);
    await json(
      await deletePaper(
        request('DELETE', `/api/study/papers/${paper.id}`),
        params({ paperId: paper.id }),
      ),
      200,
    );
    expect((await listItems()).items.map((item) => item.sourceType)).toEqual(['quiz_attempt']);
    const db = (await getOwnerBoundStageAccessDb(OWNER)) as unknown as StudyDb;
    await db.withTransaction((tx) => deleteQuizOccurrences(tx, OWNER));
    expect((await listItems()).total).toBe(0);
  });

  it('builds a bounded chat context on the server and keeps other owners out', async () => {
    await runtimeRecord('quiz-1', 'quizAttempt', 'quiz', [quizPayload('submitted', true)]);
    await syncNow();
    const [item] = (await listItems()).items;
    const db = (await getOwnerBoundStageAccessDb(OWNER)) as unknown as StudyDb;
    const { context, stageId, sceneId } = await wrongItemChatContext(
      db,
      OWNER,
      'space-a',
      item!.id,
    );
    expect(context).toMatchObject({
      itemId: item!.id,
      sourceType: 'quiz_attempt',
      questionType: '单选题',
      question: '导数的几何意义是？',
      options: ['A. 切线斜率', 'B. 曲线下面积'],
      studentAnswer: 'B. 曲线下面积',
      correctAnswer: 'A. 切线斜率',
      explanation: '导数是切线斜率。',
      where: '课堂《导数入门》的小测',
    });
    expect(context.grading).toContain('得分 0/1');
    expect({ stageId, sceneId }).toEqual({ stageId: 'stage-a', sceneId: 'quiz' });
    await expect(wrongItemChatContext(db, OWNER, 'space-b', item!.id)).rejects.toMatchObject({
      code: 'STUDY_WRONG_ITEM_NOT_FOUND',
    });

    owner.id = OTHER;
    const otherDb = (await getOwnerBoundStageAccessDb(OTHER)) as unknown as StudyDb;
    await expect(wrongItemChatContext(otherDb, OTHER, 'space-a', item!.id)).rejects.toMatchObject({
      code: 'STUDY_WRONG_ITEM_NOT_FOUND',
    });
    expect((await syncNow('space-a', 404)).error).toBe('STUDY_SPACE_NOT_FOUND');
    expect((await list(request('GET', '/api/study/wrongbook?spaceId=space-a'))).status).toBe(404);
    expect((await detail(item!.id, 404)).error).toBe('STUDY_WRONG_ITEM_NOT_FOUND');
    expect(
      (
        await patchItem(
          request('PATCH', `/api/study/wrongbook/${item!.id}`, { revision: 1, archived: true }),
          params({ itemId: item!.id }),
        )
      ).status,
    ).toBe(404);
    // The other owner's own (empty) space syncs nothing from A's course.
    expect(await syncNow('space-b')).toMatchObject({ ran: true, written: 0 });
  });
});
