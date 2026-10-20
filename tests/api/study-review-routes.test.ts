/**
 * Review tasks and Memory summaries (learning plan B12) end to end on PGlite:
 * hidden unless switched on; a wrong paper answer becomes a review task with
 * its reasons and no model call; redoing the bank question is a practice
 * paper whose right answer is practice, never independent; reviewed /
 * postponed / skipped marks are kept with a revision check and recorded as
 * learning records; the exam date and scope move and order tasks; with
 * Memory off nothing is scheduled by rule and no summary is written; a
 * summary is written only when records changed, never again for the same
 * records or after the student deleted it, and goes when records are
 * deleted; a chat turn receives it; another owner reaches nothing.
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

import { gateway } from '@/lib/model-gateway';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { resolveMemoryContext } from '@/lib/server/study/memory/context';
import { resetLearningEventSyncThrottle } from '@/lib/server/study/memory/projector';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { resetWrongbookSyncThrottle } from '@/lib/server/study/wrongbook/service';
import { SUMMARY_SYSTEM_PROMPT } from '@/lib/study/memory/summary';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import { POST as imports } from '@/app/api/study/question-bank/imports/route';
import { POST as preview } from '@/app/api/study/exams/preview/route';
import { POST as publish } from '@/app/api/study/papers/route';
import { POST as start } from '@/app/api/study/papers/[paperId]/attempts/route';
import { GET as getAttempt } from '@/app/api/study/attempts/[attemptId]/route';
import { POST as submit } from '@/app/api/study/attempts/[attemptId]/submit/route';
import { GET as getWrong } from '@/app/api/study/wrongbook/[itemId]/route';
import { GET as reviewList } from '@/app/api/study/review-tasks/route';
import { POST as reviewAct } from '@/app/api/study/review-tasks/[itemId]/route';
import { POST as reviewRedo } from '@/app/api/study/review-tasks/[itemId]/redo/route';
import { PUT as reviewSettings } from '@/app/api/study/review-tasks/settings/route';
import {
  DELETE as deleteSummaryRoute,
  POST as refreshSummaryRoute,
} from '@/app/api/study/memory/summaries/route';
import { PUT as memoryControls } from '@/app/api/study/memory/controls/route';
import { DELETE as deleteRecord } from '@/app/api/study/memory/records/[seq]/route';
import type { AttemptView, PaperSummary } from '@/lib/study/assessments/contracts';
import type { ReviewOverview, ReviewTaskView } from '@/lib/study/review/contracts';
import { addDays } from '@/lib/study/review/plan';
import type { WrongItemDetail } from '@/lib/study/wrongbook/contracts';

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

async function seed() {
  await pg().query(
    `INSERT INTO study_spaces (id, owner_id, name, status, timezone) VALUES
       ('space-a', $1, '高数', 'active', 'Asia/Shanghai'), ('space-b', $2, '英语', 'active', NULL)`,
    [OWNER, OTHER],
  );
}

async function importQuestions() {
  const questions = [
    { stem: '$(x^2)\'$ 等于？', options: ['$2x$', '$x$'], concepts: ['导数'] },
    { stem: '$(\\sin x)\'$ 等于？', options: ['$\\cos x$', '$-\\cos x$'], concepts: ['切线'] },
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
}

async function startAttempt(paperId: string) {
  return (
    await json<{ attempt: AttemptView }>(
      await start(request('POST', `/api/study/papers/${paperId}/attempts`), params({ paperId })),
      201,
    )
  ).attempt;
}

async function submitAnswers(attempt: AttemptView, answers: Record<string, string[]>, key: string) {
  await json(
    await submit(
      request('POST', `/api/study/attempts/${attempt.id}/submit`, {
        submitKey: key,
        answers,
        baseRevision: attempt.revision,
      }),
      params({ attemptId: attempt.id }),
    ),
    200,
  );
}

/** A two-question bank paper with the 导数 question answered wrong, `daysAgo` days back. */
async function wrongPaper(daysAgo = 3) {
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
  const attempt = await startAttempt(paper.id);
  // The paper's order is seeded: answer the 导数 question (x²) wrong, the other right.
  const wrongFirst: Record<string, string[]> = {};
  for (const item of attempt.items) {
    wrongFirst[String(item.position)] = item.stem.includes('x^2') ? ['B'] : ['A'];
  }
  await submitAnswers(attempt, wrongFirst, 'submit-0001');
  await pg().query(
    `UPDATE study_exam_attempts SET submitted_at = submitted_at - make_interval(days => $1)`,
    [daysAgo],
  );
  await pg().query(
    `UPDATE study_learning_events SET occurred_at = occurred_at - make_interval(days => $1)`,
    [daysAgo],
  );
  return attempt;
}

async function overview(): Promise<ReviewOverview> {
  resetWrongbookSyncThrottle();
  return (
    await json<{ overview: ReviewOverview }>(
      await reviewList(request('GET', '/api/study/review-tasks?spaceId=space-a&tz=Asia/Shanghai')),
      200,
    )
  ).overview;
}

const all = (data: ReviewOverview): ReviewTaskView[] => [
  ...data.todayTasks,
  ...data.overflow,
  ...data.upcoming,
  ...data.unscheduled,
  ...data.stable,
  ...data.skipped,
];

async function act(itemId: string, body: Record<string, unknown>, status = 200) {
  return json<{ revision: number; error?: string }>(
    await reviewAct(request('POST', `/api/study/review-tasks/${itemId}`, body), params({ itemId })),
    status,
  );
}

async function refreshSummary(status = 200) {
  resetLearningEventSyncThrottle();
  return json<{ state: string; reason: string; summary: { text: string } | null }>(
    await refreshSummaryRoute(
      request('POST', '/api/study/memory/summaries', { spaceId: 'space-a' }),
    ),
    status,
  );
}

function fakeSummaryModel(text = '最近做了导数小测，求导公式那题答错后又重做答对了。') {
  vi.mocked(gateway.complete).mockImplementation(async (...call: unknown[]) => {
    const input = call[1] as { system: string };
    expect(input.system).toBe(SUMMARY_SYSTEM_PROMPT);
    return {
      text: JSON.stringify({ summary: text }),
      usage: { inputTokens: 300, outputTokens: 40 },
    } as never;
  });
}

beforeEach(async () => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_EXAMS_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_GRADING_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_WRONGBOOK_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_MEMORY_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_PRACTICE_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_REVIEW_ENABLED', '1');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = OWNER;
  resetWrongbookSyncThrottle();
  resetLearningEventSyncThrottle();
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

describe('review tasks', () => {
  it('stays hidden unless switched on', async () => {
    expect((await (await capabilities()).json()).review).toBe(true);
    vi.stubEnv('ZHIYU_STUDY_REVIEW_ENABLED', '');
    expect((await (await capabilities()).json()).review).toBe(false);
    const hidden = await reviewList(request('GET', '/api/study/review-tasks?spaceId=space-a'));
    expect(hidden.status).toBe(404);
    const summary = await refreshSummaryRoute(
      request('POST', '/api/study/memory/summaries', { spaceId: 'space-a' }),
    );
    expect(summary.status).toBe(404);
  });

  it('turns a wrong answer into a review task with reasons, and a redo into practice', async () => {
    await importQuestions();
    await wrongPaper(3);
    const first = await overview();
    expect(first.mode).toBe('auto');
    expect(first.todayTasks).toHaveLength(1);
    const task = first.todayTasks[0]!;
    expect(task).toMatchObject({
      evidenceState: 'pending',
      dueSource: 'fsrs',
      redo: true,
      revision: 1,
      concepts: ['导数'],
    });
    expect(task.reasons).toEqual(
      expect.arrayContaining([
        { kind: 'overdue', days: 2 },
        { kind: 'not_rechecked' },
        { kind: 'recent_wrong', count: 1, days: 7 },
      ]),
    );
    expect(first.concepts).toEqual([
      expect.objectContaining({ name: '导数', items: 1, inScope: null }),
    ]);
    expect(gateway.complete).not.toHaveBeenCalled();

    // Redo the bank question: a one-question practice paper; answering it right is practice.
    const redo = await json<{ paperId: string; created: boolean }>(
      await reviewRedo(
        request('POST', `/api/study/review-tasks/${task.itemId}/redo`, {
          idempotencyKey: 'redo-key-0001',
        }),
        params({ itemId: task.itemId }),
      ),
      201,
    );
    const again = await json<{ paperId: string; created: boolean }>(
      await reviewRedo(
        request('POST', `/api/study/review-tasks/${task.itemId}/redo`, {
          idempotencyKey: 'redo-key-0001',
        }),
        params({ itemId: task.itemId }),
      ),
      200,
    );
    expect(again).toEqual({ paperId: redo.paperId, created: false });
    const sheet = await startAttempt(redo.paperId);
    expect(sheet.items).toHaveLength(1);
    expect(sheet.assistance).toMatchObject({ practice: true, items: { '1': { novelty: 'seen' } } });
    await submitAnswers(sheet, { '1': ['A'] }, 'submit-redo-1');

    const second = await overview();
    const redone = all(second).find((candidate) => candidate.itemId === task.itemId)!;
    expect(redone.evidenceState).toBe('practiced');
    expect(redone.evidence).toMatchObject({ practiced: 1, independentQuestions: 0 });
    const { item } = await json<{ item: WrongItemDetail }>(
      await getWrong(
        request('GET', `/api/study/wrongbook/${task.itemId}`),
        params({ itemId: task.itemId }),
      ),
      200,
    );
    expect(item.occurrences[0]!.origin.practice).toMatchObject({
      novelty: 'seen',
      independent: false,
    });
    const records = await pg().query<{ payload: { independence?: unknown } }>(
      `SELECT payload FROM study_learning_events WHERE event_type = 'exam_graded' ORDER BY seq`,
    );
    expect(records.rows.at(-1)!.payload.independence).toEqual({
      independent: 0,
      helped: 0,
      repeated: 1,
    });
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('keeps reviewed, postponed and skipped marks with a revision check', async () => {
    await importQuestions();
    await wrongPaper(3);
    const task = (await overview()).todayTasks[0]!;
    const done = await act(task.itemId, { kind: 'done', revision: 1 });
    expect(done.revision).toBe(2);
    const stale = await act(task.itemId, { kind: 'skip', revision: 1 }, 409);
    expect(stale.error).toBe('STUDY_REVISION_CONFLICT');
    const early = await act(task.itemId, { kind: 'postpone', until: '2020-01-01', revision: 2 }, 422);
    expect(early.error).toBe('STUDY_REVIEW_INVALID');
    const bad = await reviewAct(
      request('POST', `/api/study/review-tasks/${task.itemId}`, { kind: 'forget', revision: 2 }),
      params({ itemId: task.itemId }),
    );
    expect(bad.status).toBe(400);

    const date = addDays((await overview()).today, 5);
    await act(task.itemId, { kind: 'postpone', until: date, revision: 2 });
    const postponed = all(await overview()).find((candidate) => candidate.itemId === task.itemId)!;
    expect(postponed).toMatchObject({ due: date, dueSource: 'manual', revision: 3 });
    expect(postponed.reasons).toContainEqual({ kind: 'manual', date });

    await act(task.itemId, { kind: 'skip', revision: 3 });
    expect((await overview()).skipped.map((candidate) => candidate.itemId)).toEqual([task.itemId]);
    await act(task.itemId, { kind: 'clear', revision: 4 });
    expect((await overview()).skipped).toHaveLength(0);

    const records = await pg().query<{ event_type: string; payload: { outcome: string } }>(
      `SELECT event_type, payload FROM study_learning_events WHERE event_type = 'review_done' ORDER BY seq`,
    );
    expect(records.rows.map((row) => row.payload.outcome)).toEqual(['done', 'postponed', 'skipped']);

    // Daily minutes: created at revision 0, then a stale revision conflicts.
    const settings = await json<{ settings: { dailyMinutes: number; revision: number } }>(
      await reviewSettings(
        request('PUT', '/api/study/review-tasks/settings', {
          spaceId: 'space-a',
          dailyMinutes: 45,
          revision: 0,
        }),
      ),
      200,
    );
    expect(settings.settings).toMatchObject({ dailyMinutes: 45, revision: 1 });
    expect((await overview()).settings).toMatchObject({ dailyMinutes: 45, custom: true });
    const tooLow = await reviewSettings(
      request('PUT', '/api/study/review-tasks/settings', {
        spaceId: 'space-a',
        dailyMinutes: 1,
        revision: 1,
      }),
    );
    expect(tooLow.status).toBe(400);
  });

  it('moves tasks before the exam and orders by the exam scope', async () => {
    await importQuestions();
    await wrongPaper(3);
    // A later independent check would push the review weeks ahead; the exam date pulls it in.
    const task = (await overview()).todayTasks[0]!;
    await act(task.itemId, { kind: 'done', revision: 1 });
    const free = all(await overview()).find((candidate) => candidate.itemId === task.itemId)!;
    expect(free.dueSource).toBe('fsrs');
    await pg().query(
      `UPDATE study_spaces SET exam_date = (now() AT TIME ZONE 'Asia/Shanghai')::date + 1,
              exam_scope = '第三章 导数' WHERE id = 'space-a'`,
    );
    const scoped = await overview();
    const moved = all(scoped).find((candidate) => candidate.itemId === task.itemId)!;
    expect(scoped.exam.daysLeft).toBe(1);
    expect(moved.reasons).toContainEqual({ kind: 'scope', concepts: ['导数'] });
    expect(scoped.concepts[0]).toMatchObject({ name: '导数', inScope: true });
    if (free.due! > scoped.today) {
      expect(moved).toMatchObject({ due: scoped.today, dueSource: 'exam' });
    }
  });

  it('schedules nothing by rule and writes no summary with Memory off', async () => {
    await importQuestions();
    await wrongPaper(3);
    await json(
      await memoryControls(
        request('PUT', '/api/study/memory/controls', { spaceId: 'space-a', enabled: false }),
      ),
      200,
    );
    const view = await overview();
    expect(view.mode).toBe('manual');
    expect(view.todayTasks).toHaveLength(0);
    expect(view.unscheduled).toHaveLength(1);
    const summary = await refreshSummary();
    expect(summary).toMatchObject({ state: 'off', summary: null });
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('reaches nothing of another owner', async () => {
    await importQuestions();
    await wrongPaper(3);
    const task = (await overview()).todayTasks[0]!;
    owner.id = OTHER;
    const list = await reviewList(request('GET', '/api/study/review-tasks?spaceId=space-a'));
    expect(list.status).toBe(404);
    const acted = await act(task.itemId, { kind: 'done', revision: 1 }, 404);
    expect(acted.error).toBe('STUDY_WRONG_ITEM_NOT_FOUND');
    const redo = await reviewRedo(
      request('POST', `/api/study/review-tasks/${task.itemId}/redo`, {
        idempotencyKey: 'redo-key-0002',
      }),
      params({ itemId: task.itemId }),
    );
    expect(redo.status).toBe(404);
    const summary = await refreshSummaryRoute(
      request('POST', '/api/study/memory/summaries', { spaceId: 'space-a' }),
    );
    expect(summary.status).toBe(404);
  });
});

describe('Memory summaries', () => {
  it('writes once per change, never for unchanged or deleted inputs, and reaches chats', async () => {
    await importQuestions();
    await wrongPaper(3);
    // One record is not enough to summarise.
    expect(await refreshSummary()).toMatchObject({ state: 'kept', reason: 'too_little' });
    const task = (await overview()).todayTasks[0]!;
    await act(task.itemId, { kind: 'done', revision: 1 });
    await act(task.itemId, { kind: 'skip', revision: 2 });
    expect(gateway.complete).not.toHaveBeenCalled();

    fakeSummaryModel();
    const written = await refreshSummary();
    expect(written).toMatchObject({ state: 'written', reason: 'first' });
    expect(written.summary?.text).toContain('导数');
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    const call = vi.mocked(gateway.complete).mock.calls[0]!;
    expect((call[2] as { source: string }).source).toBe('study-memory-summary');

    // Opening the pages again: same records, no call.
    expect(await refreshSummary()).toMatchObject({ state: 'kept', reason: 'unchanged' });
    expect(gateway.complete).toHaveBeenCalledTimes(1);

    // A chat turn in the subject receives it, apart from what the student set.
    const context = await resolveMemoryContext(pg() as never, OWNER, 'space-a');
    expect(context.info.refs.some((ref) => ref.startsWith('summary:space-a@'))).toBe(true);
    expect(context.block).toContain('本学科近期学习情况');
    vi.stubEnv('ZHIYU_STUDY_REVIEW_ENABLED', '');
    expect((await resolveMemoryContext(pg() as never, OWNER, 'space-a')).block).not.toContain(
      '本学科近期学习情况',
    );
    vi.stubEnv('ZHIYU_STUDY_REVIEW_ENABLED', '1');

    // The student deletes it: the same records never rebuild it.
    await json(
      await deleteSummaryRoute(request('DELETE', '/api/study/memory/summaries?spaceId=space-a')),
      200,
    );
    expect(await refreshSummary()).toMatchObject({ state: 'kept', reason: 'suppressed', summary: null });
    expect(gateway.complete).toHaveBeenCalledTimes(1);

    // Deleting a learning record changes the inputs: a new summary may be written from what is left.
    const seq = (
      await pg().query<{ seq: string }>(
        `SELECT seq FROM study_learning_events WHERE event_type = 'review_done' ORDER BY seq LIMIT 1`,
      )
    ).rows[0]!.seq;
    await pg().query(
      `INSERT INTO study_memory_summaries (owner_id, space_id, status, text, input_hash, policy_version)
       VALUES ($1, 'space-a', 'ready', '旧摘要', 'old', 'memory-summary-v1')`,
      [OWNER],
    );
    await json(
      await deleteRecord(
        request('DELETE', `/api/study/memory/records/${seq}`),
        params({ seq: String(seq) }),
      ),
      200,
    );
    const left = await pg().query(`SELECT 1 FROM study_memory_summaries WHERE owner_id = $1`, [OWNER]);
    expect(left.rows).toHaveLength(0);
  });
});
