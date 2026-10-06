/**
 * Retrieval configuration (learning plan B03), free of request-handling
 * imports so the worker can read it.
 *
 * - The chunk policy is part of an index's identity: changing it makes every
 *   index stale (a rebuild is offered, the old index keeps serving meanwhile).
 * - Retrieval is keyword-only by default: no embedding model, no external
 *   cost for indexing or search. An operator turns on hybrid (semantic +
 *   keyword) retrieval with STUDY_EMBEDDING_MODEL = `provider:model` of a
 *   provider in the server provider configuration (its key, base URL and
 *   proxy are used). The vector column is 1024 wide, so the model must return
 *   1024 dimensions (STUDY_EMBEDDING_SEND_DIMENSIONS=1 asks models with
 *   adjustable width for exactly that). Switching modes changes the index
 *   signature, so existing indexes show "needs update" and keep serving until
 *   rebuilt.
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

/** Index signature of keyword-only indexes (chunks stored without vectors). */
export const STUDY_KEYWORD_SIGNATURE = 'keyword@1';

export type StudyRetrievalConfig =
  | { mode: 'keyword'; signature: string; embedding: null }
  | { mode: 'hybrid'; signature: string; embedding: EmbeddingBinding }
  /** STUDY_EMBEDDING_MODEL is set but unusable (bad value or missing key). */
  | { mode: 'misconfigured'; signature: null; embedding: null };

/** Keyword-only unless an embedding model is configured. */
export function resolveStudyRetrieval(env: NodeJS.ProcessEnv = process.env): StudyRetrievalConfig {
  if (!env.STUDY_EMBEDDING_MODEL?.trim()) {
    return { mode: 'keyword', signature: STUDY_KEYWORD_SIGNATURE, embedding: null };
  }
  const binding = resolveStudyEmbeddingBinding(env);
  return binding && binding.credentialReady
    ? { mode: 'hybrid', signature: binding.signature, embedding: binding }
    : { mode: 'misconfigured', signature: null, embedding: null };
}
