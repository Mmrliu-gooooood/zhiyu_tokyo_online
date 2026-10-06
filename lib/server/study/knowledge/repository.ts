/**
 * Retrieval persistence on the owner-bound web pool (learning plan B03):
 * per-version index state, index build/delete requests, the allowed scope of
 * a question, the hybrid search call and saved answers with their citations.
 *
 * Scope is computed here, on the server, from the space's live materials and
 * their usable indexes (and the versions a question is pinned to); it is
 * passed into the SQL that produces candidates, never applied afterwards.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import {
  cancelLearningTasksForSubjects,
  enqueueLearningTask,
  isLearningTaskWorkerLive,
  listLearningTasksForSubjects,
} from '@/lib/server/learning-tasks/repository';
import { isStudyTaskIntakeOpen } from '@/lib/server/study/flags';
import type { LearningTaskView } from '@/lib/study/tasks/contracts';
import {
  STUDY_QA_LIMITS,
  type StudyAnswerCitation,
  type StudyAnswerSegment,
  type StudyAnswerUsage,
  type StudyAnswerView,
  type StudyIndexState,
  type StudyKnowledgeMaterialView,
} from '@/lib/study/knowledge/contracts';

import { STUDY_CHUNK_POLICY_KEY } from './config';

export function createStudyIndexId(): string {
  return `skix-${randomBytes(9).toString('base64url')}`;
}
export function createStudyAnswerId(): string {
  return `sqa-${randomBytes(9).toString('base64url')}`;
}

/** Index tasks use their own subject so B02's per-version parse status is unaffected. */
export function indexTaskSubject(versionId: string): string {
  return `index:${versionId}`;
}

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

let storageReady: boolean | undefined;

/** Whether this database has the extension-backed chunk storage of v24. */
export async function knowledgeStorageReady(q: Queryable): Promise<boolean> {
  if (storageReady) return true;
  try {
    const result = await q.query<{ ready: boolean }>(
      `SELECT to_regclass('public.study_knowledge_chunks') IS NOT NULL
          AND to_regclass('public.study_knowledge_indexes') IS NOT NULL
          AND to_regproc('public.study_knowledge_search') IS NOT NULL AS ready`,
    );
    storageReady = result.rows[0]?.ready === true ? true : undefined;
    return storageReady === true;
  } catch {
    return false;
  }
}

/** Test seam: forget the cached readiness. */
export function resetKnowledgeStorageReadiness(): void {
  storageReady = undefined;
}

// ── status ────────────────────────────────────────────────────────────────

interface VersionStatusRow extends Record<string, unknown> {
  material_id: string;
  title: string;
  current_version_id: string | null;
  version_id: string;
  version_no: number;
  original_name: string;
  active_artifact_id: string | null;
  index_id: string | null;
  index_artifact_id: string | null;
  chunk_policy: string | null;
  embedding_signature: string | null;
  chunk_count: number | null;
  unparsed_pages: unknown;
  index_created_at: string | Date | null;
}

function indexState(
  row: VersionStatusRow,
  task: LearningTaskView | null,
  signature: string | null,
): StudyIndexState {
  if (task && ['queued', 'running', 'retry_wait'].includes(task.status)) return 'indexing';
  if (row.index_id) {
    const stale =
      row.index_artifact_id !== row.active_artifact_id ||
      row.chunk_policy !== STUDY_CHUNK_POLICY_KEY ||
      (signature !== null && row.embedding_signature !== signature);
    return stale ? 'stale' : 'ready';
  }
  if (!row.active_artifact_id) return 'not_parsed';
  if (task && (task.status === 'failed' || task.status === 'cancelled')) return 'failed';
  return 'not_indexed';
}

/** Every version of the space's live materials with its index state. */
export async function listSpaceKnowledge(
  tx: Queryable,
  ownerId: string,
  spaceId: string,
  signature: string | null,
  storage: boolean,
): Promise<StudyKnowledgeMaterialView[]> {
  const space = await tx.query('SELECT 1 FROM study_spaces WHERE owner_id=$1 AND id=$2', [
    ownerId,
    spaceId,
  ]);
  if (space.rows.length === 0) throw new StudyError('STUDY_SPACE_NOT_FOUND');
  const rows = await tx.query<VersionStatusRow>(
    `SELECT m.id AS material_id, m.title, m.current_version_id,
            v.id AS version_id, v.version_no, v.original_name, v.active_artifact_id,
            i.id AS index_id, i.artifact_id AS index_artifact_id, i.chunk_policy,
            i.embedding_signature, i.chunk_count, i.unparsed_pages, i.created_at AS index_created_at
       FROM study_space_materials sm
       JOIN study_materials m ON m.owner_id=sm.owner_id AND m.id=sm.material_id AND m.status='active'
       JOIN study_material_versions v ON v.owner_id=m.owner_id AND v.material_id=m.id
       ${
         storage
           ? `LEFT JOIN study_knowledge_indexes i
                ON i.owner_id=v.owner_id AND i.version_id=v.id AND i.active`
           : `LEFT JOIN (SELECT NULL::text AS id, NULL::text AS artifact_id, NULL::text AS chunk_policy,
                     NULL::text AS embedding_signature, NULL::int AS chunk_count,
                     NULL::jsonb AS unparsed_pages, NULL::timestamptz AS created_at) i ON false`
       }
      WHERE sm.owner_id=$1 AND sm.space_id=$2
      ORDER BY m.title, m.id, v.version_no DESC`,
    [ownerId, spaceId],
  );
  const tasks = await listLearningTasksForSubjects(
    tx,
    ownerId,
    rows.rows.map((row) => indexTaskSubject(row.version_id)),
    1,
  );
  const taskBySubject = new Map(tasks.map((task) => [task.subjectId, task]));
  const materials = new Map<string, StudyKnowledgeMaterialView>();
  for (const row of rows.rows) {
    const material = materials.get(row.material_id) ?? {
      materialId: row.material_id,
      title: row.title,
      versions: [],
    };
    const task = taskBySubject.get(indexTaskSubject(row.version_id)) ?? null;
    material.versions.push({
      versionId: row.version_id,
      versionNo: Number(row.version_no),
      isCurrent: row.version_id === row.current_version_id,
      originalName: row.original_name,
      parsed: Boolean(row.active_artifact_id),
      state: indexState(row, task, signature),
      index: row.index_id
        ? {
            indexId: row.index_id,
            chunkCount: Number(row.chunk_count ?? 0),
            unparsedPages: Array.isArray(row.unparsed_pages)
              ? (row.unparsed_pages as unknown[]).filter((p): p is number => typeof p === 'number')
              : [],
            createdAt: iso(row.index_created_at ?? new Date()),
          }
        : null,
      task,
    });
    materials.set(row.material_id, material);
  }
  return [...materials.values()];
}

// ── index requests ────────────────────────────────────────────────────────

interface BuildTarget extends Record<string, unknown> {
  material_id: string;
  version_id: string;
  active_artifact_id: string | null;
  in_space: boolean;
}

export interface IndexBuildRequest {
  materialId: string;
  versionId: string;
  /** When given, the material must be linked to this space. */
  spaceId?: string;
  signature: string;
  idempotencyKey?: string;
}

export type IndexBuildOutcome =
  | { status: 'queued'; task: LearningTaskView; created: boolean }
  | { status: 'up_to_date'; indexId: string };

/**
 * Queue an index build of a parsed version (the active parse, current chunk
 * policy and embedding model). An up-to-date active index or a live task for
 * the version is returned instead of starting another build.
 */
export async function requestStudyIndexBuild(
  db: StudyDb,
  ownerId: string,
  request: IndexBuildRequest,
): Promise<IndexBuildOutcome> {
  return db.withTransaction(async (tx) => {
    const target = await tx.query<BuildTarget>(
      `SELECT v.material_id, v.id AS version_id, v.active_artifact_id,
              ${
                request.spaceId
                  ? `EXISTS (SELECT 1 FROM study_space_materials sm WHERE sm.owner_id=v.owner_id
                       AND sm.space_id=$4 AND sm.material_id=v.material_id)`
                  : 'true'
              } AS in_space
         FROM study_material_versions v
         JOIN study_materials m ON m.owner_id=v.owner_id AND m.id=v.material_id AND m.status='active'
        WHERE v.owner_id=$1 AND v.material_id=$2 AND v.id=$3
        FOR UPDATE OF v`,
      request.spaceId
        ? [ownerId, request.materialId, request.versionId, request.spaceId]
        : [ownerId, request.materialId, request.versionId],
    );
    const row = target.rows[0];
    if (!row || !row.in_space) throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
    if (!row.active_artifact_id) throw new StudyError('STUDY_MATERIAL_NOT_PARSED');
    const current = await tx.query<{ id: string }>(
      `SELECT id FROM study_knowledge_indexes
        WHERE owner_id=$1 AND version_id=$2 AND active AND artifact_id=$3
          AND chunk_policy=$4 AND embedding_signature=$5`,
      [
        ownerId,
        request.versionId,
        row.active_artifact_id,
        STUDY_CHUNK_POLICY_KEY,
        request.signature,
      ],
    );
    if (current.rows[0]) return { status: 'up_to_date', indexId: current.rows[0].id };
    const subject = indexTaskSubject(request.versionId);
    const [latest] = await listLearningTasksForSubjects(tx, ownerId, [subject], 1);
    if (latest && ['queued', 'running', 'retry_wait'].includes(latest.status)) {
      return { status: 'queued', task: latest, created: false };
    }
    const indexed = await tx.query<{ n: number | string }>(
      `SELECT COALESCE(sum(chunk_count), 0) AS n FROM study_knowledge_indexes
        WHERE owner_id=$1 AND active AND version_id<>$2`,
      [ownerId, request.versionId],
    );
    if (Number(indexed.rows[0]?.n ?? 0) >= STUDY_QA_LIMITS.maxIndexedChunksPerOwner) {
      throw new StudyError('STUDY_INDEX_QUOTA_EXCEEDED');
    }
    if (!isStudyTaskIntakeOpen() || !(await isLearningTaskWorkerLive(tx, 'material_index'))) {
      throw new StudyError('STUDY_TASKS_UNAVAILABLE');
    }
    const queued = await enqueueLearningTask(tx, {
      ownerId,
      kind: 'material_index',
      subjectId: subject,
      idempotencyKey:
        request.idempotencyKey ??
        `index:${request.versionId}:${row.active_artifact_id}:${Date.now()}`,
      input: {
        materialId: request.materialId,
        versionId: request.versionId,
        artifactId: row.active_artifact_id,
        chunkPolicy: STUDY_CHUNK_POLICY_KEY,
        embeddingSignature: request.signature,
        // Embedding calls are paid: an attempt lost mid-way is not replayed silently.
        externalCost: true,
      },
    });
    return { status: 'queued', ...queued };
  });
}

/** Remove a version's indexes (the material stays); cancels a running build. */
export async function deleteStudyVersionIndexes(
  db: StudyDb,
  ownerId: string,
  materialId: string,
  versionId: string,
): Promise<number> {
  return db.withTransaction(async (tx) => {
    const version = await tx.query(
      'SELECT 1 FROM study_material_versions WHERE owner_id=$1 AND material_id=$2 AND id=$3',
      [ownerId, materialId, versionId],
    );
    if (version.rows.length === 0) throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
    await cancelLearningTasksForSubjects(tx, ownerId, [indexTaskSubject(versionId)]);
    const deleted = await tx.query(
      'DELETE FROM study_knowledge_indexes WHERE owner_id=$1 AND version_id=$2 RETURNING id',
      [ownerId, versionId],
    );
    return deleted.rows.length;
  });
}

// ── question scope and search ─────────────────────────────────────────────

export interface ScopedIndex {
  indexId: string;
  materialId: string;
  title: string;
  versionId: string;
  versionNo: number;
  isCurrent: boolean;
  artifactId: string;
}

/**
 * Indexes a question may search: the space's live materials, the current
 * version of each (or exactly the pinned versions), with an active index in
 * the configured embedding space. Pinned versions outside the space, without
 * a usable index or of another owner are rejected.
 */
export async function resolveQuestionScope(
  tx: Queryable,
  ownerId: string,
  spaceId: string,
  signature: string,
  pinnedVersionIds: readonly string[],
): Promise<ScopedIndex[]> {
  const space = await tx.query('SELECT 1 FROM study_spaces WHERE owner_id=$1 AND id=$2', [
    ownerId,
    spaceId,
  ]);
  if (space.rows.length === 0) throw new StudyError('STUDY_SPACE_NOT_FOUND');
  const rows = await tx.query<{
    index_id: string;
    material_id: string;
    title: string;
    version_id: string;
    version_no: number;
    current_version_id: string | null;
    artifact_id: string;
  }>(
    `SELECT i.id AS index_id, m.id AS material_id, m.title, v.id AS version_id, v.version_no,
            m.current_version_id, i.artifact_id
       FROM study_space_materials sm
       JOIN study_materials m ON m.owner_id=sm.owner_id AND m.id=sm.material_id AND m.status='active'
       JOIN study_material_versions v ON v.owner_id=m.owner_id AND v.material_id=m.id
       JOIN study_knowledge_indexes i ON i.owner_id=v.owner_id AND i.version_id=v.id AND i.active
      WHERE sm.owner_id=$1 AND sm.space_id=$2 AND i.embedding_signature=$3
        AND ${pinnedVersionIds.length > 0 ? 'v.id = ANY($4::text[])' : 'v.id = m.current_version_id'}`,
    pinnedVersionIds.length > 0
      ? [ownerId, spaceId, signature, [...pinnedVersionIds]]
      : [ownerId, spaceId, signature],
  );
  if (pinnedVersionIds.length > 0 && rows.rows.length !== new Set(pinnedVersionIds).size) {
    throw new StudyError('STUDY_QA_INVALID_SCOPE');
  }
  return rows.rows.map((row) => ({
    indexId: row.index_id,
    materialId: row.material_id,
    title: row.title,
    versionId: row.version_id,
    versionNo: Number(row.version_no),
    isCurrent: row.version_id === row.current_version_id,
    artifactId: row.artifact_id,
  }));
}

export interface StudySearchHit {
  index: ScopedIndex;
  chunkId: string;
  blockId: string;
  pageNumber: number | null;
  heading: string | null;
  blockType: string;
  text: string;
  contentHash: string;
  method: 'hybrid' | 'lexical' | 'vector';
  vectorRank: number | null;
  lexicalRank: number | null;
  vectorDistance: number | null;
  lexicalScore: number | null;
  fusedScore: number;
}

export const halfvecLiteral = (vector: readonly number[]) =>
  `[${vector.map((x) => (Number.isFinite(x) ? Math.fround(x).toPrecision(6) : '0')).join(',')}]`;

/**
 * Hybrid (embedding given) or keyword-only search over the scoped indexes.
 * Owner and index restriction happen in the candidate SQL; FORCE RLS of the
 * calling role applies inside the function as well.
 */
export async function searchStudyKnowledge(
  tx: Queryable,
  ownerId: string,
  scope: readonly ScopedIndex[],
  terms: readonly string[],
  embedding: readonly number[] | null,
  k: number,
): Promise<StudySearchHit[]> {
  if (scope.length === 0 || (terms.length === 0 && !embedding)) return [];
  const ranked = await tx.query<{
    index_id: string;
    chunk_id: string;
    vector_rank: number | null;
    lexical_rank: number | null;
    vector_distance: number | null;
    lexical_score: number | null;
    fused_score: number;
  }>('SELECT * FROM study_knowledge_search($1, $2, $3, $4, $5, $6)', [
    ownerId,
    scope.map((index) => index.indexId),
    [...terms],
    embedding ? halfvecLiteral(embedding) : null,
    k,
    30,
  ]);
  if (ranked.rows.length === 0) return [];
  const details = await tx.query<{
    index_id: string;
    id: string;
    block_id: string;
    page_number: number | null;
    heading: string | null;
    block_type: string;
    text: string;
    content_hash: string;
  }>(
    `SELECT index_id, id, block_id, page_number, heading, block_type, text, content_hash
       FROM study_knowledge_chunks
      WHERE owner_id=$1 AND (index_id, id) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
    [ownerId, ranked.rows.map((row) => row.index_id), ranked.rows.map((row) => row.chunk_id)],
  );
  const byKey = new Map(details.rows.map((row) => [`${row.index_id}\n${row.id}`, row]));
  const byIndex = new Map(scope.map((index) => [index.indexId, index]));
  return ranked.rows.flatMap((row) => {
    const chunk = byKey.get(`${row.index_id}\n${row.chunk_id}`);
    const index = byIndex.get(row.index_id);
    if (!chunk || !index) return [];
    const vectorRank = row.vector_rank === null ? null : Number(row.vector_rank);
    const lexicalRank = row.lexical_rank === null ? null : Number(row.lexical_rank);
    return [
      {
        index,
        chunkId: chunk.id,
        blockId: chunk.block_id,
        pageNumber: chunk.page_number === null ? null : Number(chunk.page_number),
        heading: chunk.heading,
        blockType: chunk.block_type,
        text: chunk.text,
        contentHash: chunk.content_hash,
        method: !embedding ? 'lexical' : lexicalRank === null ? 'vector' : 'hybrid',
        vectorRank,
        lexicalRank,
        vectorDistance: row.vector_distance === null ? null : Number(row.vector_distance),
        lexicalScore: row.lexical_score === null ? null : Number(row.lexical_score),
        fusedScore: Number(row.fused_score),
      },
    ];
  });
}

// ── answers ───────────────────────────────────────────────────────────────

export interface StoredAnswerBody {
  segments: StudyAnswerSegment[];
  notFoundNote: string | null;
  retrieval: 'hybrid' | 'lexical';
}

export interface NewStudyAnswer {
  id: string;
  spaceId: string;
  question: string;
  status: 'answered' | 'not_found';
  body: StoredAnswerBody;
  pinnedVersionIds: string[];
  modelString: string | null;
  usage: StudyAnswerUsage;
  usageCompleteness: 'none' | 'complete' | 'partial' | 'unknown';
  citations: Array<{
    ref: string;
    hit: StudySearchHit;
    quote: string;
  }>;
}

/** Saved answers of the last hour: the per-account answer budget. */
export async function recentAnswerCount(tx: Queryable, ownerId: string): Promise<number> {
  const result = await tx.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM study_qa_answers
      WHERE owner_id=$1 AND created_at > clock_timestamp() - interval '1 hour'`,
    [ownerId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function saveStudyAnswer(
  tx: Queryable,
  ownerId: string,
  answer: NewStudyAnswer,
): Promise<void> {
  await tx.query(
    `INSERT INTO study_qa_answers (id, owner_id, space_id, question, status, body, scope,
       model_string, usage, usage_completeness)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10)`,
    [
      answer.id,
      ownerId,
      answer.spaceId,
      answer.question,
      answer.status,
      JSON.stringify(answer.body),
      JSON.stringify({
        pinnedVersionIds: answer.pinnedVersionIds,
        versionIds: [...new Set(answer.citations.map((c) => c.hit.index.versionId))],
      }),
      answer.modelString,
      JSON.stringify(answer.usage),
      answer.usageCompleteness,
    ],
  );
  for (const [ordinal, citation] of answer.citations.entries()) {
    await tx.query(
      `INSERT INTO study_qa_citations (owner_id, answer_id, ref, ordinal, material_id, version_id,
         artifact_id, chunk_id, block_id, page_number, quote, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        ownerId,
        answer.id,
        citation.ref,
        ordinal,
        citation.hit.index.materialId,
        citation.hit.index.versionId,
        citation.hit.index.artifactId,
        citation.hit.chunkId,
        citation.hit.blockId,
        citation.hit.pageNumber,
        citation.quote,
        citation.hit.contentHash,
      ],
    );
  }
}

interface AnswerRow extends Record<string, unknown> {
  id: string;
  question: string;
  status: 'answered' | 'not_found';
  body: StoredAnswerBody;
  scope: { pinnedVersionIds?: string[] };
  model_string: string | null;
  usage: StudyAnswerUsage | null;
  usage_completeness: StudyAnswerView['usageCompleteness'];
  created_at: string | Date;
}

/** Newest saved answers of a space with their citations (re-resolved each read). */
export async function listStudyAnswers(
  tx: Queryable,
  ownerId: string,
  spaceId: string,
  options: { answerId?: string; limit?: number } = {},
): Promise<StudyAnswerView[]> {
  const answers = await tx.query<AnswerRow>(
    `SELECT id, question, status, body, scope, model_string, usage, usage_completeness, created_at
       FROM study_qa_answers
      WHERE owner_id=$1 AND space_id=$2 ${options.answerId ? 'AND id=$4' : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    options.answerId
      ? [ownerId, spaceId, 1, options.answerId]
      : [ownerId, spaceId, options.limit ?? STUDY_QA_LIMITS.answersPerPage],
  );
  if (answers.rows.length === 0) return [];
  const citations = await tx.query<{
    answer_id: string;
    ref: string;
    material_id: string;
    version_id: string;
    artifact_id: string;
    block_id: string;
    page_number: number | null;
    quote: string;
    title: string | null;
    version_no: number | null;
    is_current: boolean | null;
  }>(
    `SELECT c.answer_id, c.ref, c.material_id, c.version_id, c.artifact_id, c.block_id,
            c.page_number, c.quote,
            CASE WHEN m.status='active' THEN m.title END AS title, v.version_no,
            (m.current_version_id = c.version_id) AS is_current
       FROM study_qa_citations c
       LEFT JOIN study_material_versions v ON v.owner_id=c.owner_id AND v.id=c.version_id
       LEFT JOIN study_materials m ON m.owner_id=v.owner_id AND m.id=v.material_id
      WHERE c.owner_id=$1 AND c.answer_id = ANY($2::text[])
      ORDER BY c.answer_id, c.ordinal`,
    [ownerId, answers.rows.map((row) => row.id)],
  );
  const byAnswer = new Map<string, StudyAnswerCitation[]>();
  for (const row of citations.rows) {
    const list = byAnswer.get(row.answer_id) ?? [];
    list.push({
      ref: row.ref,
      materialId: row.material_id,
      materialTitle: row.title,
      versionId: row.version_id,
      versionNo: row.version_no === null ? null : Number(row.version_no),
      isCurrentVersion: row.is_current === true,
      artifactId: row.artifact_id,
      pageNumber: row.page_number === null ? null : Number(row.page_number),
      blockId: row.block_id,
      quote: row.quote,
      sourceDeleted: row.title === null,
    });
    byAnswer.set(row.answer_id, list);
  }
  return answers.rows.map((row) => {
    const body = row.body ?? { segments: [], notFoundNote: null, retrieval: 'hybrid' };
    const present = byAnswer.get(row.id) ?? [];
    const known = new Set(present.map((citation) => citation.ref));
    // A citation row goes with its permanently deleted material version.
    const deleted: StudyAnswerCitation[] = [
      ...new Set(
        body.segments.flatMap((segment) => (segment.kind === 'grounded' ? segment.citations : [])),
      ),
    ]
      .filter((ref) => !known.has(ref))
      .map((ref) => ({
        ref,
        materialId: '',
        materialTitle: null,
        versionId: '',
        versionNo: null,
        isCurrentVersion: false,
        artifactId: '',
        pageNumber: null,
        blockId: '',
        quote: '',
        sourceDeleted: true,
      }));
    return {
      answerId: row.id,
      question: row.question,
      status: row.status,
      segments: body.segments,
      notFoundNote: body.notFoundNote,
      citations: [...present, ...deleted],
      retrieval: body.retrieval,
      pinnedVersionIds: row.scope?.pinnedVersionIds ?? [],
      modelString: row.model_string,
      usage: row.usage,
      usageCompleteness: row.usage_completeness,
      createdAt: iso(row.created_at),
    };
  });
}

/** Remove one saved answer (and its citations). */
export async function deleteStudyAnswer(
  tx: Queryable,
  ownerId: string,
  spaceId: string,
  answerId: string,
): Promise<boolean> {
  const result = await tx.query(
    'DELETE FROM study_qa_answers WHERE owner_id=$1 AND space_id=$2 AND id=$3 RETURNING id',
    [ownerId, spaceId, answerId],
  );
  return result.rows.length > 0;
}
