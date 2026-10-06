/**
 * Client-safe learning-task contract (learning plan B02+): kinds, statuses and
 * the owner-facing task view. Server persistence lives in
 * lib/server/learning-tasks.
 */
export const LEARNING_TASK_KINDS = ['material_parse', 'material_index'] as const;
export type LearningTaskKind = (typeof LEARNING_TASK_KINDS)[number];

export const LEARNING_TASK_STATUSES = [
  'queued',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type LearningTaskStatus = (typeof LEARNING_TASK_STATUSES)[number];

export type LearningTaskUsageCompleteness = 'none' | 'complete' | 'partial' | 'unknown';

/** Owner-facing projection. Inputs, worker ids and lease data stay server-side. */
export interface LearningTaskView {
  taskId: string;
  kind: LearningTaskKind;
  subjectId: string;
  status: LearningTaskStatus;
  /** Why a queued task has not started: still waiting, or a personal/site concurrency limit. */
  queueReason: 'queued' | 'owner_limit' | 'site_limit' | null;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  retryAt: string | null;
  usageCompleteness: LearningTaskUsageCompleteness;
  /** Kind-specific, allow-listed result summary (never provider payloads). */
  result: Record<string, unknown> | null;
  /** The parser the task was asked to use (material_parse). */
  providerId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelable: boolean;
  retryable: boolean;
}

export function isActiveTaskStatus(status: LearningTaskStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'retry_wait';
}
