/**
 * Exercise extraction (learning plan B08) end to end on PGlite: hidden unless
 * switched on; a parsed PDF version with a scanned page, a question across a
 * page break, an answer key, an open question and a figure is extracted by
 * rules (no model), repeated requests return the same extraction; candidates
 * are corrected (revision-checked), split and merged, optionally tidied by a
 * model whose suggestion only counts when adopted (recorded as `model`), and
 * committed as `material_extracted` questions that point at the original
 * version and pages and carry their figures into papers; open questions and
 * repeated commits add nothing; an unlinked or deleted material allows no
 * new commits; another owner sees nothing; public-source imports keep their
 * licence status and can be left out of papers.
 */
import { createHash } from 'node:crypto';

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
// The synchronous heavy-task lease needs the hosted request pool; run the body directly.
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
    modelString: 'test:extract-model',
    credentialReady: true,
    funding: { kind: 'operator' },
  })),
}));

import { gateway } from '@/lib/model-gateway';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { GET as capabilities } from '@/app/api/study/capabilities/route';
import { GET as listExtractions, POST as startExtraction } from '@/app/api/study/extractions/route';
import {
  DELETE as deleteExtraction,
  GET as getExtraction,
} from '@/app/api/study/extractions/[extractionId]/route';
import { POST as commit } from '@/app/api/study/extractions/[extractionId]/commit/route';
import { POST as assist } from '@/app/api/study/extractions/[extractionId]/assist/route';
import { PATCH as patchCandidate } from '@/app/api/study/extraction-candidates/[candidateId]/route';
import { POST as candidateAction } from '@/app/api/study/extraction-candidates/[candidateId]/actions/route';
import { GET as listBank } from '@/app/api/study/question-bank/route';
import { POST as imports } from '@/app/api/study/question-bank/imports/route';
import { POST as preview } from '@/app/api/study/exams/preview/route';
import { POST as publish } from '@/app/api/study/papers/route';
import { POST as start } from '@/app/api/study/papers/[paperId]/attempts/route';
import { GET as image } from '@/app/api/study/materials/[materialId]/versions/[versionId]/images/[imageId]/route';
import type { AttemptView, PaperSummary } from '@/lib/study/assessments/contracts';
import type {
  CandidateView,
  CommitOutcome,
  ExtractionDetail,
  ExtractionView,
} from '@/lib/study/extraction/contracts';
import type { PaperPreview } from '@/lib/study/questions/blueprint';
import type { QuestionListResult } from '@/lib/study/questions/contracts';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MATERIAL = 'smat-exercises';
const V1 = 'sver-exercises-1';
const V2 = 'sver-exercises-2';
const ART1 = 'sart-exercises-1';
const ART2 = 'sart-exercises-2';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const request = (method: string, url: string, body?: unknown) =>
  new NextRequest(`https://zhiyu.test${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as never;
const pg = () => database.pg as PGlite;
let bytes: Map<string, Buffer>;

async function json<T>(response: Response, status: number): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

/** The stored parse of version 1: five pages, page 3 scanned (no text), a figure on page 4. */
const PAGES_V1: Record<number, string> = {
  1: '高等数学习题册\n习题 1.1\n1. 函数 f(x)=x² 在 x=1 处的导数是（ ）\nA. 1 B. 2 C. 3 D. 4\n2．下列函数在 x=0 处连续的是\n— 1 —',
  2: '高等数学习题册\nA. 1/x B. |x|\nC. ln x D. tan(1/x)\n3. 求极限 lim(x→0) sin x / x。\n— 2 —',
  4: '高等数学习题册\n4. 如图所示，三角形 ABC 中 AB=AC，则（ ）\nA. ∠B=∠C B. ∠A=∠B\n— 4 —',
  5: '高等数学习题册\n参考答案\n1. B 2. B\n3. 1\n— 5 —',
};

function artifact(pages: Record<number, string>, pageCount: number, images: string[]) {
  return {
    version: 1,
    transform: 'study-artifact-v1',
    extractorId: 'unpdf',
    extractorVersion: 'fixture',
    mimeType: 'application/pdf',
    pageCount,
    paged: true,
    blocks: [
      ...Object.entries(pages).map(([page, text]) => ({
        id: `page_${page}`,
        type: 'text',
        text,
        pageNumber: Number(page),
      })),
      ...images.map((id) => ({ id: `block_${id}`, type: 'image', imageId: id, pageNumber: 4 })),
    ],
    images: images.map((id) => ({
      id,
      key: `study/${OWNER}/artifacts/${ART1}/${id}.png`,
      mimeType: 'image/png',
      pageNumber: 4,
    })),
    diagnostics: [],
  };
}

async function seedMaterial(ownerId: string, spaceId: string) {
  await pg().query(
    `INSERT INTO study_materials (id, owner_id, title, current_version_id, version_count)
     VALUES ($1, $2, '高数习题册', $3, 2)`,
    [MATERIAL, ownerId, V2],
  );
  const versions: Array<[string, string, number, Record<number, string>]> = [
    [V1, ART1, 1, PAGES_V1],
    [V2, ART2, 2, { 1: '1. 新版第一题 A. 甲 B. 乙' }],
  ];
  for (const [versionId, artifactId, no, pages] of versions) {
    const upload = `up-${versionId}`;
    const sha = createHash('sha256').update(versionId).digest('hex');
    const artifactKey = `study/${ownerId}/artifacts/${artifactId}/artifact.json`;
    bytes.set(
      artifactKey,
      Buffer.from(JSON.stringify(artifact(pages, 5, no === 1 ? ['img_1'] : []))),
    );
    await pg().query(
      `INSERT INTO owner_material (id, owner_id, kind, mime, bytes, original_name, oss_key, sha256,
         status, created_at)
       VALUES ($1, $2, 'source', 'application/pdf', 100, 'ex.pdf', $3, $4, 'ready', 0)`,
      [upload, ownerId, `materials/${ownerId}/${upload}`, sha],
    );
    await pg().query(
      `INSERT INTO study_material_versions (id, owner_id, material_id, version_no, owner_material_id,
         object_key, sha256, mime, byte_size, original_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'application/pdf', 100, 'ex.pdf')`,
      [versionId, ownerId, MATERIAL, no, upload, `materials/${ownerId}/${upload}`, sha],
    );
    await pg().query(
      `INSERT INTO study_material_artifacts (id, owner_id, version_id, fingerprint, extractor_id,
         extractor_version, transform_version, artifact_key, text_key, object_keys, page_count,
         block_count, text_chars, paged)
       VALUES ($1, $2, $3, $6, 'unpdf', 'fixture', 'study-artifact-v1', $4, $5, '[]', 5, 5, 100, true)`,
      [
        artifactId,
        ownerId,
        versionId,
        artifactKey,
        `${artifactKey}.txt`,
        createHash('sha256').update(artifactId).digest('hex'),
      ],
    );
    await pg().query(
      'UPDATE study_material_versions SET active_artifact_id=$3 WHERE owner_id=$1 AND id=$2',
      [ownerId, versionId, artifactId],
    );
  }
  bytes.set(`study/${OWNER}/artifacts/${ART1}/img_1.png`, PNG);
  await pg().query(
    `INSERT INTO study_space_materials (owner_id, space_id, material_id) VALUES ($1, $2, $3)`,
    [ownerId, spaceId, MATERIAL],
  );
}

async function begin(body: Record<string, unknown>, status = 201) {
  return json<{ extractionId: string; created: boolean }>(
    await startExtraction(request('POST', '/api/study/extractions', body)),
    status,
  );
}

async function detailOf(extractionId: string, status = 200) {
  return json<ExtractionDetail>(
    await getExtraction(
      request('GET', `/api/study/extractions/${extractionId}`),
      params({ extractionId }),
    ),
    status,
  );
}

async function patch(candidate: CandidateView, body: Record<string, unknown>, status = 200) {
  return json<{ candidate: CandidateView; error?: string }>(
    await patchCandidate(
      request('PATCH', `/api/study/extraction-candidates/${candidate.id}`, {
        revision: candidate.revision,
        ...body,
      }),
      params({ candidateId: candidate.id }),
    ),
    status,
  );
}

async function act<T>(candidate: CandidateView, body: Record<string, unknown>, status = 200) {
  return json<T>(
    await candidateAction(
      request('POST', `/api/study/extraction-candidates/${candidate.id}/actions`, {
        revision: candidate.revision,
        ...body,
      }),
      params({ candidateId: candidate.id }),
    ),
    status,
  );
}

async function commitIds(extractionId: string, candidateIds: string[], status = 200) {
  return json<{ outcomes: CommitOutcome[]; detail: ExtractionDetail; error?: string }>(
    await commit(
      request('POST', `/api/study/extractions/${extractionId}/commit`, { candidateIds }),
      params({ extractionId }),
    ),
    status,
  );
}

const byLabel = (detail: ExtractionDetail, label: string) =>
  detail.candidates.find((candidate) => candidate.label === label)!;

beforeEach(async () => {
  vi.stubEnv('ZHIYU_STUDY_SPACES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_MATERIALS_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_EXAMS_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_EXTRACTION_ENABLED', '1');
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/db');
  vi.stubEnv('AUTH_MODE', 'supabase');
  owner.id = OWNER;
  const db = new PGlite();
  await ensureDocumentSchema(db as never);
  await ensureStageMetaSchema(db as never);
  await ensureOwnerMaterialSchema(db as never);
  await ensureStudySchema(db as never);
  database.pg = db;
  bytes = new Map();
  setMaterialByteStoreForTests({
    put: async (key, body) => void bytes.set(key, Buffer.from(body as Uint8Array)),
    get: async (key) => {
      const value = bytes.get(key);
      if (!value) throw new Error(`missing ${key}`);
      return value;
    },
    delete: async (key) => void bytes.delete(key),
  });
  await pg().query(
    `INSERT INTO study_spaces (id, owner_id, name) VALUES
       ('space-a', $1, '高数'), ('space-b', $2, '物理')`,
    [OWNER, OTHER],
  );
  await seedMaterial(OWNER, 'space-a');
  vi.spyOn(gateway, 'complete');
  vi.spyOn(gateway, 'stream');
});

afterEach(async () => {
  expect(gateway.stream).not.toHaveBeenCalled();
  setMaterialByteStoreForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await pg().close();
});

describe('exercise extraction', () => {
  it('stays hidden unless the switch, the library and the bank are on', async () => {
    expect((await (await capabilities()).json()).extraction).toBe(true);
    vi.stubEnv('ZHIYU_STUDY_EXAMS_ENABLED', '');
    expect((await (await capabilities()).json()).extraction).toBe(false);
    vi.stubEnv('ZHIYU_STUDY_EXAMS_ENABLED', '1');
    vi.stubEnv('ZHIYU_STUDY_EXTRACTION_ENABLED', '');
    expect((await (await capabilities()).json()).extraction).toBe(false);
    expect(
      (await listExtractions(request('GET', '/api/study/extractions?spaceId=space-a'))).status,
    ).toBe(404);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('extracts by rules, skips the scanned page and repeats nothing', async () => {
    const started = await begin({
      spaceId: 'space-a',
      materialId: MATERIAL,
      versionId: V1,
      pageFrom: 1,
      pageTo: 5,
    });
    expect(started.created).toBe(true);
    const again = await begin(
      { spaceId: 'space-a', materialId: MATERIAL, versionId: V1, pageFrom: 1, pageTo: 5 },
      200,
    );
    expect(again).toEqual({ extractionId: started.extractionId, created: false });

    const detail = await detailOf(started.extractionId);
    expect(detail.extraction).toMatchObject({
      materialTitle: '高数习题册',
      versionId: V1,
      versionNo: 1,
      isCurrentVersion: false,
      sourceAvailable: true,
      strategy: 'rules-v1',
      usage: { modelCalls: 0 },
    });
    expect(detail.extraction.stats).toMatchObject({
      pageCount: 5,
      pagesRead: 5,
      skippedPages: [3],
      candidates: 4,
      choice: 3,
      open: 1,
      answersFromSource: 3,
      extractorId: 'unpdf',
    });
    expect(detail.candidates.map((candidate) => candidate.label)).toEqual(['1', '2', '3', '4']);
    expect(byLabel(detail, '1')).toMatchObject({
      section: '习题 1.1',
      pages: [1],
      answerBasis: 'source',
      answerRef: { kind: 'answer_key', page: 5 },
      content: { type: 'single', answer: ['B'], stem: '函数 f(x)=x² 在 x=1 处的导数是（ ）' },
    });
    // Across the page break, without the running head and page numbers.
    expect(byLabel(detail, '2').pages).toEqual([1, 2]);
    expect(byLabel(detail, '2').content.options.map((option) => option.label)).toEqual([
      '1/x',
      '|x|',
      'ln x',
      'tan(1/x)',
    ]);
    expect(byLabel(detail, '3').content).toMatchObject({ type: 'open', referenceAnswer: '1' });
    expect(byLabel(detail, '4')).toMatchObject({
      answerBasis: 'missing',
      content: { figures: ['img_1'], answer: [] },
    });

    const scannedOnly = await begin({
      spaceId: 'space-a',
      materialId: MATERIAL,
      versionId: V1,
      pageFrom: 3,
      pageTo: 3,
    });
    const scanned = await detailOf(scannedOnly.extractionId);
    expect(scanned.candidates).toEqual([]);
    expect(scanned.extraction.stats.skippedPages).toEqual([3]);

    const list = await json<{ extractions: ExtractionView[] }>(
      await listExtractions(request('GET', '/api/study/extractions?spaceId=space-a')),
      200,
    );
    expect(list.extractions).toHaveLength(2);
    // Out of range or too wide.
    const invalid = await startExtraction(
      request('POST', '/api/study/extractions', {
        spaceId: 'space-a',
        materialId: MATERIAL,
        versionId: V1,
        pageFrom: 2,
        pageTo: 9,
      }),
    );
    expect(await json(invalid, 422)).toMatchObject({ error: 'STUDY_EXTRACTION_RANGE_INVALID' });
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('corrects, splits, merges, takes model help and commits to the bank', async () => {
    const { extractionId } = await begin({
      spaceId: 'space-a',
      materialId: MATERIAL,
      versionId: V1,
    });
    let detail = await detailOf(extractionId);

    // A changed answer is the student's; a stale revision is refused with the stored copy.
    const first = byLabel(detail, '1');
    const changed = await patch(first, { content: { ...first.content, answer: ['C'] } });
    expect(changed.candidate).toMatchObject({ answerBasis: 'user', answerRef: null, edited: true });
    const stale = await patch(first, { checked: true }, 409);
    expect(stale.error).toBe('STUDY_REVISION_CONFLICT');
    // Figures must be images of this parse.
    const fourth = byLabel(detail, '4');
    expect(
      (await patch(fourth, { content: { ...fourth.content, figures: ['img_9'] } }, 422)).error,
    ).toBe('STUDY_CANDIDATE_INVALID');
    // Restoring brings back the printed answer.
    const restored = await act<{ candidate: CandidateView }>(changed.candidate, {
      action: 'restore',
    });
    expect(restored.candidate).toMatchObject({ answerBasis: 'source', content: { answer: ['B'] } });

    // Split question 2 before its options, then merge it back.
    const second = byLabel(detail, '2');
    detail = await act<ExtractionDetail>(second, { action: 'split', atLine: 1 });
    expect(detail.candidates).toHaveLength(5);
    const [head, tail] = [detail.candidates[1]!, detail.candidates[2]!];
    expect(head.content.type).toBe('open');
    expect(tail.content).toMatchObject({ type: 'single', answer: ['B'] });
    detail = await act<ExtractionDetail>(head, { action: 'merge' });
    expect(detail.candidates).toHaveLength(4);
    const merged = detail.candidates[1]!;
    expect(merged).toMatchObject({
      label: '2',
      pages: [1, 2],
      answerBasis: 'source',
      content: { type: 'single', answer: ['B'] },
    });
    expect(merged.content.options).toHaveLength(4);
    const checkedMerged = await patch(merged, { checked: true });
    expect(checkedMerged.candidate.checked).toBe(true);

    // Model help: a suggestion only, adopted explicitly, recorded as `model`.
    vi.mocked(gateway.complete).mockResolvedValueOnce({
      text: JSON.stringify({
        items: [
          {
            id: byLabel(detail, '4').id,
            type: 'single',
            stem: '如图所示，三角形 $ABC$ 中 $AB=AC$，则（ ）',
            options: [
              { value: 'A', label: '$\\angle B=\\angle C$' },
              { value: 'B', label: '$\\angle A=\\angle B$' },
            ],
            answer: ['A'],
            reason: '等腰三角形两底角相等。',
          },
        ],
      }),
      usage: { inputTokens: 120, outputTokens: 80 },
    } as never);
    const helped = await json<{ suggested: string[]; missing: string[]; detail: ExtractionDetail }>(
      await assist(
        request('POST', `/api/study/extractions/${extractionId}/assist`, {
          candidateIds: [byLabel(detail, '4').id, byLabel(detail, '3').id],
        }),
        params({ extractionId }),
      ),
      200,
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(helped.missing).toEqual([byLabel(detail, '3').id]);
    expect(helped.detail.extraction.usage).toMatchObject({
      modelCalls: 1,
      inputTokens: 120,
      outputTokens: 80,
      modelString: 'test:extract-model',
      usageCompleteness: 'complete',
    });
    const suggested = byLabel(helped.detail, '4');
    expect(suggested).toMatchObject({
      answerBasis: 'missing',
      content: { answer: [] },
      suggestion: { answer: ['A'], modelString: 'test:extract-model' },
    });
    const adopted = await act<{ candidate: CandidateView }>(suggested, { action: 'adopt' });
    expect(adopted.candidate).toMatchObject({
      answerBasis: 'model',
      checked: false,
      content: {
        answer: ['A'],
        stem: '如图所示，三角形 $ABC$ 中 $AB=AC$，则（ ）',
        figures: ['img_1'],
      },
    });

    // Commit: the open question cannot enter yet; the rest point at version 1.
    detail = await detailOf(extractionId);
    const ids = ['1', '2', '3', '4'].map((label) => byLabel(detail, label).id);
    const committed = await commitIds(extractionId, ids);
    expect(committed.outcomes.map((outcome) => outcome.status)).toEqual([
      'created',
      'created',
      'invalid',
      'created',
    ]);
    expect(committed.detail.extraction.counts).toMatchObject({ committed: 3, draft: 1 });
    const bank = await json<QuestionListResult>(
      await listBank(request('GET', '/api/study/question-bank?spaceId=space-a')),
      200,
    );
    expect(bank.counts).toMatchObject({ all: 3, gradable: 3, verified: 1 });
    const question = (label: string) =>
      bank.questions.find((entry) => entry.source?.material?.label === label)!;
    expect(question('2')).toMatchObject({
      origin: 'material_extracted',
      verification: 'user_verified',
      source: {
        title: '高数习题册',
        answerBasis: 'source',
        material: {
          materialId: MATERIAL,
          versionId: V1,
          versionNo: 1,
          artifactId: ART1,
          pages: [1, 2],
        },
      },
    });
    expect(question('1')).toMatchObject({
      verification: 'unverified',
      source: { answerBasis: 'source' },
    });
    expect(question('4')).toMatchObject({
      verification: 'unverified',
      source: { answerBasis: 'model' },
      figures: [{ materialId: MATERIAL, versionId: V1, artifactId: ART1, imageId: 'img_1' }],
    });
    // Repeating adds nothing.
    const repeated = await commitIds(extractionId, ids);
    expect(repeated.outcomes.map((outcome) => outcome.status)).toEqual([
      'skipped',
      'skipped',
      'invalid',
      'skipped',
    ]);

    // The figure travels into a paper and is served from the material version.
    const blueprint = {
      spaceId: 'space-a',
      sections: [{ type: 'single', count: 3 }],
      includeUnverified: true,
    };
    const shown = await json<{ preview: PaperPreview }>(
      await preview(request('POST', '/api/study/exams/preview', { blueprint })),
      200,
    );
    const paper = await json<{ paper: PaperSummary }>(
      await publish(
        request('POST', '/api/study/papers', {
          blueprint: { ...blueprint, seed: shown.preview.seed },
          title: '提取题练习',
          idempotencyKey: 'key-extract-1',
        }),
      ),
      201,
    );
    const attempt = (
      await json<{ attempt: AttemptView }>(
        await start(
          request('POST', `/api/study/papers/${paper.paper.id}/attempts`),
          params({ paperId: paper.paper.id }),
        ),
        201,
      )
    ).attempt;
    const withFigure = attempt.items.find((item) => item.figures.length)!;
    expect(withFigure.figures).toEqual([
      { materialId: MATERIAL, versionId: V1, artifactId: ART1, imageId: 'img_1' },
    ]);
    expect(withFigure.source.material).toMatchObject({ versionId: V1, label: '4' });
    const served = await image(
      request(
        'GET',
        `/api/study/materials/${MATERIAL}/versions/${V1}/images/img_1?artifact=${ART1}`,
      ),
      params({ materialId: MATERIAL, versionId: V1, imageId: 'img_1' }),
    );
    expect(served.status).toBe(200);

    // Unlinked from the space: no new commits or extractions; reading still works.
    await pg().query(`DELETE FROM study_space_materials WHERE owner_id = $1`, [OWNER]);
    const gone = await commitIds(extractionId, [ids[2]!], 409);
    expect(gone.error).toBe('STUDY_EXTRACTION_SOURCE_GONE');
    expect((await detailOf(extractionId)).extraction.sourceAvailable).toBe(false);
    expect(
      (
        await startExtraction(
          request('POST', '/api/study/extractions', { spaceId: 'space-a', materialId: MATERIAL }),
        )
      ).status,
    ).toBe(404);
    // Deleting the material removes the extraction; bank questions stay.
    await pg().query(`DELETE FROM study_materials WHERE owner_id = $1`, [OWNER]);
    expect((await detailOf(extractionId, 404)) as unknown).toMatchObject({
      error: 'STUDY_EXTRACTION_NOT_FOUND',
    });
    const after = await json<QuestionListResult>(
      await listBank(request('GET', '/api/study/question-bank?spaceId=space-a')),
      200,
    );
    expect(after.counts.all).toBe(3);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
  });

  it('shows another owner nothing and changes nothing for them', async () => {
    const { extractionId } = await begin({
      spaceId: 'space-a',
      materialId: MATERIAL,
      versionId: V1,
    });
    const detail = await detailOf(extractionId);
    const candidate = detail.candidates[0]!;
    owner.id = OTHER;
    const statuses = [
      (
        await getExtraction(
          request('GET', `/api/study/extractions/${extractionId}`),
          params({ extractionId }),
        )
      ).status,
      (await listExtractions(request('GET', '/api/study/extractions?spaceId=space-a'))).status,
      (
        await startExtraction(
          request('POST', '/api/study/extractions', { spaceId: 'space-b', materialId: MATERIAL }),
        )
      ).status,
      (
        await startExtraction(
          request('POST', '/api/study/extractions', { spaceId: 'space-a', materialId: MATERIAL }),
        )
      ).status,
      (
        await patchCandidate(
          request('PATCH', `/api/study/extraction-candidates/${candidate.id}`, {
            revision: candidate.revision,
            status: 'discarded',
          }),
          params({ candidateId: candidate.id }),
        )
      ).status,
      (
        await candidateAction(
          request('POST', `/api/study/extraction-candidates/${candidate.id}/actions`, {
            revision: candidate.revision,
            action: 'merge',
          }),
          params({ candidateId: candidate.id }),
        )
      ).status,
      (
        await commit(
          request('POST', `/api/study/extractions/${extractionId}/commit`, {
            candidateIds: [candidate.id],
          }),
          params({ extractionId }),
        )
      ).status,
      (
        await assist(
          request('POST', `/api/study/extractions/${extractionId}/assist`, {
            candidateIds: [candidate.id],
          }),
          params({ extractionId }),
        )
      ).status,
      (
        await deleteExtraction(
          request('DELETE', `/api/study/extractions/${extractionId}`),
          params({ extractionId }),
        )
      ).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404, 404, 404, 404]);
    owner.id = OWNER;
    const unchanged = await detailOf(extractionId);
    expect(unchanged.candidates).toEqual(detail.candidates);
    const rows = await pg().query(
      `SELECT count(*)::int AS n FROM study_question_extractions WHERE owner_id = $1`,
      [OTHER],
    );
    expect(rows.rows).toEqual([{ n: 0 }]);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('keeps public-source details and lets papers leave those questions out', async () => {
    const questions = [1, 2].map((n) => ({
      type: 'single',
      stem: `公开题 ${n}：1+${n}=?`,
      options: [String(1 + n), String(2 + n)],
      answer: 'A',
      verified: true,
    }));
    const result = await json<{ created: number }>(
      await imports(
        request('POST', '/api/study/question-bank/imports', {
          spaceId: 'space-a',
          commit: true,
          questions,
          publicSource: {
            title: '某公开题库',
            url: 'https://example.org/bank.json',
            retrievedAt: '2026-10-12',
            version: 'v3',
            license: '未注明',
          },
        }),
      ),
      200,
    );
    expect(result.created).toBe(2);
    const bank = await json<QuestionListResult>(
      await listBank(request('GET', '/api/study/question-bank?spaceId=space-a')),
      200,
    );
    expect(bank.questions[0]).toMatchObject({
      origin: 'public_source',
      source: {
        title: '某公开题库',
        url: 'https://example.org/bank.json',
        retrievedAt: '2026-10-12',
        version: 'v3',
        licenseStatus: 'unclear',
      },
    });
    const invalid = await imports(
      request('POST', '/api/study/question-bank/imports', {
        spaceId: 'space-a',
        commit: true,
        questions,
        publicSource: { url: 'ftp://example.org', retrievedAt: 'yesterday' },
      }),
    );
    expect(await json(invalid, 400)).toMatchObject({ field: 'publicSource' });
    const shown = async (includePublic: boolean) =>
      (
        await json<{ preview: PaperPreview }>(
          await preview(
            request('POST', '/api/study/exams/preview', {
              blueprint: {
                spaceId: 'space-a',
                sections: [{ type: 'single', count: 2 }],
                includePublic,
              },
            }),
          ),
          200,
        )
      ).preview;
    expect((await shown(true)).items.map((item) => item.tier)).toEqual(['public', 'public']);
    expect((await shown(false)).available).toEqual({ single: 0 });
    expect(gateway.complete).not.toHaveBeenCalled();
  });
});
