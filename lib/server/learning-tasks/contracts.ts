/**
 * Learning-task contract (learning plan B02+). One durable row per user
 * operation that needs background work (B02: parsing a material version).
 * Separate from the course-generation job contract; the lease mechanics are
 * shared through lib/server/task-queue.
 */
import { LEARNING_TASK_KINDS, type LearningTaskKind } from '@/lib/study/tasks/contracts';

export {
  LEARNING_TASK_KINDS,
  LEARNING_TASK_STATUSES,
  type LearningTaskKind,
  type LearningTaskStatus,
  type LearningTaskUsageCompleteness,
  type LearningTaskView,
} from '@/lib/study/tasks/contracts';

/** Worker capability published in generation_worker_heartbeats.pipeline_versions. */
export const LEARNING_TASK_WORKER_CAPABILITY = 'learning-tasks-v1';
/** Per-kind capability (`learning-kind:material_index`) next to the generic one (B03). */
export const LEARNING_TASK_KIND_CAPABILITY_PREFIX = 'learning-kind:';

export function isLearningTaskKind(value: unknown): value is LearningTaskKind {
  return typeof value === 'string' && (LEARNING_TASK_KINDS as readonly string[]).includes(value);
}

export function learningTaskRootId(taskId: string): string {
  return `learning:${taskId}`;
}

export interface LearningTaskLease {
  taskId: string;
  ownerId: string;
  rootTaskId: string;
  kind: LearningTaskKind;
  subjectId: string;
  input: Record<string, unknown>;
  workerId: string;
  leaseEpoch: number;
  attemptId: string;
  attemptNo: number;
  /** Absolute deadline for this attempt (ms since epoch). */
  deadlineAt: number;
}

export type LearningTaskErrorCode =
  | 'LEARNING_TASK_NOT_FOUND'
  | 'LEARNING_TASK_INVALID_IDEMPOTENCY_KEY'
  | 'LEARNING_TASK_IDEMPOTENCY_CONFLICT'
  | 'LEARNING_TASK_OWNER_QUEUE_LIMIT'
  | 'LEARNING_TASK_QUEUE_FULL'
  | 'LEARNING_TASK_NOT_RETRYABLE'
  | 'LEARNING_TASK_UNAVAILABLE'
  | 'STALE_LEARNING_TASK_LEASE';

const HTTP_STATUS: Record<LearningTaskErrorCode, number> = {
  LEARNING_TASK_NOT_FOUND: 404,
  LEARNING_TASK_INVALID_IDEMPOTENCY_KEY: 400,
  LEARNING_TASK_IDEMPOTENCY_CONFLICT: 409,
  LEARNING_TASK_OWNER_QUEUE_LIMIT: 429,
  LEARNING_TASK_QUEUE_FULL: 503,
  LEARNING_TASK_NOT_RETRYABLE: 409,
  LEARNING_TASK_UNAVAILABLE: 503,
  STALE_LEARNING_TASK_LEASE: 409,
};

export class LearningTaskError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: LearningTaskErrorCode) {
    super(code);
    this.name = 'LearningTaskError';
    this.httpStatus = HTTP_STATUS[code];
  }
}

/**
 * Codes a plain retry of the same request cannot fix (the subject is gone, the
 * request is invalid, or the same parser would give the same answer). A new
 * parse with another parser is still possible.
 */
export const NON_RETRYABLE_TASK_CODES = new Set([
  'MATERIAL_DELETED',
  'MATERIAL_TYPE_UNSUPPORTED',
  'PARSER_UNAVAILABLE',
  'MATERIAL_NO_TEXT',
  'MATERIAL_DIGEST_MISMATCH',
  // material_index (B03): the request no longer matches this server or material.
  'ARTIFACT_GONE',
  'INDEX_STORAGE_UNAVAILABLE',
  'INDEX_POLICY_CHANGED',
  'INDEX_TOO_LARGE',
  'EMBEDDING_NOT_CONFIGURED',
  'EMBEDDING_MODEL_CHANGED',
]);
