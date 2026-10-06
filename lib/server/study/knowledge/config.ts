/**
 * Retrieval configuration (learning plan B03), free of request-handling
 * imports so the worker can read it.
 *
 * - The chunk policy is part of an index's identity: changing it makes every
 *   index stale (a rebuild is offered, the old index keeps serving meanwhile).
 * - The embedding model is operator-configured: STUDY_EMBEDDING_MODEL names
 *   `provider:model` of a provider in the server provider configuration (its
 *   key, base URL and proxy are used). The vector column is 1024 wide, so the
 *   model must return 1024 dimensions (STUDY_EMBEDDING_SEND_DIMENSIONS=1 asks
 *   models with adjustable width for exactly that).
 */
import {
  resolveOperatorEmbeddingBinding,
  type EmbeddingBinding,
  type EmbeddingSpec,
} from '@/lib/model-gateway';
import { STUDY_KNOWLEDGE_EMBEDDING_DIMENSIONS } from '@/lib/server/accounts/sql-study-knowledge';

export const STUDY_CHUNK_POLICY = {
  id: 'study-knowledge',
  version: '1',
  /** Graphemes per chunk (CJK text: roughly 500–800 tokens). */
  maxChars: 800,
} as const;

export const STUDY_CHUNK_POLICY_KEY = `${STUDY_CHUNK_POLICY.id}@${STUDY_CHUNK_POLICY.version}:maxChars=${STUDY_CHUNK_POLICY.maxChars}`;

/** Inputs per embedding request while indexing. */
export const STUDY_EMBEDDING_BATCH = 32;

export function studyEmbeddingSpec(env: NodeJS.ProcessEnv = process.env): EmbeddingSpec | null {
  const raw = env.STUDY_EMBEDDING_MODEL?.trim();
  if (!raw) return null;
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;
  const dimensions = Number(
    env.STUDY_EMBEDDING_DIMENSIONS?.trim() || STUDY_KNOWLEDGE_EMBEDDING_DIMENSIONS,
  );
  if (dimensions !== STUDY_KNOWLEDGE_EMBEDDING_DIMENSIONS) return null;
  return {
    providerId: raw.slice(0, separator),
    modelId: raw.slice(separator + 1),
    dimensions,
    requestDimensions: env.STUDY_EMBEDDING_SEND_DIMENSIONS === '1',
  };
}

/** The configured embedding binding, or null when retrieval cannot embed. */
export function resolveStudyEmbeddingBinding(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingBinding | null {
  const spec = studyEmbeddingSpec(env);
  return spec ? resolveOperatorEmbeddingBinding(spec) : null;
}
