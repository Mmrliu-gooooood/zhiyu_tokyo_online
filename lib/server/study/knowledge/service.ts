/**
 * Retrieval services behind the study QA routes (learning plan B03): the
 * readiness check, per-space index status, index build requests, and the
 * ask/search flows wrapped in the synchronous heavy-task lease so a question
 * counts toward the personal/site heavy-task limits like other model work.
 */
import { randomUUID } from 'node:crypto';

import {
  GatewayError,
  ModelSelectionError,
  resolveRequestBinding,
  type ModelBinding,
} from '@/lib/model-gateway';
import { runIndependentHeavyTaskRequest } from '@/lib/server/heavy-task-admission/independent-request';
import { isLearningTaskWorkerLive } from '@/lib/server/learning-tasks/repository';
import { isStudyTaskIntakeOpen } from '@/lib/server/study/flags';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import type {
  StudyKnowledgeStatus,
  StudyKnowledgeUnavailableReason,
} from '@/lib/study/knowledge/contracts';

import { askSpace, searchSpace, type AskDependencies } from './ask';
import { resolveStudyEmbeddingBinding } from './config';
import {
  knowledgeStorageReady,
  listSpaceKnowledge,
  requestStudyIndexBuild,
  type IndexBuildOutcome,
} from './repository';

export interface KnowledgeReadiness {
  storage: boolean;
  embeddingModel: string | null;
  signature: string | null;
  worker: boolean;
  reason: StudyKnowledgeUnavailableReason | null;
}

export async function knowledgeReadiness(db: StudyDb): Promise<KnowledgeReadiness> {
  const storage = await knowledgeStorageReady(db);
  const binding = resolveStudyEmbeddingBinding();
  const embedding = binding && binding.credentialReady ? binding : null;
  const worker =
    storage && isStudyTaskIntakeOpen() && (await isLearningTaskWorkerLive(db, 'material_index'));
  return {
    storage,
    embeddingModel: embedding?.modelString ?? null,
    signature: embedding?.signature ?? null,
    worker,
    reason: !storage
      ? 'STORAGE_UNAVAILABLE'
      : !embedding
        ? 'EMBEDDING_NOT_CONFIGURED'
        : !worker
          ? 'WORKER_UNAVAILABLE'
          : null,
  };
}

export async function spaceKnowledgeStatus(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
): Promise<StudyKnowledgeStatus> {
  const readiness = await knowledgeReadiness(db);
  const materials = await db.withTransaction((tx) =>
    listSpaceKnowledge(tx, ownerId, spaceId, readiness.signature, readiness.storage),
  );
  return {
    // Asking needs storage and embeddings; a stopped worker only blocks new builds.
    available: readiness.storage && readiness.signature !== null,
    reason: readiness.reason,
    embeddingModel: readiness.embeddingModel,
    materials,
  };
}

export async function buildSpaceIndexes(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  targets: Array<{ materialId: string; versionId: string }>,
): Promise<
  Array<{ materialId: string; versionId: string; outcome?: IndexBuildOutcome; error?: string }>
> {
  // Another owner's (or a missing) space answers 404 like every other study API.
  const space = await db.query('SELECT 1 FROM study_spaces WHERE owner_id=$1 AND id=$2', [
    ownerId,
    spaceId,
  ]);
  if (space.rows.length === 0) throw new StudyError('STUDY_SPACE_NOT_FOUND');
  const readiness = await knowledgeReadiness(db);
  if (!readiness.storage || !readiness.signature) throw new StudyError('STUDY_QA_UNAVAILABLE');
  const results = [];
  for (const target of targets) {
    try {
      const outcome = await requestStudyIndexBuild(db, ownerId, {
        ...target,
        spaceId,
        signature: readiness.signature,
      });
      results.push({ ...target, outcome });
    } catch (error) {
      if (!(error instanceof StudyError)) throw error;
      results.push({ ...target, error: error.code });
    }
  }
  return results;
}

async function bindingFor(req: Request, body: unknown): Promise<ModelBinding> {
  try {
    const binding = await resolveRequestBinding(req, body, 'study-qa');
    if (!binding.credentialReady) throw new StudyError('STUDY_QA_MODEL_UNAVAILABLE');
    return binding;
  } catch (error) {
    if (error instanceof ModelSelectionError || error instanceof GatewayError) {
      throw new StudyError('STUDY_QA_MODEL_UNAVAILABLE', {
        reason: error instanceof ModelSelectionError ? error.code : error.code,
      });
    }
    throw error;
  }
}

export interface QuestionRequest {
  spaceId: string;
  question: string;
  pinnedVersionIds: string[];
  body: unknown;
}

function failureResponse(error: unknown, headers: Headers): Response {
  if (error instanceof StudyError) {
    return Response.json(
      { error: error.code, ...error.details },
      { status: error.status, headers },
    );
  }
  if (error instanceof GatewayError && error.code === 'MODEL_ABORTED') {
    return Response.json({ error: 'STUDY_QA_CANCELLED' }, { status: 499, headers });
  }
  throw error;
}

/**
 * Answer one question under the heavy-task lease. The model binding is
 * resolved from the request (the user's selected model and its funding).
 */
export async function answerQuestion(
  req: Request,
  db: StudyDb,
  ownerId: string,
  request: QuestionRequest,
  headers: Headers,
  deps: AskDependencies = {},
): Promise<Response> {
  const readiness = await knowledgeReadiness(db);
  if (!readiness.storage || !readiness.signature) {
    throw new StudyError('STUDY_QA_UNAVAILABLE', { reason: readiness.reason });
  }
  const model = await bindingFor(req, request.body);
  const embedding = resolveStudyEmbeddingBinding();
  return runIndependentHeavyTaskRequest(req, 'study-qa', async (leaseSignal) => {
    try {
      const answer = await askSpace(
        (body) => db.withTransaction(body),
        {
          ownerId,
          spaceId: request.spaceId,
          question: request.question,
          pinnedVersionIds: request.pinnedVersionIds,
          model,
          embedding,
          signature: readiness.signature!,
          signal: AbortSignal.any([req.signal, leaseSignal]),
          requestId: randomUUID(),
        },
        deps,
      );
      return Response.json({ answer }, { status: 201, headers });
    } catch (error) {
      return failureResponse(error, headers);
    }
  });
}

/** Retrieval only: no model call beyond the query embedding. */
export async function searchQuestion(
  req: Request,
  db: StudyDb,
  ownerId: string,
  request: Omit<QuestionRequest, 'body'>,
  headers: Headers,
  deps: AskDependencies = {},
): Promise<Response> {
  const readiness = await knowledgeReadiness(db);
  if (!readiness.storage || !readiness.signature) {
    throw new StudyError('STUDY_QA_UNAVAILABLE', { reason: readiness.reason });
  }
  const embedding = resolveStudyEmbeddingBinding();
  return runIndependentHeavyTaskRequest(req, 'study-qa', async (leaseSignal) => {
    try {
      const result = await searchSpace(
        (body) => db.withTransaction(body),
        {
          ownerId,
          spaceId: request.spaceId,
          question: request.question,
          pinnedVersionIds: request.pinnedVersionIds,
          embedding,
          signature: readiness.signature!,
          signal: AbortSignal.any([req.signal, leaseSignal]),
          requestId: randomUUID(),
        },
        deps,
      );
      return Response.json(result, { status: 200, headers });
    } catch (error) {
      return failureResponse(error, headers);
    }
  });
}
