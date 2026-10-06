/**
 * Client-safe contracts for persistent retrieval and cited answers (learning
 * plan B03). Server persistence lives in lib/server/study/knowledge.
 */
import type { LearningTaskView } from '@/lib/study/tasks/contracts';

export const STUDY_QA_LIMITS = {
  maxQuestionChars: 500,
  /** Material versions a question may be pinned to. */
  maxPinnedVersions: 20,
  /** Evidence passages handed to the model. */
  evidenceChunks: 8,
  maxEvidenceChars: 8000,
  maxAnswerOutputTokens: 1500,
  answersPerPage: 20,
  /** Saved answers per account per rolling hour (server-enforced budget). */
  answersPerHour: 60,
  maxChunksPerVersion: 3000,
  maxIndexedChunksPerOwner: 20000,
} as const;

/** Why retrieval cannot be used right now (null when it can). */
export type StudyKnowledgeUnavailableReason =
  | 'STORAGE_UNAVAILABLE'
  | 'EMBEDDING_NOT_CONFIGURED'
  | 'WORKER_UNAVAILABLE';

/** Search index of one material version, as the owner sees it. */
export type StudyIndexState =
  | 'not_parsed'
  | 'not_indexed'
  | 'indexing'
  | 'ready'
  /** Ready, but built from an older parse or embedding model; a rebuild is offered. */
  | 'stale'
  | 'failed';

export interface StudyVersionIndexView {
  indexId: string;
  chunkCount: number;
  /** Pages the parser found no text on (scans): not searchable. */
  unparsedPages: number[];
  createdAt: string;
}

export interface StudyKnowledgeVersionView {
  versionId: string;
  versionNo: number;
  isCurrent: boolean;
  originalName: string;
  parsed: boolean;
  state: StudyIndexState;
  index: StudyVersionIndexView | null;
  /** Latest index task of this version. */
  task: LearningTaskView | null;
}

export interface StudyKnowledgeMaterialView {
  materialId: string;
  title: string;
  versions: StudyKnowledgeVersionView[];
}

export interface StudyKnowledgeStatus {
  /** Retrieval can index and answer on this server. */
  available: boolean;
  reason: StudyKnowledgeUnavailableReason | null;
  /** Embedding model identity shown to the owner ("provider:model"), when configured. */
  embeddingModel: string | null;
  materials: StudyKnowledgeMaterialView[];
}

export type StudyAnswerSegment =
  | { kind: 'grounded'; text: string; citations: string[] }
  | { kind: 'supplement'; text: string };

export interface StudyAnswerCitation {
  /** E1…E8, as used in the segments. */
  ref: string;
  materialId: string;
  materialTitle: string | null;
  versionId: string;
  versionNo: number | null;
  isCurrentVersion: boolean;
  artifactId: string;
  pageNumber: number | null;
  blockId: string;
  quote: string;
  /** The material (or this version) was permanently deleted after the answer. */
  sourceDeleted: boolean;
}

export interface StudyAnswerUsage {
  embeddingCalls: number;
  embeddingInputTokens: number | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  fundingKind: string | null;
}

export interface StudyAnswerView {
  answerId: string;
  question: string;
  /** not_found: the materials hold no evidence for the question. */
  status: 'answered' | 'not_found';
  segments: StudyAnswerSegment[];
  /** Model's short note on what is missing (not_found) — never shown as evidence. */
  notFoundNote: string | null;
  citations: StudyAnswerCitation[];
  /** Semantic+keyword, or keyword only when embeddings were unavailable. */
  retrieval: 'hybrid' | 'lexical';
  pinnedVersionIds: string[];
  modelString: string | null;
  usage: StudyAnswerUsage | null;
  usageCompleteness: 'none' | 'complete' | 'partial' | 'unknown';
  createdAt: string;
}

export interface StudySearchHitView {
  chunkId: string;
  materialId: string;
  materialTitle: string;
  versionId: string;
  versionNo: number;
  isCurrentVersion: boolean;
  artifactId: string;
  pageNumber: number | null;
  blockId: string;
  excerpt: string;
  method: 'hybrid' | 'lexical' | 'vector';
  vectorRank: number | null;
  lexicalRank: number | null;
}

export interface StudySearchResult {
  retrieval: 'hybrid' | 'lexical';
  hits: StudySearchHitView[];
}

/** Reader deep link for one citation: exact version, parse, page and block. */
export function citationReaderHref(citation: {
  materialId: string;
  versionId: string;
  artifactId: string;
  pageNumber: number | null;
  blockId: string;
}): string {
  const params = new URLSearchParams({ version: citation.versionId });
  if (citation.pageNumber) params.set('page', String(citation.pageNumber));
  params.set('artifact', citation.artifactId);
  params.set('block', citation.blockId);
  return `/study/materials/${encodeURIComponent(citation.materialId)}/read?${params.toString()}`;
}
