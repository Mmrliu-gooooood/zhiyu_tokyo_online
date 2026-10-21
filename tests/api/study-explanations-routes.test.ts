/**
 * Explanations on request (learning plan B13) end to end on PGlite: hidden
 * unless switched on; asking calls no model; a run writes text, a whiteboard
 * (elements checked by the whiteboard validator) or an interactive page with
 * the student's model within the form's call cap; the same inputs reuse the
 * saved explanation; a failed run can be retried within the limit and a
 * cancelled one stores nothing; the student's explanation preferences go in
 * only with Memory on; a full course is attached once (a second course is
 * refused while the first is in the subject); another owner reaches nothing.
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
    modelString: 'platform:zhiyu-default-text',
    source: 'platform',
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    credentialReady: true,
    funding: { kind: 'operator' },
  })),
}));
// The classroom's interactive-page generator: one call through the given aiCall.
vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateWidgetContent: vi.fn(
    async (
      outline: { title: string; widgetType: string },
      aiCall: (system: string, user: string) => Promise<string>,
    ) => {
      const html = await aiCall('page system', `page for ${outline.title}`);
      return { html, widgetType: outline.widgetType, widgetConfig: undefined };
    },
  ),
}));

import { gateway } from '@/lib/model-gateway';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { resetWrongbookSyncThrottle } from '@/lib/server/study/wrongbook/service';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import { POST as imports } from '@/app/api/study/question-bank/imports/route';
import { POST as preview } from '@/app/api/study/exams/preview/route';
import { POST as publish } from '@/app/api/study/papers/route';
import { POST as start } from '@/app/api/study/papers/[paperId]/attempts/route';
import { POST as submit } from '@/app/api/study/attempts/[attemptId]/submit/route';
import { POST as syncWrongbook } from '@/app/api/study/wrongbook/sync/route';
import { PUT as putPreference } from '@/app/api/study/preferences/route';
import { PUT as memoryControls } from '@/app/api/study/memory/controls/route';
import { DELETE as unlinkCourse } from '@/app/api/study/spaces/[spaceId]/courses/[stageId]/route';
import {
  GET as listExplanations,
  POST as createExplanation,
} from '@/app/api/study/explanations/route';
import {
  DELETE as deleteExplanation,
  GET as getExplanation,
} from '@/app/api/study/explanations/[explanationId]/route';
import { POST as runExplanation } from '@/app/api/study/explanations/[explanationId]/run/route';
import { POST as cancelExplanation } from '@/app/api/study/explanations/[explanationId]/cancel/route';
import { POST as retryExplanation } from '@/app/api/study/explanations/[explanationId]/retry/route';
import { POST as attachCourse } from '@/app/api/study/explanations/[explanationId]/course/route';
import type { AttemptView, PaperSummary } from '@/lib/study/assessments/contracts';
import type {
  ExplanationCreateResult,
  ExplanationDetail,
  ExplanationSummary,
} from '@/lib/study/explanations/contracts';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB = '0b3c5f0e-6f8e-4d55-9c1a-2f4b8e7d1a90';
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

async function seed() {
  await pg().query(
    `INSERT INTO study_spaces (id, owner_id, name, status, timezone) VALUES
       ('space-a', $1, '高数', 'active', 'Asia/Shanghai'), ('space-b', $2, '英语', 'active', NULL)`,
    [OWNER, OTHER],
  );
  for (const stage of ['stage-x', 'stage-y']) {
    await pg().query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
       VALUES ($1, '导数专项', 0, 0, $2, $3)`,
      [stage, OWNER, JSON.stringify({ id: stage })],
    );
    await pg().query(`INSERT INTO stage_meta (stage_id, owner_id) VALUES ($1, $2)`, [stage, OWNER]);
  }
}

/** A bank paper with the x² question answered wrong; returns its wrong item id. */
async function wrongItem(): Promise<string> {
  const questions = [
    {
      stem: "$(x^2)'$ 等于？",
      options: ['$2x$', '$x$'],
      concepts: ['导数'],
      explanation: "幂函数求导：$(x^n)'=nx^{n-1}$。",
    },
    { stem: "$(\\sin x)'$ 等于？", options: ['$\\cos x$', '$-\\cos x$'], concepts: ['导数'] },
  ].map((question) => ({ type: 'single', answer: 'A', verified: true, ...question }));
  await json(
    await imports(
      request('POST', '/api/study/question-bank/imports', {
        spaceId: 'space-a',
        commit: true,
        questions,
      }),
    ),
    200,
  );
  const blueprint = { spaceId: 'space-a', sections: [{ type: 'single', count: 2 }] };
  const shown = (
    await json<{ preview: { seed: string } }>(
      await preview(request('POST', '/api/study/exams/preview', { blueprint })),
      200,
    )
  ).preview;
  const paper = (
    await json<{ paper: PaperSummary }>(
      await publish(
        request('POST', '/api/study/papers', {
          blueprint: { ...blueprint, seed: shown.seed },
          title: '导数小测',
          idempotencyKey: 'key-paper-0001',
        }),
      ),
      201,
    )
  ).paper;
  const attempt = (
    await json<{ attempt: AttemptView }>(
      await start(
        request('POST', `/api/study/papers/${paper.id}/attempts`),
        params({ paperId: paper.id }),
      ),
      201,
    )
  ).attempt;
  const answers: Record<string, string[]> = {};
  for (const item of attempt.items) {
    answers[String(item.position)] = item.stem.includes('x^2') ? ['B'] : ['A'];
  }
  await json(
    await submit(
      request('POST', `/api/study/attempts/${attempt.id}/submit`, {
        submitKey: 'submit-0001',
        answers,
        baseRevision: attempt.revision,
      }),
      params({ attemptId: attempt.id }),
    ),
    200,
  );
  resetWrongbookSyncThrottle();
  await json(
    await syncWrongbook(request('POST', '/api/study/wrongbook/sync', { spaceId: 'space-a' })),
    200,
  );
  const items = await pg().query<{ id: string }>(
    'SELECT id FROM study_wrong_items WHERE owner_id = $1',
    [OWNER],
  );
  expect(items.rows).toHaveLength(1);
  return items.rows[0]!.id;
}

let keyNo = 0;
async function create(body: Record<string, unknown>, status = 201) {
  keyNo += 1;
  return json<ExplanationCreateResult & { error?: string }>(
    await createExplanation(
      request('POST', '/api/study/explanations', {
        consent: true,
        idempotencyKey: `explain-key-${String(keyNo).padStart(4, '0')}`,
        ...body,
      }),
    ),
    status,
  );
}

async function run(id: string) {
  return json<{ explanation: ExplanationDetail; ran: boolean }>(
    await runExplanation(
      request('POST', `/api/study/explanations/${id}/run`, {}),
      params({ explanationId: id }),
    ),
    200,
  );
}

function fakeModel(...replies: string[]) {
  const queue = [...replies];
  vi.mocked(gateway.complete).mockImplementation(async () => {
    const text = queue.shift();
    if (text === undefined) throw new Error('unexpected model call');
    return { text, usage: { inputTokens: 500, outputTokens: 200 } } as never;
  });
}

const TEXT_REPLY = JSON.stringify({
  title: '幂函数求导',
  diagnosis: '你选了 $x$，把指数直接去掉了，没有把指数乘到前面。',
  steps: [
    "幂函数求导公式是 $(x^n)'=nx^{n-1}$ [M1]。",
    "这里 $n=2$，所以 $(x^2)'=2x^{1}=2x$ [M9]。",
  ],
  takeaway: '先把指数乘到前面，再把指数减一。',
  check: { question: "$(x^3)'$ 等于？", answer: '$3x^2$' },
  refs: ['M1', 'M9'],
});

beforeEach(async () => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_EXAMS_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_WRONGBOOK_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_MEMORY_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_PRACTICE_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_EXPLANATIONS_ENABLED', '1');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = OWNER;
  keyNo = 0;
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

describe('explanations on request', () => {
  it('stays hidden unless switched on', async () => {
    expect((await (await capabilities()).json()).explanations).toBe(true);
    vi.stubEnv('ZHIYU_STUDY_EXPLANATIONS_ENABLED', '');
    expect((await (await capabilities()).json()).explanations).toBe(false);
    const hidden = await listExplanations(
      request('GET', '/api/study/explanations?spaceId=space-a'),
    );
    expect(hidden.status).toBe(404);
  });

  it('writes a text explanation once and reuses it for the same inputs', async () => {
    const itemId = await wrongItem();
    const refused = await create({ itemId, format: 'text', consent: false }, 422);
    expect(refused.error).toBe('STUDY_EXPLANATION_INVALID');
    const asked = await create({ itemId, format: 'text' });
    expect(asked.reused).toBe(false);
    expect(asked.explanation).toMatchObject({ status: 'pending', format: 'text', callCap: 2 });
    expect(gateway.complete).not.toHaveBeenCalled();

    fakeModel(TEXT_REPLY);
    const { explanation, ran } = await run(asked.explanation.id);
    expect(ran).toBe(true);
    expect(explanation).toMatchObject({ status: 'ready', title: '幂函数求导', calls: 1 });
    expect(explanation.content).toMatchObject({ kind: 'text', check: { answer: '$3x^2$' } });
    // No passages were given (no materials): every citation mark is dropped.
    expect(explanation.content?.refs).toEqual([]);
    expect(JSON.stringify(explanation.content)).not.toContain('[M');
    const call = vi.mocked(gateway.complete).mock.calls[0]!;
    expect((call[2] as { source: string }).source).toBe('study-explanation');
    const message = (call[1] as { messages: Array<{ content: unknown }> }).messages[0]!;
    expect(JSON.stringify(message)).toContain('x^2');
    expect(JSON.stringify(message)).toContain('studentAnswer');

    // Running again calls nothing; asking again for the same inputs returns it.
    expect((await run(asked.explanation.id)).ran).toBe(false);
    const again = await create({ itemId, format: 'text' });
    expect(again).toMatchObject({ reused: true, explanation: { id: asked.explanation.id } });
    const fresh = await create({ itemId, format: 'text', fresh: true });
    expect(fresh.reused).toBe(false);
    expect(fresh.explanation.id).not.toBe(asked.explanation.id);
    expect(gateway.complete).toHaveBeenCalledTimes(1);

    const listed = await json<{ explanations: ExplanationSummary[] }>(
      await listExplanations(
        request('GET', `/api/study/explanations?spaceId=space-a&itemId=${itemId}`),
      ),
      200,
    );
    expect(listed.explanations.map((entry) => entry.status).sort()).toEqual(['pending', 'ready']);
    expect(
      listed.explanations.every((entry) => !('content' in entry) || entry.content === null),
    ).toBe(true);
  });

  it('draws a whiteboard of checked elements and builds an interactive page', async () => {
    const itemId = await wrongItem();
    const board = await create({ itemId, format: 'whiteboard' });
    fakeModel(
      JSON.stringify({
        title: '白板：幂函数求导',
        steps: [
          {
            say: '先写题目和你的答案。',
            draw: [
              { type: 'text', x: 40, y: 30, w: 600, h: 40, text: '求 (x²)′', size: 24 },
              { type: 'latex', x: 900, y: 600, w: 300, h: 70, latex: "(x^2)' = x" },
              { type: 'latex', x: 40, y: 100, latex: '\\frac{1}{' },
            ],
          },
          {
            say: '正确做法：把指数乘到前面。',
            draw: [
              { type: 'latex', x: 40, y: 200, w: 360, h: 70, latex: "(x^2)'=2x" },
              { type: 'rect', x: 30, y: 190, w: 380, h: 90 },
              { type: 'arrow', x1: 420, y1: 235, x2: 560, y2: 235 },
              { type: 'video', x: 0, y: 0 },
            ],
          },
        ],
        takeaway: '指数乘到前面，再减一。',
        refs: [],
      }),
    );
    const drawn = (await run(board.explanation.id)).explanation;
    expect(drawn.status).toBe('ready');
    if (drawn.content?.kind !== 'whiteboard') throw new Error('expected a whiteboard');
    const [first, second] = drawn.content.steps;
    // The broken formula and the unknown shape were dropped; the rest kept on the board.
    expect(first!.elements.map((element) => element.type)).toEqual(['text', 'latex']);
    expect(second!.elements.map((element) => element.type)).toEqual(['latex', 'shape', 'line']);
    const moved = first!.elements[1]!;
    expect(moved.left + moved.width).toBeLessThanOrEqual(1000);
    expect(moved.top + (moved as { height: number }).height).toBeLessThanOrEqual(562.5);
    expect(first!.elements[0]).toMatchObject({ content: expect.stringContaining('求 (x²)′') });

    const page = await create({ itemId, format: 'interactive' });
    expect(page.explanation.callCap).toBe(3);
    fakeModel(
      JSON.stringify({
        title: '拖动指数看导数',
        intro: '拖动滑块改变 n，观察导数的系数。',
        widgetType: 'simulation',
        concept: '幂函数求导',
        description: '一个滑块控制 n，页面显示 x^n 和它的导数 n x^(n-1) 的图像。',
        keyPoints: ['系数等于原来的指数'],
        variables: ['n（1–5）'],
        refs: [],
      }),
      '<!DOCTYPE html><html><head></head><body><input type="range"></body></html>',
    );
    const built = (await run(page.explanation.id)).explanation;
    expect(built).toMatchObject({ status: 'ready', calls: 2, title: '拖动指数看导数' });
    expect(built.content).toMatchObject({ kind: 'interactive', widgetType: 'simulation' });
    expect((built.content as { html: string }).html).toContain('type="range"');
  });

  it('fails without saving bad output, retries within the limit and stores nothing when cancelled', async () => {
    const itemId = await wrongItem();
    const asked = await create({ itemId, format: 'text' });
    fakeModel('不是 JSON', '还是不是 JSON');
    const failed = (await run(asked.explanation.id)).explanation;
    expect(failed).toMatchObject({
      status: 'failed',
      lastError: 'invalid_output',
      calls: 2,
      canRetry: true,
      content: null,
    });

    const retried = await json<{ explanation: ExplanationDetail }>(
      await retryExplanation(
        request('POST', `/api/study/explanations/${asked.explanation.id}/retry`),
        params({ explanationId: asked.explanation.id }),
      ),
      200,
    );
    expect(retried.explanation).toMatchObject({ status: 'pending', attempts: 2 });
    const cancelled = await json<{ explanation: ExplanationDetail }>(
      await cancelExplanation(
        request('POST', `/api/study/explanations/${asked.explanation.id}/cancel`),
        params({ explanationId: asked.explanation.id }),
      ),
      200,
    );
    expect(cancelled.explanation.status).toBe('cancelled');
    expect((await run(asked.explanation.id)).ran).toBe(false);
    expect(gateway.complete).toHaveBeenCalledTimes(2);

    // A failed explanation is not reused: asking again starts a new one.
    const again = await create({ itemId, format: 'text' });
    expect(again.reused).toBe(false);

    const removed = await deleteExplanation(
      request('DELETE', `/api/study/explanations/${asked.explanation.id}`),
      params({ explanationId: asked.explanation.id }),
    );
    expect(removed.status).toBe(200);
    const gone = await getExplanation(
      request('GET', `/api/study/explanations/${asked.explanation.id}`),
      params({ explanationId: asked.explanation.id }),
    );
    expect(gone.status).toBe(404);
  });

  it('uses the explanation preferences only with Memory on', async () => {
    const itemId = await wrongItem();
    await json(
      await putPreference(
        request('PUT', '/api/study/preferences', {
          key: 'example_order',
          value: 'example_first',
          spaceId: null,
        }),
      ),
      200,
    );
    const withPrefs = await create({ itemId, format: 'text' });
    expect(withPrefs.explanation.preferencesUsed).toBe(true);
    fakeModel(TEXT_REPLY);
    await run(withPrefs.explanation.id);
    const message = JSON.stringify(vi.mocked(gateway.complete).mock.calls[0]![1]);
    expect(message).toContain('concrete example');

    await json(
      await memoryControls(
        request('PUT', '/api/study/memory/controls', { spaceId: 'space-a', enabled: false }),
      ),
      200,
    );
    // Different inputs (no preferences): not the saved one.
    const without = await create({ itemId, format: 'text' });
    expect(without).toMatchObject({ reused: false, explanation: { preferencesUsed: false } });
  });

  it('adds the course of a course explanation to the subject once', async () => {
    const itemId = await wrongItem();
    const course = await create({ itemId, format: 'course', media: { image: true } });
    expect(course.explanation).toMatchObject({
      status: 'pending',
      format: 'course',
      media: { image: true, tts: false, video: false },
      callCap: 0,
    });
    expect(course.explanation.requirement).toContain('导数');
    // Formulas as plain text (LaTeX in a request tends to come back as source in course titles).
    expect(course.explanation.requirement).toContain("(x²)'");
    expect(course.explanation.requirement).not.toContain('$');
    // Nothing for the page to run: course generation writes the course.
    expect((await run(course.explanation.id)).ran).toBe(false);
    // Asking again while it waits returns it.
    expect(await create({ itemId, format: 'course' })).toMatchObject({
      reused: true,
      explanation: { id: course.explanation.id },
    });

    const attach = async (body: Record<string, unknown>, status = 200) =>
      json<{ explanation: ExplanationDetail; created: boolean; error?: string }>(
        await attachCourse(
          request('POST', `/api/study/explanations/${course.explanation.id}/course`, body),
          params({ explanationId: course.explanation.id }),
        ),
        status,
      );
    expect((await attach({ jobId: JOB })).explanation.jobId).toBe(JOB);
    expect((await attach({ jobId: 'not-a-job' }, 422)).error).toBe('STUDY_EXPLANATION_INVALID');
    expect((await attach({ stageId: 'stage-none' }, 404)).error).toBe('STUDY_COURSE_NOT_FOUND');
    const linked = await attach({ stageId: 'stage-x' });
    expect(linked).toMatchObject({
      created: true,
      explanation: { status: 'ready', stageId: 'stage-x' },
    });
    expect((await attach({ stageId: 'stage-x' })).created).toBe(false);
    expect((await attach({ stageId: 'stage-y' }, 409)).error).toBe(
      'STUDY_EXPLANATION_COURSE_EXISTS',
    );
    const courses = await pg().query<{ stage_id: string }>(
      `SELECT stage_id FROM study_space_courses WHERE owner_id = $1 AND space_id = 'space-a'`,
      [OWNER],
    );
    expect(courses.rows.map((row) => row.stage_id)).toEqual(['stage-x']);

    // Removed from the subject, the explanation may bring another course.
    await unlinkCourse(
      request('DELETE', '/api/study/spaces/space-a/courses/stage-x'),
      params({ spaceId: 'space-a', stageId: 'stage-x' }),
    );
    expect((await attach({ stageId: 'stage-y' })).explanation.stageId).toBe('stage-y');
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('reaches nothing of another owner', async () => {
    const itemId = await wrongItem();
    const asked = await create({ itemId, format: 'text' });
    owner.id = OTHER;
    const read = await getExplanation(
      request('GET', `/api/study/explanations/${asked.explanation.id}`),
      params({ explanationId: asked.explanation.id }),
    );
    expect(read.status).toBe(404);
    const ran = await runExplanation(
      request('POST', `/api/study/explanations/${asked.explanation.id}/run`, {}),
      params({ explanationId: asked.explanation.id }),
    );
    expect(ran.status).toBe(404);
    const listed = await listExplanations(
      request('GET', '/api/study/explanations?spaceId=space-a'),
    );
    expect(listed.status).toBe(404);
    const stolen = await create({ itemId, format: 'text' }, 404);
    expect(stolen.error).toBe('STUDY_WRONG_ITEM_NOT_FOUND');
    expect(gateway.complete).not.toHaveBeenCalled();
  });
});
