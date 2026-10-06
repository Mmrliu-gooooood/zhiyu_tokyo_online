/**
 * Worker handler for `material_index` learning tasks (learning plan B03).
 *
 * Reads the parse artifact the task names, chunks it with the current policy,
 * embeds the chunks through the gateway (operator-funded embedding model) and
 * writes the index with all chunks in the lease-fenced commit of the task.
 * The new index becomes active in that same commit and the version's older
 * indexes are removed, so a build that fails or loses its lease never touches
 * the index that is serving. Nothing is written to object storage.
 *
 * Embedding concurrency is bounded by the learning-task runner (one task per
 * worker by default) under the heavy-task admission the task already holds,
 * so the per-call deployment quota slot is not taken again here.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { GatewayError, createEmbeddingGateway, type EmbeddingBinding } from '@/lib/model-gateway';
import type { LearningTaskLease } from '@/lib/server/learning-tasks/contracts';
import type { LearningTaskHandlerContext } from '@/lib/server/learning-tasks/runner';
import { getMaterialByteStore, type MaterialByteStore } from '@/lib/server/materials/bytes';
import type { StoredArtifactDocument } from '@/lib/server/study/materials/artifact';
import { STUDY_QA_LIMITS } from '@/lib/study/knowledge/contracts';

import { planStudyChunks } from './chunks';
import {
  STUDY_CHUNK_POLICY_KEY,
  STUDY_EMBEDDING_BATCH,
  resolveStudyEmbeddingBinding,
} from './config';
import { createStudyIndexId, halfvecLiteral, knowledgeStorageReady } from './repository';

class IndexFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = code,
  ) {
    super(message);
    this.name = 'IndexFailure';
  }
}

class MaterialGone extends Error {}

const RETRYABLE_EMBEDDING = new Set([
  'MODEL_RATE_LIMITED',
  'MODEL_UPSTREAM_UNAVAILABLE',
  'MODEL_NETWORK',
  'MODEL_TIMEOUT',
]);

export interface MaterialIndexDependencies {
  byteStore?: () => MaterialByteStore;
  embeddingBinding?: () => EmbeddingBinding | null;
  embed?: ReturnType<typeof createEmbeddingGateway>['embed'];
}

interface Facts extends Record<string, unknown> {
  material_status: string;
  title: string;
  sha256: string;
  artifact_key: string | null;
}

const workerEmbeddings = createEmbeddingGateway({ quota: async () => undefined });

async function lockLiveVersion(q: Queryable, lease: LearningTaskLease, versionId: string) {
  const version = await q.query<{ material_id: string }>(
    'SELECT material_id FROM study_material_versions WHERE owner_id=$1 AND id=$2 FOR UPDATE',
    [lease.ownerId, versionId],
  );
  if (!version.rows[0]) throw new MaterialGone();
  const material = await q.query<{ status: string }>(
    'SELECT status FROM study_materials WHERE owner_id=$1 AND id=$2',
    [lease.ownerId, version.rows[0].material_id],
  );
  if (material.rows[0]?.status !== 'active') throw new MaterialGone();
}

export async function runMaterialIndexTask(
  lease: LearningTaskLease,
  { queue, signal }: LearningTaskHandlerContext,
  deps: MaterialIndexDependencies = {},
): Promise<void> {
  const input = lease.input as {
    materialId?: string;
    versionId?: string;
    artifactId?: string;
    chunkPolicy?: string;
    embeddingSignature?: string;
  };
  const versionId = String(input.versionId ?? '');
  const artifactId = String(input.artifactId ?? '');
  const materialId = String(input.materialId ?? '');
  const fail = (code: string, extra: Record<string, unknown> = {}) =>
    queue.fail(lease, { code, retryable: false, ...extra });

  if (!(await queue.transaction((q) => knowledgeStorageReady(q)))) {
    await fail('INDEX_STORAGE_UNAVAILABLE');
    return;
  }
  if (input.chunkPolicy !== STUDY_CHUNK_POLICY_KEY) {
    await fail('INDEX_POLICY_CHANGED');
    return;
  }
  const binding = (deps.embeddingBinding ?? resolveStudyEmbeddingBinding)();
  if (!binding) {
    await fail('EMBEDDING_NOT_CONFIGURED');
    return;
  }
  if (binding.signature !== input.embeddingSignature) {
    await fail('EMBEDDING_MODEL_CHANGED');
    return;
  }

  const facts = await queue.transaction(async (q) => {
    const result = await q.query<Facts>(
      `SELECT m.status AS material_status, m.title, v.sha256, a.artifact_key
         FROM study_material_versions v
         JOIN study_materials m ON m.owner_id=v.owner_id AND m.id=v.material_id
         LEFT JOIN study_material_artifacts a
           ON a.owner_id=v.owner_id AND a.version_id=v.id AND a.id=$3
        WHERE v.owner_id=$1 AND v.id=$2`,
      [lease.ownerId, versionId, artifactId],
    );
    return result.rows[0] ?? null;
  });
  if (!facts || facts.material_status !== 'active') {
    await fail('MATERIAL_DELETED');
    return;
  }
  if (!facts.artifact_key) {
    await fail('ARTIFACT_GONE');
    return;
  }

  let document: StoredArtifactDocument;
  try {
    const bytes = await (deps.byteStore ?? getMaterialByteStore)().get(facts.artifact_key);
    document = JSON.parse(bytes.toString('utf8')) as StoredArtifactDocument;
  } catch (error) {
    throw new IndexFailure('ARTIFACT_UNAVAILABLE', true, String(error));
  }
  signal.throwIfAborted();

  const plan = planStudyChunks(document, {
    ownerId: lease.ownerId,
    materialId,
    versionId,
    artifactId,
    title: facts.title,
    sha256: facts.sha256,
  });
  if (plan.chunks.length === 0) {
    await fail('MATERIAL_NO_TEXT', { usageCompleteness: 'none' });
    return;
  }
  if (plan.chunks.length > STUDY_QA_LIMITS.maxChunksPerVersion) {
    await fail('INDEX_TOO_LARGE', {
      summary: `${plan.chunks.length} chunks exceed the ${STUDY_QA_LIMITS.maxChunksPerVersion} limit.`,
    });
    return;
  }

  // Embed: one call per batch, all through the gateway under this task's root.
  const embed = deps.embed ?? workerEmbeddings.embed;
  const startedAt = Date.now();
  const vectors: number[][] = [];
  let calls = 0;
  let tokens = 0;
  let tokensKnown = true;
  const usage = () => ({
    chunks: plan.chunks.length,
    embeddingCalls: calls,
    embeddingInputs: vectors.length,
    embeddingInputTokens: tokensKnown ? tokens : null,
    embeddingModel: binding.modelString,
    durationMs: Date.now() - startedAt,
  });
  const completeness = () => (calls === 0 ? 'none' : tokensKnown ? 'complete' : 'partial');
  try {
    for (let i = 0; i < plan.chunks.length; i += STUDY_EMBEDDING_BATCH) {
      signal.throwIfAborted();
      const batch = plan.chunks.slice(i, i + STUDY_EMBEDDING_BATCH);
      calls += 1;
      const result = await embed(
        binding,
        batch.map((chunk) => chunk.text),
        {
          source: 'study-index',
          signal,
          retry: 'default',
          ownerId: lease.ownerId,
          usage: { eventKey: `${lease.taskId}:${lease.attemptNo}:${i}` },
        },
      );
      vectors.push(...result.vectors);
      if (result.inputTokens === null) tokensKnown = false;
      else tokens += result.inputTokens;
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const code = error instanceof GatewayError ? error.code : 'MODEL_NETWORK';
    await queue.fail(lease, {
      code: `EMBEDDING_${code.replace(/^MODEL_/, '')}`,
      retryable: RETRYABLE_EMBEDDING.has(code),
      providerId: binding.providerId,
      usage: usage(),
      usageCompleteness: calls > 0 ? 'unknown' : 'none',
    });
    return;
  }
  signal.throwIfAborted();

  const indexId = createStudyIndexId();
  let activeId = indexId;
  try {
    await queue.complete(
      lease,
      {
        result: {
          indexId,
          chunkCount: plan.chunks.length,
          unparsedPages: plan.unparsedPages,
          embeddingCalls: calls,
        },
        providerId: binding.providerId,
        usage: usage(),
        usageCompleteness: completeness(),
      },
      async (q) => {
        await lockLiveVersion(q, lease, versionId);
        const inserted = await q.query<{ id: string }>(
          `INSERT INTO study_knowledge_indexes (id, owner_id, material_id, version_id, artifact_id,
             chunk_policy, embedding_signature, active, chunk_count, text_chars, unparsed_pages, task_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10::jsonb,$11)
           ON CONFLICT (owner_id, artifact_id, chunk_policy, embedding_signature) DO NOTHING
           RETURNING id`,
          [
            indexId,
            lease.ownerId,
            materialId,
            versionId,
            artifactId,
            STUDY_CHUNK_POLICY_KEY,
            binding.signature,
            plan.chunks.length,
            plan.textChars,
            JSON.stringify(plan.unparsedPages),
            lease.taskId,
          ],
        );
        if (inserted.rows[0]) {
          for (let i = 0; i < plan.chunks.length; i += 100) {
            const values: string[] = [];
            const params: unknown[] = [];
            plan.chunks.slice(i, i + 100).forEach((chunk, j) => {
              const base = params.length;
              values.push(
                `(${Array.from({ length: 13 }, (_, k) => `$${base + k + 1}`).join(',')}::extensions.halfvec)`,
              );
              params.push(
                lease.ownerId,
                indexId,
                chunk.id,
                materialId,
                versionId,
                chunk.ordinal,
                chunk.locator.blockId,
                chunk.locator.pageNumber ?? null,
                chunk.locator.heading?.slice(0, 300) ?? null,
                String(chunk.metadata.blockType ?? 'text').slice(0, 40),
                chunk.text,
                chunk.contentHash,
                halfvecLiteral(vectors[i + j]!),
              );
            });
            await q.query(
              `INSERT INTO study_knowledge_chunks (owner_id, index_id, id, material_id, version_id,
                 ordinal, block_id, page_number, heading, block_type, text, content_hash, embedding)
               VALUES ${values.join(',')}`,
              params,
            );
          }
        } else {
          // The same build already exists (a concurrent or earlier identical task): reuse it.
          const existing = await q.query<{ id: string }>(
            `SELECT id FROM study_knowledge_indexes WHERE owner_id=$1 AND artifact_id=$2
               AND chunk_policy=$3 AND embedding_signature=$4`,
            [lease.ownerId, artifactId, STUDY_CHUNK_POLICY_KEY, binding.signature],
          );
          activeId = existing.rows[0]!.id;
        }
        // Swap: retire every other index of the version, then activate this one.
        await q.query(
          'DELETE FROM study_knowledge_indexes WHERE owner_id=$1 AND version_id=$2 AND id<>$3',
          [lease.ownerId, versionId, activeId],
        );
        await q.query(
          'UPDATE study_knowledge_indexes SET active=true WHERE owner_id=$1 AND id=$2',
          [lease.ownerId, activeId],
        );
      },
    );
  } catch (error) {
    if (error instanceof MaterialGone) {
      await queue.fail(lease, {
        code: 'MATERIAL_DELETED',
        retryable: false,
        providerId: binding.providerId,
        usage: usage(),
        usageCompleteness: completeness(),
      });
      return;
    }
    throw error;
  }
}

export { IndexFailure as MaterialIndexFailure };
