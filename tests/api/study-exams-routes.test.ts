/**
 * Question bank, rule-built papers and objective attempts (learning plan
 * B07) end to end on PGlite: hidden unless switched on; a 30-question import
 * is previewed with located errors, committed once and not duplicated by a
 * repeat; a 10-question blueprint publishes exactly the previewed paper; the
 * bank's shortfalls are reported, not padded; attempts resume on a second
 * device, refuse stale drafts and submit once; the answer key never leaves
 * the server before submission; editing or deleting bank questions leaves
 * the paper unchanged; official packs are read-only with private copies;
 * owners are isolated; a learning record is made; no model is called.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

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

import { gateway } from '@/lib/model-gateway';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { resetLearningEventSyncThrottle } from '@/lib/server/study/memory/projector';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import { GET as listBank, POST as createQuestion } from '@/app/api/study/question-bank/route';
import {
  DELETE as deleteQuestion,
  PATCH as patchQuestion,
} from '@/app/api/study/question-bank/[questionId]/route';
import { POST as imports } from '@/app/api/study/question-bank/imports/route';
import { GET as concepts } from '@/app/api/study/question-bank/concepts/route';
import { GET as packs } from '@/app/api/study/question-bank/packs/route';
import { POST as copyPack } from '@/app/api/study/question-bank/packs/[packId]/copy/route';
import { POST as preview } from '@/app/api/study/exams/preview/route';
import { GET as listPapers, POST as publish } from '@/app/api/study/papers/route';
import { DELETE as deletePaper } from '@/app/api/study/papers/[paperId]/route';
import { POST as start } from '@/app/api/study/papers/[paperId]/attempts/route';
import { GET as getAttempt } from '@/app/api/study/attempts/[attemptId]/route';
import { PUT as saveAnswers } from '@/app/api/study/attempts/[attemptId]/answers/route';
import { POST as submit } from '@/app/api/study/attempts/[attemptId]/submit/route';
import { GET as memoryOverview } from '@/app/api/study/memory/route';
import type { AttemptView, PaperSummary } from '@/lib/study/assessments/contracts';
import type { PaperPreview } from '@/lib/study/questions/blueprint';
import type { QuestionListResult, QuestionView } from '@/lib/study/questions/contracts';

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

/** 30 checked objective questions: 20 single, 10 multiple, over two knowledge points. */
function thirtyQuestions() {
  return Array.from({ length: 30 }, (_, index) => {
    const a = index + 2;
    if (index < 20) {
      return {
        id: `s${index}`,
        type: 'single',
        stem: `$${a} \\times 3$ 等于多少？`,
        options: [String(a * 3), String(a * 3 + 1), String(a * 3 - 1), String(a * 3 + 100)],
        answer: 'A',
        explanation: `${a} 个 3 相加`,
        concepts: [index % 2 ? '乘法' : '加法'],
        difficulty: (index % 5) + 1,
        verified: true,
      };
    }
    return {
      id: `m${index}`,
      type: 'multiple',
      stem: `下列哪些数能被 ${a} 整除？`,
      options: [String(a * 2), String(a * 5), String(a * 2 + 1), String(a * 7)],
      answer: ['A', 'B', 'D'],
      concepts: ['乘法'],
      verified: true,
    };
  });
}

async function seed() {
  await pg().query(
    `INSERT INTO study_spaces (id, owner_id, name, status, archived_at) VALUES
       ('space-a', $1, '算术', 'active', NULL), ('space-c', $1, '旧学科', 'archived', now()),
       ('space-b', $2, '英语', 'active', NULL)`,
    [OWNER, OTHER],
  );
  await pg().query(
    `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
     VALUES ('stage-a', '乘法入门', 0, 0, $1, '{"id":"stage-a"}')`,
    [OWNER],
  );
  await pg().query(`INSERT INTO stage_meta (stage_id, owner_id) VALUES ('stage-a', $1)`, [OWNER]);
  await pg().query(
    `INSERT INTO study_space_courses (owner_id, space_id, stage_id) VALUES ($1, 'space-a', 'stage-a')`,
    [OWNER],
  );
}

async function importAll(spaceId = 'space-a') {
  const document = { format: 'zhiyu-question-bank', version: 1, questions: thirtyQuestions() };
  const previewed = await json<{
    items: Array<{ content: unknown; verified: boolean }>;
    summary: Record<string, number>;
  }>(
    await imports(request('POST', '/api/study/question-bank/imports', { spaceId, document })),
    200,
  );
  return json<{ created: number; duplicates: number; invalid: number }>(
    await imports(
      request('POST', '/api/study/question-bank/imports', {
        spaceId,
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

const tenQuestions = {
  spaceId: 'space-a',
  sections: [
    { type: 'single', count: 8 },
    { type: 'multiple', count: 2 },
  ],
};

async function publishPaper(blueprint: Record<string, unknown>, key = 'key-00000001') {
  const shown = await json<{ preview: PaperPreview }>(
    await preview(request('POST', '/api/study/exams/preview', { blueprint })),
    200,
  );
  const response = await publish(
    request('POST', '/api/study/papers', {
      blueprint: { ...blueprint, seed: shown.preview.seed },
      title: '十题练习',
      idempotencyKey: key,
    }),
  );
  return {
    shown: shown.preview,
    paper: (await json<{ paper: PaperSummary }>(response, 201)).paper,
  };
}

async function startAttempt(paperId: string, status = 201) {
  return (
    await json<{ attempt: AttemptView }>(
      await start(request('POST', `/api/study/papers/${paperId}/attempts`), params({ paperId })),
      status,
    )
  ).attempt;
}

beforeEach(async () => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_EXAMS_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_MEMORY_ENABLED', '1');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = OWNER;
  const db = new PGlite();
  await ensureDocumentSchema(db as never);
  await ensureStageMetaSchema(db as never);
  await ensureStudySchema(db as never);
  database.pg = db;
  await seed();
  vi.spyOn(gateway, 'complete');
  vi.spyOn(gateway, 'stream');
});

afterEach(async () => {
  // Import, rule-based building, answering and grading never call a model.
  expect(gateway.complete).not.toHaveBeenCalled();
  expect(gateway.stream).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await pg().close();
});

describe('question bank and papers', () => {
  it('stay hidden unless the switch is on', async () => {
    expect((await (await capabilities()).json()).exams).toBe(true);
    vi.stubEnv('ZHIYU_STUDY_EXAMS_ENABLED', '');
    expect((await (await capabilities()).json()).exams).toBe(false);
    expect(
      (await listBank(request('GET', '/api/study/question-bank?spaceId=space-a'))).status,
    ).toBe(404);
    expect((await packs(request('GET', '/api/study/question-bank/packs'))).status).toBe(404);
  });

  it('previews an import with located errors, commits once and never duplicates', async () => {
    const document = {
      format: 'zhiyu-question-bank',
      version: 1,
      questions: [
        ...thirtyQuestions(),
        { id: 'bad', type: 'single', stem: '坏题', options: ['x'], answer: 'B' },
        { id: 'draft', type: 'single', stem: '缺答案', options: ['x', 'y'] },
        thirtyQuestions()[0],
      ],
    };
    const shown = await json<{
      items: Array<{ errors: Array<{ path: string; code: string }>; duplicateOf: string | null }>;
      summary: Record<string, number>;
    }>(
      await imports(
        request('POST', '/api/study/question-bank/imports', { spaceId: 'space-a', document }),
      ),
      200,
    );
    expect(shown.summary).toEqual({ total: 33, ready: 30, drafts: 1, invalid: 1, duplicates: 1 });
    expect(shown.items[30]!.errors.map((issue) => `${issue.path}:${issue.code}`)).toEqual(
      expect.arrayContaining(['options:options_too_few', 'answer:answer_not_in_options']),
    );
    expect(shown.items[32]!.duplicateOf).toBe('batch');
    expect((await pg().query('SELECT 1 FROM study_questions')).rows).toEqual([]);

    expect(await importAll()).toMatchObject({ created: 30, duplicates: 0, invalid: 0 });
    expect(await importAll()).toMatchObject({ created: 0, duplicates: 30 });
    const bank = await json<QuestionListResult>(
      await listBank(request('GET', '/api/study/question-bank?spaceId=space-a')),
      200,
    );
    expect(bank.counts).toEqual({ all: 30, gradable: 30, verified: 30, drafts: 0 });
    expect(bank.questions).toHaveLength(30);
    expect(bank.questions[0]).toMatchObject({
      origin: 'user_import',
      verification: 'user_verified',
    });
    const points = await json<{ concepts: Array<{ name: string; questionCount: number }> }>(
      await concepts(request('GET', '/api/study/question-bank/concepts?spaceId=space-a')),
      200,
    );
    expect(points.concepts).toEqual([
      expect.objectContaining({ name: '乘法', questionCount: 20 }),
      expect.objectContaining({ name: '加法', questionCount: 10 }),
    ]);

    // A draft keeps its place but is never gradable or "verified".
    const draft = await json<{ question: QuestionView }>(
      await createQuestion(
        request('POST', '/api/study/question-bank', {
          spaceId: 'space-a',
          question: { type: 'single', stem: '待补答案', options: ['x', 'y'] },
          verified: true,
        }),
      ),
      201,
    );
    expect(draft.question).toMatchObject({
      gradable: false,
      verification: 'unverified',
      origin: 'manual',
    });
    // Archived subjects are read-only.
    expect(
      (
        await imports(
          request('POST', '/api/study/question-bank/imports', { spaceId: 'space-c', document }),
        )
      ).status,
    ).toBe(409);
  });

  it('publishes the previewed paper once, reports shortfalls and resumes, saves and submits safely', async () => {
    await importAll();
    const { shown, paper } = await publishPaper(tenQuestions);
    expect(shown).toMatchObject({ complete: true, shortfalls: [], totalPoints: 10 });
    expect(shown.items).toHaveLength(10);
    expect(paper).toMatchObject({ itemCount: 10, totalPoints: 10, attempts: [] });

    // The same request again returns the same paper; the key with another request conflicts.
    const again = await publish(
      request('POST', '/api/study/papers', {
        blueprint: { ...tenQuestions, seed: shown.seed },
        title: '十题练习',
        idempotencyKey: 'key-00000001',
      }),
    );
    expect((await json<{ paper: PaperSummary }>(again, 200)).paper.id).toBe(paper.id);
    const reused = await publish(
      request('POST', '/api/study/papers', {
        blueprint: { ...tenQuestions, seed: shown.seed },
        title: '另一张',
        idempotencyKey: 'key-00000001',
      }),
    );
    expect((await json<{ error: string }>(reused, 409)).error).toBe('STUDY_IDEMPOTENCY_CONFLICT');

    // Shortfall: only 10 multiple-choice questions exist.
    const short = await json<{ preview: PaperPreview }>(
      await preview(
        request('POST', '/api/study/exams/preview', {
          blueprint: { spaceId: 'space-a', sections: [{ type: 'multiple', count: 12 }] },
        }),
      ),
      200,
    );
    expect(short.preview).toMatchObject({
      complete: false,
      shortfalls: [{ type: 'multiple', wanted: 12, available: 10 }],
    });
    const refused = await publish(
      request('POST', '/api/study/papers', {
        blueprint: { spaceId: 'space-a', sections: [{ type: 'multiple', count: 12 }] },
        title: 'x',
        idempotencyKey: 'key-00000002',
      }),
    );
    expect(await json(refused, 409)).toMatchObject({
      error: 'STUDY_EXAM_INSUFFICIENT',
      shortfalls: [{ type: 'multiple', wanted: 12, available: 10 }],
    });

    // Answering: no key before submission; the frozen items match the preview.
    const attempt = await startAttempt(paper.id);
    expect(attempt.items.map((item) => item.stem)).toEqual(shown.items.map((item) => item.stem));
    const served = JSON.stringify(attempt);
    expect(served).not.toMatch(/"answer"|explanation|answer_key|个 3 相加/);
    expect(attempt.report).toBeNull();

    // A second device resumes the same attempt.
    const elsewhere = await startAttempt(paper.id, 200);
    expect(elsewhere.id).toBe(attempt.id);

    const first = attempt.items[0]!;
    const saved = await json<{ revision: number }>(
      await saveAnswers(
        request('PUT', `/api/study/attempts/${attempt.id}/answers`, {
          answers: { [first.position]: [first.options[1]!.value] },
          baseRevision: attempt.revision,
        }),
        params({ attemptId: attempt.id }),
      ),
      200,
    );
    expect(saved.revision).toBe(attempt.revision + 1);
    // The other device still holds the old revision: refused, with the stored draft.
    const stale = await saveAnswers(
      request('PUT', `/api/study/attempts/${attempt.id}/answers`, {
        answers: {},
        baseRevision: attempt.revision,
      }),
      params({ attemptId: attempt.id }),
    );
    expect(await json(stale, 409)).toMatchObject({
      error: 'STUDY_REVISION_CONFLICT',
      revision: saved.revision,
      answers: { [first.position]: [first.options[1]!.value] },
    });
    const malformed = await saveAnswers(
      request('PUT', `/api/study/attempts/${attempt.id}/answers`, {
        answers: { [first.position]: ['A', 'A'] },
        baseRevision: saved.revision,
      }),
      params({ attemptId: attempt.id }),
    );
    expect(malformed.status).toBe(400);
    const reloaded = (
      await json<{ attempt: AttemptView }>(
        await getAttempt(
          request('GET', `/api/study/attempts/${attempt.id}`),
          params({ attemptId: attempt.id }),
        ),
        200,
      )
    ).attempt;
    expect(reloaded.answers).toEqual({ [first.position]: [first.options[1]!.value] });

    // Final answers: every single-choice item right (key "A"), multiple ones left blank.
    const answers = Object.fromEntries(
      attempt.items.filter((item) => item.type === 'single').map((item) => [item.position, ['A']]),
    );
    const submitted = await json<{ attempt: AttemptView; alreadySubmitted: boolean }>(
      await submit(
        request('POST', `/api/study/attempts/${attempt.id}/submit`, {
          answers,
          baseRevision: saved.revision,
          submitKey: 'submit-000001',
        }),
        params({ attemptId: attempt.id }),
      ),
      200,
    );
    expect(submitted.alreadySubmitted).toBe(false);
    expect(submitted.attempt.report?.grading).toMatchObject({
      earned: 8,
      totalPoints: 10,
      correct: 8,
      unanswered: 2,
      ungradable: 0,
    });
    // The other device submits too: nothing changes.
    const twice = await json<{ attempt: AttemptView; alreadySubmitted: boolean }>(
      await submit(
        request('POST', `/api/study/attempts/${attempt.id}/submit`, { submitKey: 'submit-000002' }),
        params({ attemptId: attempt.id }),
      ),
      200,
    );
    expect(twice.alreadySubmitted).toBe(true);
    expect(twice.attempt.report?.grading.earned).toBe(8);
    expect(
      (
        await saveAnswers(
          request('PUT', `/api/study/attempts/${attempt.id}/answers`, {
            answers: {},
            baseRevision: twice.attempt.revision,
          }),
          params({ attemptId: attempt.id }),
        )
      ).status,
    ).toBe(409);
    const report = submitted.attempt.report!.items;
    expect(report.find((item) => item.type === 'single')).toMatchObject({
      answer: ['A'],
      outcome: 'correct',
    });
    expect(report.find((item) => item.type === 'multiple')).toMatchObject({
      answer: ['A', 'B', 'D'],
      outcome: 'unanswered',
    });

    // Editing and deleting bank questions does not touch the frozen paper.
    const bank = await json<QuestionListResult>(
      await listBank(request('GET', '/api/study/question-bank?spaceId=space-a&type=single')),
      200,
    );
    const target = bank.questions.find((question) => question.stem === report[0]!.stem)!;
    const edited = await json<{ question: QuestionView }>(
      await patchQuestion(
        request('PATCH', `/api/study/question-bank/${target.id}`, {
          question: { ...target, stem: '改过的题干', answer: ['B'] },
          verified: true,
          stageId: 'stage-a',
          baseVersion: target.version,
        }),
        params({ questionId: target.id }),
      ),
      200,
    );
    expect(edited.question).toMatchObject({ version: 2, stem: '改过的题干', stageId: 'stage-a' });
    const staleEdit = await patchQuestion(
      request('PATCH', `/api/study/question-bank/${target.id}`, {
        question: target,
        verified: true,
        stageId: null,
        baseVersion: 1,
      }),
      params({ questionId: target.id }),
    );
    expect(staleEdit.status).toBe(409);
    const other = bank.questions.find((question) => question.stem === report[1]!.stem)!;
    expect(
      (
        await deleteQuestion(
          request('DELETE', `/api/study/question-bank/${other.id}`),
          params({ questionId: other.id }),
        )
      ).status,
    ).toBe(200);
    const after = (
      await json<{ attempt: AttemptView }>(
        await getAttempt(
          request('GET', `/api/study/attempts/${attempt.id}`),
          params({ attemptId: attempt.id }),
        ),
        200,
      )
    ).attempt;
    expect(after.report!.items).toEqual(report);

    // "Avoid questions I've done": 19 single-choice questions remain, 7 of them were in the
    // submitted paper (an edited question still counts as done; the deleted one is gone).
    const fresh = await json<{ preview: PaperPreview }>(
      await preview(
        request('POST', '/api/study/exams/preview', {
          blueprint: {
            spaceId: 'space-a',
            sections: [{ type: 'single', count: 20 }],
            avoidSeen: true,
          },
        }),
      ),
      200,
    );
    expect(fresh.preview.available.single).toBe(12);
    expect(fresh.preview.shortfalls[0]).toMatchObject({ excludedSeen: 7 });

    // The learning record (Memory on) carries the server grading.
    resetLearningEventSyncThrottle();
    const memory = await json<{
      records: Array<{ type: string; payload: Record<string, unknown> }>;
    }>(await memoryOverview(request('GET', '/api/study/memory')), 200);
    expect(memory.records.find((record) => record.type === 'exam_graded')?.payload).toEqual({
      paperId: paper.id,
      itemCount: 10,
      correct: 8,
      unanswered: 2,
      earned: 8,
      totalPoints: 10,
      // Every question was new and no help exists in a bank paper (B11).
      independence: { independent: 8, helped: 0, repeated: 0 },
    });

    // Starting again opens a new, independent attempt.
    const retry = await startAttempt(paper.id);
    expect(retry.id).not.toBe(attempt.id);
    const papers = await json<{ papers: PaperSummary[] }>(
      await listPapers(request('GET', '/api/study/papers?spaceId=space-a')),
      200,
    );
    expect(papers.papers[0]!.attempts.map((item) => item.status)).toEqual([
      'in_progress',
      'submitted',
    ]);
  });

  it('uses official packs read-only, after the own bank, and copies them privately', async () => {
    const catalogue = await json<{ packs: Array<{ id: string; license: string }> }>(
      await packs(request('GET', '/api/study/question-bank/packs')),
      200,
    );
    const packId = catalogue.packs[0]!.id;
    expect(catalogue.packs[0]!.license).toBeTruthy();
    const withPack = await json<{ preview: PaperPreview }>(
      await preview(
        request('POST', '/api/study/exams/preview', {
          blueprint: {
            spaceId: 'space-a',
            sections: [{ type: 'single', count: 5 }],
            packIds: [packId],
          },
        }),
      ),
      200,
    );
    expect(withPack.preview.items.every((item) => item.tier === 'pack')).toBe(true);
    expect(withPack.preview.items[0]).toMatchObject({
      origin: 'official',
      verification: 'official_verified',
    });

    const copied = await json<{ created: number; ids: string[] }>(
      await copyPack(
        request('POST', `/api/study/question-bank/packs/${packId}/copy`, {
          spaceId: 'space-a',
          questionIds: ['lim-01', 'der-01'],
        }),
        params({ packId }),
      ),
      200,
    );
    expect(copied.created).toBe(2);
    const repeat = await json<{ created: number; duplicates: number }>(
      await copyPack(
        request('POST', `/api/study/question-bank/packs/${packId}/copy`, {
          spaceId: 'space-a',
          questionIds: ['lim-01'],
        }),
        params({ packId }),
      ),
      200,
    );
    expect(repeat).toMatchObject({ created: 0, duplicates: 1 });
    const bank = await json<QuestionListResult>(
      await listBank(request('GET', '/api/study/question-bank?spaceId=space-a')),
      200,
    );
    expect(bank.questions[0]).toMatchObject({
      origin: 'official',
      verification: 'official_verified',
    });
    expect(bank.questions[0]!.source?.pack?.id).toBe(packId);

    // The bank copy goes first and the pack original is not asked twice.
    const mixed = await json<{ preview: PaperPreview }>(
      await preview(
        request('POST', '/api/study/exams/preview', {
          blueprint: {
            spaceId: 'space-a',
            sections: [{ type: 'single', count: 14 }],
            packIds: [packId],
          },
        }),
      ),
      200,
    );
    expect(mixed.preview.items.slice(0, 2).every((item) => item.tier === 'bank')).toBe(true);
    expect(new Set(mixed.preview.items.map((item) => item.stem)).size).toBe(
      mixed.preview.items.length,
    );
    expect(mixed.preview.complete).toBe(false);

    // Editing a copy's content makes it the student's own check.
    const copy = bank.questions[0]!;
    const edited = await json<{ question: QuestionView }>(
      await patchQuestion(
        request('PATCH', `/api/study/question-bank/${copy.id}`, {
          question: { ...copy, explanation: '我的笔记' },
          verified: true,
          stageId: null,
          baseVersion: copy.version,
        }),
        params({ questionId: copy.id }),
      ),
      200,
    );
    expect(edited.question).toMatchObject({
      verification: 'official_verified',
      explanation: '我的笔记',
    });
    const changed = await json<{ question: QuestionView }>(
      await patchQuestion(
        request('PATCH', `/api/study/question-bank/${copy.id}`, {
          question: { ...edited.question, stem: `${edited.question.stem}（改）` },
          verified: true,
          stageId: null,
          baseVersion: edited.question.version,
        }),
        params({ questionId: copy.id }),
      ),
      200,
    );
    expect(changed.question.verification).toBe('user_verified');
    expect(changed.question.source?.pack?.id).toBe(packId);
  });

  it('isolates owners', async () => {
    await importAll();
    const { paper } = await publishPaper(tenQuestions);
    const attempt = await startAttempt(paper.id);
    owner.id = OTHER;
    expect(
      (await listBank(request('GET', '/api/study/question-bank?spaceId=space-a'))).status,
    ).toBe(404);
    expect((await listPapers(request('GET', '/api/study/papers?spaceId=space-a'))).status).toBe(
      404,
    );
    expect(
      (
        await getAttempt(
          request('GET', `/api/study/attempts/${attempt.id}`),
          params({ attemptId: attempt.id }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await start(
          request('POST', `/api/study/papers/${paper.id}/attempts`),
          params({ paperId: paper.id }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await submit(
          request('POST', `/api/study/attempts/${attempt.id}/submit`, {
            submitKey: 'submit-000009',
          }),
          params({ attemptId: attempt.id }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await deletePaper(
          request('DELETE', `/api/study/papers/${paper.id}`),
          params({ paperId: paper.id }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await preview(request('POST', '/api/study/exams/preview', { blueprint: tenQuestions })))
        .status,
    ).toBe(404);
    owner.id = OWNER;
    expect(
      (
        await deletePaper(
          request('DELETE', `/api/study/papers/${paper.id}`),
          params({ paperId: paper.id }),
        )
      ).status,
    ).toBe(200);
    expect((await pg().query('SELECT 1 FROM study_exam_attempts')).rows).toEqual([]);
  });
});
