export interface GenerationConfig {
  enabled: boolean;
  workerConcurrency: number;
  maxQueuedPerOwner: number;
  maxQueued: number;
  maxReviewAttentionPerOwner: number;
  maxReviewAttention: number;
  queueWaitMs: number;
  manualReviewWaitMs: number;
  contentConcurrency: number;
  llmConcurrency: number;
  ttsConcurrency: number;
  mediaConcurrency: number;
  leaseMs: number;
  heartbeatMs: number;
}
export function generationConfig(env: NodeJS.ProcessEnv = process.env): GenerationConfig {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    if (!env[key]?.trim()) return fallback;
    const n = Number(env[key]);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw new Error(`Invalid generation configuration: ${key}`);
    return n;
  };
  return {
    enabled: env.GENERATION_BACKGROUND_ENABLED === '1',
    workerConcurrency: integer('GENERATION_WORKER_CONCURRENCY', 1, 1, 8),
    maxQueuedPerOwner: integer('GENERATION_MAX_QUEUED_JOBS_PER_OWNER', 5, 1, 5),
    maxQueued: integer('GENERATION_MAX_QUEUED_JOBS', 20, 1, 20),
    maxReviewAttentionPerOwner: integer('GENERATION_MAX_REVIEW_ATTENTION_JOBS_PER_OWNER', 5, 1, 5),
    maxReviewAttention: integer('GENERATION_MAX_REVIEW_ATTENTION_JOBS', 20, 1, 20),
    queueWaitMs: integer('GENERATION_QUEUE_WAIT_MS', 60 * 60 * 1000, 1000, 60 * 60 * 1000),
    manualReviewWaitMs: integer(
      'GENERATION_MANUAL_REVIEW_WAIT_MS',
      24 * 60 * 60 * 1000,
      1000,
      24 * 60 * 60 * 1000,
    ),
    contentConcurrency: Math.max(1, integer('PARALLEL_SCENE_CONCURRENCY', 2, 0, 10)),
    llmConcurrency: integer('GENERATION_LLM_MAX_INFLIGHT', 3, 1, 30),
    ttsConcurrency: integer('GENERATION_TTS_CONCURRENCY', 2, 1, 10),
    mediaConcurrency: integer('GENERATION_MEDIA_CONCURRENCY', 1, 1, 5),
    leaseMs: 90_000,
    heartbeatMs: 10_000,
  };
}
