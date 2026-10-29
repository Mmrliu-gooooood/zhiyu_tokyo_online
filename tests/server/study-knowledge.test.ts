/**
 * Retrieval and cited answers (learning plan B03) end to end on real
 * PostgreSQL with vector + pgroonga: index tasks through the shared learning
 * queue, the active-index swap, scope and version pins, owner isolation,
 * hybrid and keyword-only search, keyword-only indexes (the default mode, no
 * vectors), answers with server-approved citations (faux model), lost leases,
 * material purge and the permanent-delete fate of citations.
 *
 * Needs TEST_STUDY_KNOWLEDGE_DATABASE_URL: the admin URL of a disposable
 * *_rls_proof database on 127.0.0.1 whose server offers both extensions
 * (spikes/b03-candidate-a/Dockerfile). Skipped otherwise.
 */
import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureDocumentSchema, type Queryable } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';

import { createEmbeddingBinding, GatewayError, type EmbeddingGateway } from '@/lib/model-gateway';
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
} from '@/lib/model-gateway/testing/faux-gateway';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import { LearningTaskQueue, getLearningTask } from '@/lib/server/learning-tasks/repository';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import { purgeStudyMaterial } from '@/lib/server/study/materials/service';
import { runMaterialIndexTask } from '@/lib/server/study/knowledge/index-task';
import { STUDY_KEYWORD_SIGNATURE } from '@/lib/server/study/knowledge/config';
import {
  listSpaceKnowledge,
  listStudyAnswers,
  requestStudyIndexBuild,
  resetKnowledgeStorageReadiness,
  resolveQuestionScope,
  searchStudyKnowledge,
} from '@/lib/server/study/knowledge/repository';
import { askSpace, searchSpace } from '@/lib/server/study/knowledge/ask';
import { questionTerms } from '@/lib/server/study/knowledge/query-terms';
import { fakeEmbedding, loadStudyQaFixture } from '@/eval/study-qa/fixture';
import { seedStudyQaFixture, type SeededFixture } from '@/eval/study-qa/seed';

const adminUrl = process.env.TEST_STUDY_KNOWLEDGE_DATABASE_URL?.trim();
const fixture = loadStudyQaFixture();
const A = fixture.owners.A;
const B = fixture.owners.B;

const binding = createEmbeddingBinding(
  { providerId: 'fake-embed', modelId: 'hash-1024', dimensions: 1024 },
  { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test' },
);

let embedFailure: GatewayError | null = null;
const fakeEmbeddings: EmbeddingGateway = {
  embed: async (_binding, inputs) => {
    if (embedFailure) throw embedFailure;
    return {
      vectors: inputs.map((text) => fakeEmbedding(text)),
      inputTokens: inputs.length * 10,
      attempts: 1,
    };
  },
};

let admin: Pool;
let pool: Pool;
let dbName: string;
let study: StudyDb;
let queue: LearningTaskQueue;
let bytes: Map<string, Buffer>;
let seeded: SeededFixture;

function studyDb(p: Pool): StudyDb {
  return Object.assign(
    { query: ((sql: string, params?: unknown[]) => p.query(sql, params)) as Queryable['query'] },
    {
      withTransaction: async <T>(body: (tx: Queryable) => Promise<T>) => {
        const client = await p.connect();
        try {
          await client.query('BEGIN');
          const result = await body({
            query: ((sql: string, params?: unknown[]) =>
              client.query(sql, params)) as Queryable['query'],
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    },
  );
}

async function indexVersion(owner: string, key: string, no: number) {
  const material = seeded.materials.get(key)!;
  const version = material.versions.get(no)!;
  const outcome = await requestStudyIndexBuild(study, owner, {
    materialId: material.materialId,
    versionId: version.versionId,
    signature: binding.signature,
  });
  if (outcome.status !== 'queued') return outcome;
  const lease = await queue.claim('worker-1', ['material_index']);
  if (!lease) throw new Error('expected an index task');
  await runMaterialIndexTask(
    lease,
    { queue, signal: new AbortController().signal },
    { embeddingBinding: () => binding, embed: fakeEmbeddings.embed },
  );
  return { ...outcome, task: (await getLearningTask(study, owner, lease.taskId))! };
}

const transact = <T>(body: (tx: Queryable) => Promise<T>) => study.withTransaction(body);

describe.skipIf(!adminUrl)('study knowledge on PostgreSQL + vector + pgroonga', () => {
  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (parsed.hostname !== '127.0.0.1' || !parsed.pathname.endsWith('_rls_proof')) {
      throw new Error(
        'TEST_STUDY_KNOWLEDGE_DATABASE_URL must be a disposable *_rls_proof database',
      );
    }
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    dbName = `study_knowledge_e2e_${randomBytes(5).toString('hex')}_rls_proof`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    parsed.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: parsed.toString(), max: 4 });
    const q: Queryable = {
      query: ((sql: string, p?: unknown[]) => pool.query(sql, p)) as Queryable['query'],
    };
    await ensureDocumentSchema(q);
    await ensureStageMetaSchema(q);
    await ensureOwnerMaterialSchema(q);
    await ensureAssetSchema(q);
    await ensureStudySchema(q);
    await migrateGenerationSchema(pool as never);
    study = studyDb(pool);
    queue = new LearningTaskQueue(pool as never, { leaseMs: 60_000, queueWaitMs: 3_600_000 });
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
    resetKnowledgeStorageReadiness();
    seeded = await seedStudyQaFixture(q, fixture, async (key, body) => void bytes.set(key, body));
  }, 120_000);

  afterAll(async () => {
    setMaterialByteStoreForTests(null);
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  beforeEach(async () => {
    embedFailure = null;
    await queue.workerHeartbeat('host-1', false, ['material_parse', 'material_index']);
  });

  it('refuses index builds while no worker runs material_index', async () => {
    await queue.workerHeartbeat('host-1', false, ['material_parse']);
    const ds = seeded.materials.get('ds')!;
    await expect(
      requestStudyIndexBuild(study, A, {
        materialId: ds.materialId,
        versionId: ds.versions.get(1)!.versionId,
        signature: binding.signature,
      }),
    ).rejects.toMatchObject({ code: 'STUDY_TASKS_UNAVAILABLE' });
  });

  it('indexes every version through the learning queue and reports state', async () => {
    for (const material of fixture.materials) {
      for (const version of material.versions) {
        const outcome = await indexVersion(
          fixture.owners[material.owner],
          material.key,
          version.no,
        );
        expect(outcome.status).toBe('queued');
      }
    }
    const status = await transact((tx) =>
      listSpaceKnowledge(tx, A, seeded.spaceIds.A, binding.signature, true),
    );
    const calc = status.find((material) => material.materialId === 'smat_eval_calc')!;
    expect(calc.versions[0]).toMatchObject({ state: 'ready', parsed: true });
    // The scanned page (no text layer) is reported, not indexed.
    expect(calc.versions[0]!.index!.unparsedPages).toEqual([5]);
    // A second request for an up-to-date index starts nothing.
    const again = await requestStudyIndexBuild(study, A, {
      materialId: 'smat_eval_calc',
      versionId: 'sver_eval_calc_1',
      signature: binding.signature,
    });
    expect(again.status).toBe('up_to_date');
    // Task usage is recorded on the attempt, completeness known.
    const attempts = await pool.query(
      `SELECT a.usage, a.usage_completeness FROM learning_task_attempts a
         JOIN learning_tasks t ON t.id=a.task_id
        WHERE t.subject_id='index:sver_eval_calc_1' AND a.outcome='succeeded'`,
    );
    expect(attempts.rows[0]).toMatchObject({
      usage_completeness: 'complete',
      usage: expect.objectContaining({
        chunks: 8,
        embeddingCalls: 1,
        embeddingModel: binding.modelString,
      }),
    });
  });

  it('scopes questions to current versions, exact pins and the owner', async () => {
    const scope = await transact((tx) =>
      resolveQuestionScope(tx, A, seeded.spaceIds.A, binding.signature, []),
    );
    expect(scope.map((index) => index.versionId)).toContain('sver_eval_supp_2');
    expect(scope.map((index) => index.versionId)).not.toContain('sver_eval_supp_1');
    expect(scope.every((index) => index.isCurrent)).toBe(true);
    const pinned = await transact((tx) =>
      resolveQuestionScope(tx, A, seeded.spaceIds.A, binding.signature, ['sver_eval_supp_1']),
    );
    expect(pinned.map((index) => [index.versionId, index.isCurrent])).toEqual([
      ['sver_eval_supp_1', false],
    ]);
    // B's version cannot be pinned by A, nor can A use B's space.
    await expect(
      transact((tx) =>
        resolveQuestionScope(tx, A, seeded.spaceIds.A, binding.signature, ['sver_eval_linalg_b_1']),
      ),
    ).rejects.toMatchObject({ code: 'STUDY_QA_INVALID_SCOPE' });
    await expect(
      transact((tx) => resolveQuestionScope(tx, A, seeded.spaceIds.B, binding.signature, [])),
    ).rejects.toMatchObject({ code: 'STUDY_SPACE_NOT_FOUND' });
    // An index built with another embedding model is not searchable with this one.
    const other = await transact((tx) =>
      resolveQuestionScope(tx, A, seeded.spaceIds.A, 'other-model#1024#x', []),
    );
    expect(other).toEqual([]);
  });

  it('retrieves hybrid and keyword-only hits with exact locations', async () => {
    const scope = await transact((tx) =>
      resolveQuestionScope(tx, A, seeded.spaceIds.A, binding.signature, []),
    );
    const question = 'arctan x 的导数是什么？';
    const hybrid = await transact((tx) =>
      searchStudyKnowledge(tx, A, scope, questionTerms(question), fakeEmbedding(question), 5),
    );
    expect(
      hybrid.some((hit) => hit.index.versionId === 'sver_eval_calc_1' && hit.pageNumber === 4),
    ).toBe(true);
    expect(hybrid[0]!.method).toBe('hybrid');
    const lexical = await transact((tx) =>
      searchStudyKnowledge(tx, A, scope, questionTerms(question), null, 5),
    );
    expect(lexical.every((hit) => hit.method === 'lexical' && hit.vectorRank === null)).toBe(true);
    // A question only B's material answers returns nothing of B's to A.
    const foreign = await transact((tx) =>
      searchStudyKnowledge(
        tx,
        A,
        scope,
        questionTerms('矩阵可逆的充要条件'),
        fakeEmbedding('矩阵可逆'),
        5,
      ),
    );
    expect(foreign.every((hit) => hit.index.materialId !== 'smat_eval_linalg_b')).toBe(true);
    // searchSpace falls back to keywords (and says so) when embedding fails.
    embedFailure = new GatewayError('MODEL_UPSTREAM_UNAVAILABLE', {
      providerId: 'x',
      modelId: 'y',
    });
    const fallback = await searchSpace(
      transact,
      {
        ownerId: A,
        spaceId: seeded.spaceIds.A,
        question,
        pinnedVersionIds: [],
        embedding: binding,
        signature: binding.signature,
        signal: new AbortController().signal,
        requestId: 'r1',
      },
      { embeddings: fakeEmbeddings },
    );
    expect(fallback.retrieval).toBe('lexical');
    expect(fallback.hits.length).toBeGreaterThan(0);
  });

  it('saves answers with server-approved citations only', async () => {
    const faux = createFauxGateway({
      responses: [
        fauxAssistantMessage(
          fauxText(
            JSON.stringify({
              status: 'answered',
              segments: [
                { kind: 'grounded', text: 'arctan x 的导数是 1/(1+x²)。', citations: ['E1', 'E9'] },
                { kind: 'grounded', text: '这是一个编造的结论。', citations: ['E42'] },
                { kind: 'supplement', text: '可以用反函数求导法则推导。' },
              ],
            }),
          ),
        ),
      ],
    });
    const answer = await askSpace(
      transact,
      {
        ownerId: A,
        spaceId: seeded.spaceIds.A,
        question: 'arctan x 的导数是什么？',
        pinnedVersionIds: [],
        model: faux.binding(),
        embedding: binding,
        signature: binding.signature,
        signal: new AbortController().signal,
        requestId: 'req-ask-1',
      },
      { gateway: faux.gateway, embeddings: fakeEmbeddings },
    );
    expect(answer.status).toBe('answered');
    expect(answer.segments.map((segment) => segment.kind)).toEqual([
      'grounded',
      'supplement',
      'supplement',
    ]);
    expect(answer.segments[0]).toMatchObject({ citations: ['E1'] });
    expect(answer.citations.map((citation) => citation.ref)).toEqual(['E1']);
    const cited = answer.citations[0]!;
    expect(cited.sourceDeleted).toBe(false);
    expect(cited.versionId).toMatch(/^sver_eval_/);
    expect(cited.quote.length).toBeGreaterThan(0);
    expect(answer.usage).toMatchObject({ embeddingCalls: 1, modelCalls: 1, fundingKind: 'byok' });
    expect(faux.calls).toHaveLength(1);
    const listed = await transact((tx) => listStudyAnswers(tx, A, seeded.spaceIds.A));
    expect(listed[0]!.answerId).toBe(answer.answerId);
    expect(await transact((tx) => listStudyAnswers(tx, B, seeded.spaceIds.A))).toEqual([]);
  });

  it('answers "not found" with only a labelled model supplement when nothing matches', async () => {
    let prompt = '';
    const faux = createFauxGateway({
      responses: [
        (context) => {
          prompt = JSON.stringify(context.messages);
          return fauxAssistantMessage(
            fauxText(
              JSON.stringify({
                status: 'answered',
                segments: [
                  { kind: 'grounded', text: '编造的资料依据。', citations: ['E1'] },
                  { kind: 'supplement', text: '这是通用知识的解释。' },
                ],
                not_found_note: '资料里没有相关内容',
              }),
            ),
          );
        },
      ],
    });
    const answer = await askSpace(
      transact,
      {
        ownerId: B,
        spaceId: seeded.spaceIds.B,
        question: 'qwertyuiop zxcvbnm',
        pinnedVersionIds: [],
        model: faux.binding(),
        embedding: null,
        signature: binding.signature,
        signal: new AbortController().signal,
        requestId: 'req-ask-2',
      },
      { gateway: faux.gateway, embeddings: fakeEmbeddings },
    );
    // No passages were given, so nothing can be presented as evidence.
    expect(answer).toMatchObject({
      status: 'not_found',
      retrieval: 'keyword',
      citations: [],
      segments: [
        { kind: 'supplement', text: '编造的资料依据。' },
        { kind: 'supplement', text: '这是通用知识的解释。' },
      ],
    });
    expect(faux.calls).toHaveLength(1);
    expect(prompt).toContain('资料片段：无');
    expect(answer.usage).toMatchObject({ embeddingCalls: 0, modelCalls: 1 });
  });

  it('answers from the model alone when nothing in the space is indexed', async () => {
    let prompt = '';
    const faux = createFauxGateway({
      responses: [
        (context) => {
          prompt = JSON.stringify(context.messages);
          return fauxAssistantMessage(
            fauxText(
              JSON.stringify({
                status: 'not_found',
                segments: [{ kind: 'supplement', text: '中值定理要求函数在闭区间上连续。' }],
                not_found_note: '没有资料',
              }),
            ),
          );
        },
      ],
    });
    const answer = await askSpace(
      transact,
      {
        ownerId: B,
        spaceId: seeded.spaceIds.B,
        question: '拉格朗日中值定理的条件是什么？',
        pinnedVersionIds: [],
        model: faux.binding(),
        embedding: binding,
        // No index was built with this signature, so the scope is empty.
        signature: 'unindexed@1',
        signal: new AbortController().signal,
        requestId: 'req-ask-unindexed',
      },
      { gateway: faux.gateway, embeddings: fakeEmbeddings },
    );
    expect(answer).toMatchObject({
      status: 'not_found',
      retrieval: 'none',
      citations: [],
      segments: [{ kind: 'supplement', text: '中值定理要求函数在闭区间上连续。' }],
    });
    expect(prompt).toContain('这个学科还没有可检索的资料');
    // No query embedding is spent when there is nothing to search.
    expect(answer.usage).toMatchObject({ embeddingCalls: 0, modelCalls: 1 });
  });

  it('keeps the serving index until a rebuild commits, and a fenced build writes nothing', async () => {
    const before = await pool.query(
      `SELECT id FROM study_knowledge_indexes WHERE version_id='sver_eval_ds_1' AND active`,
    );
    // A re-parse: the version now has a new active artifact.
    await pool.query(
      `INSERT INTO study_material_artifacts (id, owner_id, version_id, fingerprint, extractor_id,
         extractor_version, transform_version, artifact_key, text_key, paged, page_count)
       SELECT 'sart_eval_ds_1b', owner_id, version_id, repeat('e', 64), 'unpdf', 'fixture2',
              transform_version, artifact_key, text_key, true, page_count
         FROM study_material_artifacts WHERE id='sart_eval_ds_1'`,
    );
    await pool.query(
      `UPDATE study_material_versions SET active_artifact_id='sart_eval_ds_1b' WHERE id='sver_eval_ds_1'`,
    );
    const stale = await transact((tx) =>
      listSpaceKnowledge(tx, A, seeded.spaceIds.A, binding.signature, true),
    );
    expect(stale.find((m) => m.materialId === 'smat_eval_ds')!.versions[0]!.state).toBe('stale');
    // Lost lease: the build is fenced out and nothing is written.
    const outcome = await requestStudyIndexBuild(study, A, {
      materialId: 'smat_eval_ds',
      versionId: 'sver_eval_ds_1',
      signature: binding.signature,
    });
    expect(outcome.status).toBe('queued');
    const lease = (await queue.claim('worker-1', ['material_index']))!;
    await pool.query(`UPDATE learning_tasks SET lease_epoch=lease_epoch+1 WHERE id=$1`, [
      lease.taskId,
    ]);
    await runMaterialIndexTask(
      lease,
      { queue, signal: new AbortController().signal },
      { embeddingBinding: () => binding, embed: fakeEmbeddings.embed },
    );
    const during = await pool.query(
      `SELECT id FROM study_knowledge_indexes WHERE version_id='sver_eval_ds_1'`,
    );
    expect(during.rows).toEqual(before.rows);
    // A successful rebuild swaps in the new index and removes the old one.
    await pool.query(
      `UPDATE learning_tasks SET status='failed', worker_id=NULL, lease_expires_at=NULL,
              finished_at=clock_timestamp() WHERE id=$1`,
      [lease.taskId],
    );
    await indexVersion(A, 'ds', 1);
    const after = await pool.query<{ id: string; artifact_id: string; active: boolean }>(
      `SELECT id, artifact_id, active FROM study_knowledge_indexes WHERE version_id='sver_eval_ds_1'`,
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({ artifact_id: 'sart_eval_ds_1b', active: true });
    expect(after.rows[0]!.id).not.toBe(before.rows[0]!.id);
    const orphanChunks = await pool.query(
      `SELECT count(*)::int AS n FROM study_knowledge_chunks WHERE index_id=$1`,
      [before.rows[0]!.id],
    );
    expect(orphanChunks.rows[0]!.n).toBe(0);
  });

  it('retries a transient embedding failure and stops on a model change', async () => {
    const outcome = await requestStudyIndexBuild(study, A, {
      materialId: 'smat_eval_os',
      versionId: 'sver_eval_os_1',
      signature: binding.signature,
    });
    // os is already indexed: drop it to force a build.
    if (outcome.status === 'up_to_date') {
      await pool.query(`DELETE FROM study_knowledge_indexes WHERE version_id='sver_eval_os_1'`);
    }
    await requestStudyIndexBuild(study, A, {
      materialId: 'smat_eval_os',
      versionId: 'sver_eval_os_1',
      signature: binding.signature,
    });
    embedFailure = new GatewayError('MODEL_RATE_LIMITED', { providerId: 'x', modelId: 'y' });
    const lease = (await queue.claim('worker-1', ['material_index']))!;
    await runMaterialIndexTask(
      lease,
      { queue, signal: new AbortController().signal },
      { embeddingBinding: () => binding, embed: fakeEmbeddings.embed },
    );
    const task = await getLearningTask(study, A, lease.taskId);
    expect(task).toMatchObject({ status: 'retry_wait', lastErrorCode: 'EMBEDDING_RATE_LIMITED' });
    // The operator switches the embedding model before the retry runs.
    embedFailure = null;
    await pool.query(`UPDATE learning_tasks SET available_at=clock_timestamp() WHERE id=$1`, [
      lease.taskId,
    ]);
    const retry = (await queue.claim('worker-1', ['material_index']))!;
    const changed = createEmbeddingBinding(
      { providerId: 'fake-embed', modelId: 'other', dimensions: 1024 },
      { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test' },
    );
    await runMaterialIndexTask(
      retry,
      { queue, signal: new AbortController().signal },
      { embeddingBinding: () => changed, embed: fakeEmbeddings.embed },
    );
    expect(await getLearningTask(study, A, lease.taskId)).toMatchObject({
      status: 'failed',
      lastErrorCode: 'EMBEDDING_MODEL_CHANGED',
      retryable: false,
    });
  });

  it('builds keyword-only indexes without vectors and searches them without embeddings', async () => {
    const ds = seeded.materials.get('ds')!;
    const versionId = ds.versions.get(1)!.versionId;
    // The hybrid index of the version is stale for the keyword mode but keeps serving it.
    const before = await transact((tx) =>
      listSpaceKnowledge(tx, A, seeded.spaceIds.A, STUDY_KEYWORD_SIGNATURE, true),
    );
    expect(before.find((m) => m.materialId === ds.materialId)!.versions[0]!.state).toBe('stale');
    const outcome = await requestStudyIndexBuild(study, A, {
      materialId: ds.materialId,
      versionId,
      signature: STUDY_KEYWORD_SIGNATURE,
    });
    expect(outcome.status).toBe('queued');
    const lease = (await queue.claim('worker-1', ['material_index']))!;
    await runMaterialIndexTask(
      lease,
      { queue, signal: new AbortController().signal },
      {
        embeddingBinding: () => null,
        embed: async () => {
          throw new Error('keyword-only indexing must not embed');
        },
      },
    );
    expect(await getLearningTask(study, A, lease.taskId)).toMatchObject({ status: 'succeeded' });
    const stored = await pool.query<{ signature: string; chunks: number; vectors: number }>(
      `SELECT i.embedding_signature AS signature, count(c.*)::int AS chunks,
              count(c.embedding)::int AS vectors
         FROM study_knowledge_indexes i JOIN study_knowledge_chunks c ON c.index_id=i.id
        WHERE i.version_id=$1 AND i.active GROUP BY 1`,
      [versionId],
    );
    expect(stored.rows).toEqual([
      { signature: STUDY_KEYWORD_SIGNATURE, chunks: expect.any(Number), vectors: 0 },
    ]);
    const attempt = await pool.query(
      `SELECT usage, usage_completeness FROM learning_task_attempts WHERE task_id=$1`,
      [lease.taskId],
    );
    expect(attempt.rows[0]).toMatchObject({
      usage_completeness: 'complete',
      usage: expect.objectContaining({ embeddingCalls: 0, embeddingModel: null }),
    });
    const after = await transact((tx) =>
      listSpaceKnowledge(tx, A, seeded.spaceIds.A, STUDY_KEYWORD_SIGNATURE, true),
    );
    expect(after.find((m) => m.materialId === ds.materialId)!.versions[0]!.state).toBe('ready');

    const question = '用邻接表存储时 DFS 和 BFS 的时间复杂度是多少？';
    const result = await searchSpace(
      transact,
      {
        ownerId: A,
        spaceId: seeded.spaceIds.A,
        question,
        pinnedVersionIds: [],
        embedding: null,
        signature: STUDY_KEYWORD_SIGNATURE,
        signal: new AbortController().signal,
        requestId: 'r-keyword',
      },
      { embeddings: { embed: async () => Promise.reject(new Error('no embedding expected')) } },
    );
    expect(result.retrieval).toBe('keyword');
    expect(result.hits.length).toBeGreaterThan(0);
    expect(
      result.hits.every((hit) => hit.versionId === versionId && hit.method === 'lexical'),
    ).toBe(true);
    // A query vector over vector-less chunks only uses the keyword leg.
    const scope = await transact((tx) =>
      resolveQuestionScope(tx, A, seeded.spaceIds.A, STUDY_KEYWORD_SIGNATURE, []),
    );
    const mixed = await transact((tx) =>
      searchStudyKnowledge(tx, A, scope, questionTerms(question), fakeEmbedding(question), 5),
    );
    expect(mixed.length).toBeGreaterThan(0);
    expect(mixed.every((hit) => hit.vectorRank === null)).toBe(true);
  });

  it('permanent delete stops retrieval, removes indexes and keeps the answer text', async () => {
    const answered = await transact((tx) => listStudyAnswers(tx, A, seeded.spaceIds.A));
    const cited = answered[0]!.citations[0]!;
    const material = [...seeded.materials.values()].find((m) => m.materialId === cited.materialId)!;
    expect(material).toBeTruthy();
    const result = await purgeStudyMaterial(study, A, cited.materialId);
    expect(result.deleted).toBe(true);
    const left = await pool.query<{ indexes: number; chunks: number; tasks: number }>(
      `SELECT (SELECT count(*)::int FROM study_knowledge_indexes WHERE material_id=$1) AS indexes,
              (SELECT count(*)::int FROM study_knowledge_chunks WHERE material_id=$1) AS chunks,
              (SELECT count(*)::int FROM learning_tasks
                WHERE subject_id LIKE 'index:%' AND input->>'materialId'=$1) AS tasks`,
      [cited.materialId],
    );
    expect(left.rows[0]).toEqual({ indexes: 0, chunks: 0, tasks: 0 });
    const after = await transact((tx) => listStudyAnswers(tx, A, seeded.spaceIds.A));
    const same = after.find((answer) => answer.answerId === answered[0]!.answerId)!;
    expect(same.segments[0]!.text).toContain('arctan');
    expect(same.citations.find((citation) => citation.ref === cited.ref)).toMatchObject({
      sourceDeleted: true,
      quote: '',
    });
    await expect(
      transact((tx) =>
        resolveQuestionScope(tx, A, seeded.spaceIds.A, binding.signature, [cited.versionId]),
      ),
    ).rejects.toBeInstanceOf(StudyError);
  });
});
