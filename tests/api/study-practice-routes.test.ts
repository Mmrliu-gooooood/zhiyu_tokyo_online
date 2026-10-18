/**
 * AI practice (learning plan B11) end to end on PGlite: hidden unless
 * switched on; a bank paper never calls a model; a mixed paper plans only its
 * gap (bank 8, target 10 → 2 new questions) and nothing runs without consent;
 * a job writes, checks and reviews in steps within its call cap, and only
 * what the review passes joins the bank as unverified `ai_generated`;
 * replies with more questions than asked, unknown citations, repeats and
 * review rejections are dropped with their reasons; a stopped job continues
 * only on request; repeated creates and publishes never make a second job
 * or paper; a changed bank part is refused; variants of a wrong question
 * offer hints and solutions that are recorded, so helped answers never count
 * as independent, and their answers join the wrong question's history;
 * another owner reaches nothing.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureSchema as ensureRuntimeSchema } from '@openmaic/storage/runtime/pg';

const owner = vi.hoisted(() => ({ id: 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
const database = vi.hoisted(() => ({ pg: null as unknown }));
const evidenceState = vi.hoisted(() => ({
  signature: 'keyword@1' as string | null,
  scope: [] as unknown[],
  evidence: [] as unknown[],
}));

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
    modelString: 'platform:zhiyu-default-text',
    source: 'platform',
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    credentialReady: true,
    funding: { kind: 'operator' },
  })),
}));
// Material retrieval needs the extension-backed index (not in PGlite): a fixed scope and passages.
vi.mock('@/lib/server/study/practice/evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/study/practice/evidence')>();
  return {
    ...actual,
    retrievalSignature: vi.fn(async () => evidenceState.signature),
    practiceScope: vi.fn(async () => (evidenceState.signature ? evidenceState.scope : [])),
    paperEvidence: vi.fn(async () => evidenceState.evidence),
    variantEvidence: vi.fn(async (_db: unknown, _owner: string, _scope: unknown, question) => [
      actual.originalEvidence(question as never),
      ...evidenceState.evidence.slice(0, 1),
    ]),
  };
});

import { gateway } from '@/lib/model-gateway';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { resetWrongbookSyncThrottle } from '@/lib/server/study/wrongbook/service';
import { REVIEW_SYSTEM_PROMPT } from '@/lib/study/practice/generation';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import { GET as listBank, POST as createQuestion } from '@/app/api/study/question-bank/route';
import { POST as imports } from '@/app/api/study/question-bank/imports/route';
import { POST as preview } from '@/app/api/study/exams/preview/route';
import { POST as publish } from '@/app/api/study/papers/route';
import { POST as start } from '@/app/api/study/papers/[paperId]/attempts/route';
import { GET as getAttempt } from '@/app/api/study/attempts/[attemptId]/route';
import { POST as submit } from '@/app/api/study/attempts/[attemptId]/submit/route';
import { POST as assist } from '@/app/api/study/attempts/[attemptId]/assist/route';
import { POST as createJob } from '@/app/api/study/practice/jobs/route';
import { GET as getJob } from '@/app/api/study/practice/jobs/[jobId]/route';
import { POST as runJob } from '@/app/api/study/practice/jobs/[jobId]/run/route';
import { POST as cancelJob } from '@/app/api/study/practice/jobs/[jobId]/cancel/route';
import { POST as continueJob } from '@/app/api/study/practice/jobs/[jobId]/continue/route';
import { POST as publishJob } from '@/app/api/study/practice/jobs/[jobId]/paper/route';
import { GET as listWrong } from '@/app/api/study/wrongbook/route';
import { POST as syncWrong } from '@/app/api/study/wrongbook/sync/route';
import { GET as getWrong } from '@/app/api/study/wrongbook/[itemId]/route';
import type { AttemptView, PaperSummary } from '@/lib/study/assessments/contracts';
import type { PracticePreview } from '@/lib/study/practice/client';
import type { PracticeJobView } from '@/lib/study/practice/contracts';
import type { QuestionListResult } from '@/lib/study/questions/contracts';
import type { WrongbookPage, WrongItemDetail } from '@/lib/study/wrongbook/contracts';

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

const SCOPE = [
  {
    indexId: 'idx-1',
    materialId: 'mat-1',
    title: '导数讲义',
    versionId: 'ver-1',
    versionNo: 1,
    isCurrent: true,
    artifactId: 'art-1',
  },
];
const EVIDENCE = [1, 2].map((n) => ({
  id: `E${n}`,
  kind: 'material',
  text:
    n === 1
      ? '导数是函数在一点处的瞬时变化率，几何上是切线的斜率。'
      : "常见函数的导数：$(x^n)'=nx^{n-1}$，$(e^x)'=e^x$。",
  materialId: 'mat-1',
  versionId: 'ver-1',
  versionNo: 1,
  artifactId: 'art-1',
  page: n + 2,
  blockId: `b${n}`,
  title: '导数讲义',
  contentHash: `h${n}`,
}));

/** Distinct stems the fake model writes (never similar to each other or the bank). */
const STEMS = [
  '函数 $f(x)=x^2$ 在 $x=1$ 处的导数等于多少？',
  '曲线 $y=e^x$ 在点 $(0,1)$ 处切线的斜率是？',
  '下列关于导数几何意义的说法，哪一项正确？',
  '若某物体位移为 $s(t)=t^3$，则 $t=2$ 时的瞬时速度是？',
  "幂函数求导公式 $(x^n)'$ 的结果是？",
  "已知 $f'(x_0)>0$，函数在 $x_0$ 附近如何变化？",
  '指数函数 $e^x$ 的导函数是什么？',
  '切线斜率与导数之间是什么关系？',
];

function choice(index: number, ref = 'E1', extra: Record<string, unknown> = {}) {
  return {
    id: `n${index + 1}`,
    type: 'single',
    stem: STEMS[index],
    options: [
      { value: 'A', label: `选项甲${index}` },
      { value: 'B', label: `选项乙${index}` },
      { value: 'C', label: `选项丙${index}` },
    ],
    answer: ['A'],
    explanation: '由导数定义可得。',
    hint: '先回忆导数的定义。',
    concepts: ['导数'],
    difficulty: 2,
    points: 1,
    refs: [ref],
    ...extra,
  };
}

const reply = (questions: unknown[]) => JSON.stringify({ questions });

type Generation = string | ((data: Record<string, unknown>) => string);

/** A fake model: generation replies from the queue, reviews pass unless `review` says otherwise. */
function fakeModel(
  generations: Generation[],
  review: (question: Record<string, unknown>) => boolean = () => true,
) {
  vi.mocked(gateway.complete).mockImplementation(async (...call: unknown[]) => {
    const input = call[1] as {
      system: string;
      messages: Array<{ content: Array<{ text: string }> | string }>;
    };
    const message = input.messages[0]!;
    const text = typeof message.content === 'string' ? message.content : message.content[0]!.text;
    const data = JSON.parse(
      text.slice(text.indexOf('<data>') + 6, text.indexOf('</data>')),
    ) as Record<string, unknown>;
    const usage = { inputTokens: 200, outputTokens: 80 };
    if (input.system === REVIEW_SYSTEM_PROMPT) {
      const questions = data.questions as Array<Record<string, unknown>>;
      return {
        text: JSON.stringify({
          reviews: questions.map((question) => ({
            id: question.id,
            status: review(question) ? 'passed' : 'rejected',
            notes: review(question) ? '答案正确，有依据。' : '答案与证据不符。',
          })),
        }),
        usage,
      } as never;
    }
    const next = generations.shift();
    if (next === undefined) throw new Error('unexpected generation call');
    return { text: typeof next === 'function' ? next(data) : next, usage } as never;
  });
}

async function seed() {
  await pg().query(
    `INSERT INTO study_spaces (id, owner_id, name, status) VALUES
       ('space-a', $1, '高数', 'active'), ('space-b', $2, '英语', 'active')`,
    [OWNER, OTHER],
  );
}

async function importSingles(count: number, offset = 0) {
  const questions = Array.from({ length: count }, (_, index) => ({
    type: 'single',
    stem: `${index + offset + 1} + ${index + offset + 1} 等于几？`,
    options: [String((index + offset + 1) * 2), String((index + offset + 1) * 2 + 1)],
    answer: 'A',
    concepts: ['加法'],
    verified: true,
  }));
  return json<{ created: number }>(
    await imports(
      request('POST', '/api/study/question-bank/imports', {
        spaceId: 'space-a',
        commit: true,
        questions,
      }),
    ),
    200,
  );
}

const TEN = { spaceId: 'space-a', sections: [{ type: 'single', count: 10 }] };
const TWO = { spaceId: 'space-a', sections: [{ type: 'single', count: 2 }] };

async function practicePreview(blueprint: unknown, mode: 'mixed' | 'ai') {
  return (
    await json<{ preview: PracticePreview }>(
      await preview(request('POST', '/api/study/exams/preview', { blueprint, mode })),
      200,
    )
  ).preview;
}

async function newPaperJob(
  blueprint: Record<string, unknown>,
  mode: 'mixed' | 'ai',
  key: string,
  extra: Record<string, unknown> = {},
  status = 201,
  seed?: string,
) {
  const shownSeed = seed ?? (await practicePreview(blueprint, mode)).seed;
  return json<{ job: PracticeJobView; error?: string }>(
    await createJob(
      request('POST', '/api/study/practice/jobs', {
        kind: 'paper',
        blueprint: { ...blueprint, seed: shownSeed },
        mode,
        consent: true,
        idempotencyKey: key,
        ...extra,
      }),
    ),
    status,
  );
}

async function run(jobId: string) {
  return (
    await json<{ job: PracticeJobView; ran: boolean }>(
      await runJob(request('POST', `/api/study/practice/jobs/${jobId}/run`, {}), params({ jobId })),
      200,
    )
  ).job;
}

async function publishFromJob(
  jobId: string,
  body: Record<string, unknown>,
  status = 201,
): Promise<{ paper: PaperSummary; error?: string }> {
  return json(
    await publishJob(
      request('POST', `/api/study/practice/jobs/${jobId}/paper`, body),
      params({ jobId }),
    ),
    status,
  );
}

async function startAttempt(paperId: string) {
  return (
    await json<{ attempt: AttemptView }>(
      await start(request('POST', `/api/study/papers/${paperId}/attempts`), params({ paperId })),
      201,
    )
  ).attempt;
}

async function bank(query = '') {
  return json<QuestionListResult>(
    await listBank(request('GET', `/api/study/question-bank?spaceId=space-a${query}`)),
    200,
  );
}

beforeEach(async () => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_EXAMS_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_GRADING_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_WRONGBOOK_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_MEMORY_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_PRACTICE_ENABLED', '1');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = OWNER;
  evidenceState.signature = 'keyword@1';
  evidenceState.scope = SCOPE;
  evidenceState.evidence = EVIDENCE;
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

describe('AI practice', () => {
  it('stays hidden unless the switch is on, and a bank paper never calls a model', async () => {
    expect((await (await capabilities()).json()).practice).toBe(true);
    vi.stubEnv('ZHIYU_STUDY_PRACTICE_ENABLED', '');
    expect((await (await capabilities()).json()).practice).toBe(false);
    await importSingles(8);
    const refused = await json<{ field: string }>(
      await preview(request('POST', '/api/study/exams/preview', { blueprint: TEN, mode: 'mixed' })),
      400,
    );
    expect(refused.field).toBe('mode');
    const missing = await createJob(
      request('POST', '/api/study/practice/jobs', {
        kind: 'paper',
        idempotencyKey: 'key-00000001',
      }),
    );
    expect(missing.status).toBe(404);
    // A bank paper (B07) works as before and calls no model.
    const shown = (
      await json<{ preview: { seed: string; complete: boolean } }>(
        await preview(request('POST', '/api/study/exams/preview', { blueprint: TWO })),
        200,
      )
    ).preview;
    expect(shown.complete).toBe(true);
    await json(
      await publish(
        request('POST', '/api/study/papers', {
          blueprint: { ...TWO, seed: shown.seed },
          title: '题库卷',
          idempotencyKey: 'key-bank-0001',
        }),
      ),
      201,
    );
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('tops up only the gap of a mixed paper, after consent, and publishes it once', async () => {
    await importSingles(8);
    const shown = await practicePreview(TEN, 'mixed');
    expect(shown.items).toHaveLength(8);
    expect(shown.generation).toMatchObject({
      mode: 'mixed',
      targets: [{ type: 'single', count: 2 }],
      total: 2,
      maxCalls: 3,
      blocked: null,
      materials: [{ materialId: 'mat-1', versionId: 'ver-1', title: '导数讲义' }],
    });
    // No consent: no job and no model call.
    const refused = await json<{ error: string }>(
      await createJob(
        request('POST', '/api/study/practice/jobs', {
          kind: 'paper',
          blueprint: { ...TEN, seed: shown.seed },
          mode: 'mixed',
          idempotencyKey: 'key-mixed-001',
        }),
      ),
      422,
    );
    expect(refused.error).toBe('STUDY_PRACTICE_CONSENT_REQUIRED');

    const { job } = await newPaperJob(TEN, 'mixed', 'key-mixed-001', {}, 201, shown.seed);
    expect(job).toMatchObject({ status: 'pending', total: 2, callCap: 3, calls: 0, bankCount: 8 });
    expect(job.evidence.map((piece) => piece.id)).toEqual(['E1', 'E2']);
    expect(gateway.complete).not.toHaveBeenCalled();
    // The same request again returns the same job; the same key for another request is refused.
    expect((await newPaperJob(TEN, 'mixed', 'key-mixed-001', {}, 201, shown.seed)).job.id).toBe(
      job.id,
    );
    expect(
      (await newPaperJob(TEN, 'mixed', 'key-mixed-001', {}, 409, `${shown.seed}x`)).error,
    ).toBe('STUDY_IDEMPOTENCY_CONFLICT');

    fakeModel([reply([choice(0), choice(1, 'E2')])]);
    const done = await run(job.id);
    expect(done).toMatchObject({ status: 'completed', calls: 2 });
    expect(done.produced).toHaveLength(2);
    expect(done.produced[0]).toMatchObject({
      type: 'single',
      refs: ['E1'],
      hint: '先回忆导数的定义。',
    });
    expect(gateway.complete).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(gateway.complete).mock.calls;
    expect(calls.map((call) => (call[2] as { source: string }).source)).toEqual([
      'study-practice',
      'study-practice',
    ]);
    // Nothing more to do: another run calls nothing.
    await run(job.id);
    expect(gateway.complete).toHaveBeenCalledTimes(2);

    // The new questions joined the bank, unverified, marked as AI-written and AI-reviewed.
    const ai = await bank('&verification=unverified');
    expect(ai.questions).toHaveLength(2);
    expect(ai.questions[0]).toMatchObject({ origin: 'ai_generated', verification: 'unverified' });
    expect(ai.questions[0]!.source?.generation).toMatchObject({
      jobId: job.id,
      model: 'deepseek:deepseek-flash',
      review: 'ai_reviewed',
      refs: [expect.objectContaining({ materialId: 'mat-1', versionId: 'ver-1' })],
    });

    const first = await publishFromJob(job.id, { title: '混合卷', idempotencyKey: 'key-pub-0001' });
    expect(first.paper).toMatchObject({ itemCount: 10, title: '混合卷' });
    const mode = await pg().query<{ mode: string }>(
      'SELECT mode FROM study_exam_papers WHERE id = $1',
      [first.paper.id],
    );
    expect(mode.rows[0]!.mode).toBe('mixed');
    // A job feeds one paper: publishing again, even with another key, returns it.
    const again = await publishFromJob(
      job.id,
      { title: '混合卷', idempotencyKey: 'key-pub-0002' },
      200,
    );
    expect(again.paper.id).toBe(first.paper.id);
    const papers = await pg().query('SELECT id FROM study_exam_papers');
    expect(papers.rows).toHaveLength(1);

    // The attempt shows AI items with their source, but no hint or key before submission.
    const attempt = await startAttempt(first.paper.id);
    const aiItems = attempt.items.filter((item) => item.source.origin === 'ai_generated');
    expect(aiItems).toHaveLength(2);
    expect(aiItems[0]!.source.generation?.review).toBe('ai_reviewed');
    expect(JSON.stringify(attempt.items)).not.toContain('先回忆导数的定义');
    expect(attempt.assistance).toMatchObject({ practice: false });
    expect(attempt.assistance!.items['1']).toMatchObject({ novelty: 'new', hintAvailable: false });
    // Not a practice paper: no hints or solutions.
    const noHelp = await json<{ error: string }>(
      await assist(
        request('POST', `/api/study/attempts/${attempt.id}/assist`, {
          position: 9,
          level: 'solution',
        }),
        params({ attemptId: attempt.id }),
      ),
      409,
    );
    expect(noHelp.error).toBe('STUDY_PRACTICE_ASSIST_UNAVAILABLE');
  });

  it('rejects bad output by program and review, stops at its cap and continues only on request', async () => {
    await importSingles(2);
    const bankStem = (await bank()).questions[0]!;
    const { job } = await newPaperJob(TWO, 'ai', 'key-ai-00001');
    expect(job).toMatchObject({ total: 2, callCap: 3, bankCount: 0, mode: 'ai' });
    fakeModel([
      // More questions than asked: the whole reply is dropped (no review call).
      reply([choice(0), choice(1), choice(2)]),
    ]);
    let current = await run(job.id);
    expect(current).toMatchObject({ status: 'pending', calls: 1 });
    expect(current.produced).toHaveLength(0);
    expect(current.rejected).toEqual([
      expect.objectContaining({ stage: 'output', reason: 'too_many', note: '3/2' }),
    ]);

    fakeModel([
      reply([
        choice(3, 'E9'),
        // The same question as one in the bank.
        {
          id: 'dup',
          type: 'single',
          stem: bankStem.stem,
          options: bankStem.options,
          answer: bankStem.answer,
          refs: ['E1'],
        },
      ]),
    ]);
    current = await run(job.id);
    expect(current.status).toBe('stopped');
    expect(current.lastError).toBe('budget');
    expect(current.calls).toBe(2);
    expect(current.rejected.map((entry) => entry.reason)).toEqual([
      'too_many',
      'bad_refs',
      'duplicate',
    ]);
    expect(current.canContinue).toBe(true);
    // A stopped job does not run by itself.
    await run(job.id);
    expect(gateway.complete).toHaveBeenCalledTimes(2);

    const continued = await json<{ job: PracticeJobView }>(
      await continueJob(
        request('POST', `/api/study/practice/jobs/${job.id}/continue`),
        params({ jobId: job.id }),
      ),
      200,
    );
    expect(continued.job).toMatchObject({ status: 'pending', callCap: 6, continues: 1 });
    fakeModel([reply([choice(4), choice(5)])], (question) => question.stem !== STEMS[5]);
    current = await run(job.id);
    expect(current.produced.map((question) => question.stem)).toEqual([STEMS[4]]);
    expect(current.rejected.at(-1)).toMatchObject({
      stage: 'review',
      reason: 'review_rejected',
      note: '答案与证据不符。',
    });
    expect(current).toMatchObject({ status: 'pending', calls: 4 });
    // Not JSON at all, and no allowance left for a repair: stopped at the cap.
    fakeModel(['我先想想。']);
    current = await run(job.id);
    expect(current).toMatchObject({ status: 'stopped', calls: 5, lastError: 'budget' });
    expect(current.rejected.at(-1)).toMatchObject({ stage: 'output', reason: 'not_json' });
    expect(current.canContinue).toBe(true);

    // One of two: publishing needs consent to fewer questions.
    const short = await publishFromJob(job.id, { idempotencyKey: 'key-pub-short' }, 409);
    expect(short.error).toBe('STUDY_PRACTICE_INCOMPLETE');
    const paper = await publishFromJob(job.id, {
      idempotencyKey: 'key-pub-short2',
      acceptShort: true,
    });
    expect(paper.paper).toMatchObject({ itemCount: 1, title: '高数 · AI 练习' });
    // Published: no more continuing.
    expect(
      (
        await continueJob(
          request('POST', `/api/study/practice/jobs/${job.id}/continue`),
          params({ jobId: job.id }),
        )
      ).status,
    ).toBe(409);
  });

  it('cancels without storing a running step, refuses a changed bank part, and stays private', async () => {
    await importSingles(8);
    const { job } = await newPaperJob(TEN, 'mixed', 'key-cancel-1');
    const cancelled = await json<{ job: PracticeJobView }>(
      await cancelJob(
        request('POST', `/api/study/practice/jobs/${job.id}/cancel`),
        params({ jobId: job.id }),
      ),
      200,
    );
    expect(cancelled.job.status).toBe('cancelled');
    await run(job.id);
    expect(gateway.complete).not.toHaveBeenCalled();
    expect((await publishFromJob(job.id, { idempotencyKey: 'key-pub-c001' }, 409)).error).toBe(
      'STUDY_PRACTICE_JOB_STATE',
    );

    const { job: second } = await newPaperJob(TEN, 'mixed', 'key-change-1');
    fakeModel([reply([choice(0), choice(1)])]);
    expect((await run(second.id)).status).toBe('completed');
    // The bank gains a question the blueprint would now pick: the planned bank part changed.
    await json(
      await createQuestion(
        request('POST', '/api/study/question-bank', {
          spaceId: 'space-a',
          question: { type: 'single', stem: '9 + 9 等于几？', options: ['18', '19'], answer: 'A' },
          verified: true,
          stageId: null,
        }),
      ),
      201,
    );
    expect((await publishFromJob(second.id, { idempotencyKey: 'key-pub-ch01' }, 409)).error).toBe(
      'STUDY_PRACTICE_BANK_CHANGED',
    );

    owner.id = OTHER;
    expect(
      (
        await getJob(
          request('GET', `/api/study/practice/jobs/${second.id}`),
          params({ jobId: second.id }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await runJob(
          request('POST', `/api/study/practice/jobs/${second.id}/run`, {}),
          params({
            jobId: second.id,
          }),
        )
      ).status,
    ).toBe(404);
  });

  it('plans nothing without materials', async () => {
    await importSingles(2);
    evidenceState.scope = [];
    const shown = await practicePreview(TWO, 'ai');
    expect(shown.generation.blocked).toBe('no_materials');
    expect((await newPaperJob(TWO, 'ai', 'key-nomat-01', {}, 422)).error).toBe(
      'STUDY_PRACTICE_NO_EVIDENCE',
    );
    evidenceState.signature = null;
    expect((await practicePreview(TWO, 'ai')).generation.blocked).toBe('retrieval_unavailable');
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('writes variants of a wrong question with recorded hints and feeds their answers back', async () => {
    await importSingles(2);
    // Answer a bank paper wrongly so the wrong-answer book has an item.
    const shown = (
      await json<{ preview: { seed: string } }>(
        await preview(request('POST', '/api/study/exams/preview', { blueprint: TWO })),
        200,
      )
    ).preview;
    const paper = (
      await json<{ paper: PaperSummary }>(
        await publish(
          request('POST', '/api/study/papers', {
            blueprint: { ...TWO, seed: shown.seed },
            title: '加法小测',
            idempotencyKey: 'key-bank-wrong',
          }),
        ),
        201,
      )
    ).paper;
    const attempt = await startAttempt(paper.id);
    await json(
      await submit(
        request('POST', `/api/study/attempts/${attempt.id}/submit`, {
          submitKey: 'submit-wrong-1',
          answers: { '1': ['B'], '2': ['A'] },
          baseRevision: attempt.revision,
        }),
        params({ attemptId: attempt.id }),
      ),
      200,
    );
    await json(
      await syncWrong(
        request('POST', '/api/study/wrongbook/sync', { spaceId: 'space-a', force: true }),
      ),
      200,
    );
    const page = await json<WrongbookPage>(
      await listWrong(request('GET', '/api/study/wrongbook?spaceId=space-a')),
      200,
    );
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    const original = item.question.stem;

    const created = await json<{ job: PracticeJobView }>(
      await createJob(
        request('POST', '/api/study/practice/jobs', {
          kind: 'variant',
          wrongItemId: item.id,
          count: 3,
          consent: true,
          idempotencyKey: 'key-variant-1',
        }),
      ),
      201,
    );
    expect(created.job).toMatchObject({
      kind: 'variant',
      total: 3,
      callCap: 3,
      wrongItemId: item.id,
    });
    expect(created.job.evidence[0]).toMatchObject({ id: 'Q0', kind: 'question' });
    fakeModel([
      (data) => {
        // The original question is in the evidence; a copy of it is refused.
        const evidence = data.evidence as Array<{ id: string; text: string }>;
        expect(evidence[0]!.text).toContain(original);
        return reply([
          choice(0, 'Q0', { concepts: ['随便'] }),
          { ...choice(1, 'Q0'), stem: original },
          choice(2, 'E1'),
        ]);
      },
    ]);
    const job = await run(created.job.id);
    // Two of three written; the cap (one batch) is used up.
    expect(job).toMatchObject({ status: 'stopped', lastError: 'budget', calls: 2 });
    expect(job.produced.map((question) => question.stem)).toEqual([STEMS[0], STEMS[2]]);
    // Variants keep the original's knowledge points.
    expect(job.produced[0]!.concepts).toEqual(['加法']);
    expect(job.rejected.map((entry) => entry.reason)).toEqual(['near_duplicate']);

    const practice = await publishFromJob(job.id, {
      idempotencyKey: 'key-pub-var1',
      acceptShort: true,
    });
    expect(practice.paper.title.startsWith('变式练习')).toBe(true);
    let sheet = await startAttempt(practice.paper.id);
    expect(sheet.assistance).toMatchObject({ practice: true });
    expect(sheet.assistance!.items['1']).toMatchObject({
      novelty: 'new',
      level: 'unassisted',
      hintAvailable: true,
      hint: null,
      solution: null,
    });
    const help = async (position: number, level: 'hint' | 'solution') =>
      (
        await json<{ attempt: AttemptView }>(
          await assist(
            request('POST', `/api/study/attempts/${sheet.id}/assist`, { position, level }),
            params({ attemptId: sheet.id }),
          ),
          200,
        )
      ).attempt;
    sheet = await help(1, 'hint');
    expect(sheet.assistance!.items['1']).toMatchObject({
      level: 'hinted',
      hint: '先回忆导数的定义。',
    });
    sheet = await help(2, 'solution');
    expect(sheet.assistance!.items['2']).toMatchObject({ level: 'solution_seen' });
    expect(sheet.assistance!.items['2']!.solution).toMatchObject({ answer: ['A'] });
    await json(
      await submit(
        request('POST', `/api/study/attempts/${sheet.id}/submit`, {
          submitKey: 'submit-variant-1',
          answers: { '1': ['A'], '2': ['A'] },
          baseRevision: sheet.revision,
        }),
        params({ attemptId: sheet.id }),
      ),
      200,
    );
    const report = await json<{ attempt: AttemptView }>(
      await getAttempt(
        request('GET', `/api/study/attempts/${sheet.id}`),
        params({ attemptId: sheet.id }),
      ),
      200,
    );
    expect(report.attempt.report!.summary.correct).toBe(2);
    // Help after submission is refused.
    expect(
      (
        await assist(
          request('POST', `/api/study/attempts/${sheet.id}/assist`, {
            position: 1,
            level: 'solution',
          }),
          params({ attemptId: sheet.id }),
        )
      ).status,
    ).toBe(409);

    // Both answers join the wrong question's history — right, but helped, so not independent.
    resetWrongbookSyncThrottle();
    await json(
      await syncWrong(
        request('POST', '/api/study/wrongbook/sync', { spaceId: 'space-a', force: true }),
      ),
      200,
    );
    const { item: detail } = await json<{ item: WrongItemDetail }>(
      await getWrong(
        request('GET', `/api/study/wrongbook/${item.id}`),
        params({ itemId: item.id }),
      ),
      200,
    );
    const variants = detail.occurrences.filter((occurrence) => occurrence.origin.practice?.variant);
    expect(variants).toHaveLength(2);
    expect(variants.map((occurrence) => occurrence.origin.practice)).toEqual(
      expect.arrayContaining([
        { novelty: 'new', assistance: 'hinted', variant: true, independent: false },
        { novelty: 'new', assistance: 'solution_seen', variant: true, independent: false },
      ]),
    );
    expect(detail.question.stem).toBe(original);
    const after = await json<WrongbookPage>(
      await listWrong(request('GET', '/api/study/wrongbook?spaceId=space-a')),
      200,
    );
    expect(after.items).toHaveLength(1);

    // A retake of the same practice paper: every question is a repeat now.
    const retake = await startAttempt(practice.paper.id);
    expect(retake.assistance!.items['1']!.novelty).toBe('seen');

    // The learning record: the paper with its practice counts, and each help shown.
    const events = await pg().query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM study_learning_events WHERE owner_id = $1 ORDER BY seq`,
      [OWNER],
    );
    const graded = events.rows.filter((row) => row.event_type === 'exam_graded');
    expect(graded.at(-1)!.payload.independence).toEqual({ independent: 0, helped: 2, repeated: 0 });
    expect(
      events.rows.filter((row) => row.event_type === 'hint_used').map((row) => row.payload.level),
    ).toEqual(expect.arrayContaining([1, 2]));
  });
});
