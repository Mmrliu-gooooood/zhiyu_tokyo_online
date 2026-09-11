import type {
  GenerationDisplayIssue,
  GenerationDisplayProgress,
  GenerationJobStatus,
} from '@/lib/server/generation-jobs/contracts';

export type GenerationRecovery = 'none' | 'retry' | 'confirm_unknown';

export interface GenerationJobDisplayProjection {
  status: GenerationJobStatus;
  executing: boolean;
  terminal: boolean;
  stopped: boolean;
  recovery: GenerationRecovery;
  retryAt: string | null;
  affectedOutlineIds: string[];
  triggerIssues: GenerationDisplayIssue[];
  unknownIssues: GenerationDisplayIssue[];
}

export interface GenerationJobDisplayInput {
  status: GenerationJobStatus;
  retryAt?: string | null;
  displayProgress?: GenerationDisplayProgress;
  scenes?: Array<{ outlineId: string; status: string }>;
}

/**
 * One lifecycle projection shared by preview and Classroom. Scene checkpoint
 * status is evidence, but the job status decides whether work is executing.
 */
export function projectGenerationJobDisplay(
  input: GenerationJobDisplayInput,
): GenerationJobDisplayProjection {
  const stopped = input.status === 'failed' || input.status === 'needs_attention';
  const issues = input.displayProgress?.issues ?? [];
  const fallbackIssue = input.displayProgress?.failedStep;
  const normalizedIssues =
    issues.length || !fallbackIssue
      ? issues
      : [
          {
            ...(fallbackIssue.outlineId ? { outlineId: fallbackIssue.outlineId } : {}),
            phase: fallbackIssue.phase,
            code: fallbackIssue.code,
            state:
              fallbackIssue.code === 'EXTERNAL_RESULT_UNKNOWN'
                ? ('unknown' as const)
                : ('failed' as const),
          },
        ];
  const unknownIssues = normalizedIssues.filter(
    (issue) => issue.state === 'unknown' || issue.code === 'EXTERNAL_RESULT_UNKNOWN',
  );
  const triggerIssues = normalizedIssues.filter(
    (issue) => issue.state !== 'unknown' && issue.code !== 'EXTERNAL_RESULT_UNKNOWN',
  );
  const affectedOutlineIds = stopped
    ? [
        ...new Set(
          input.scenes?.length
            ? input.scenes
                .filter((scene) => scene.status !== 'ready')
                .map((scene) => scene.outlineId)
            : normalizedIssues
                .map((issue) => issue.outlineId)
                .filter((outlineId): outlineId is string => Boolean(outlineId)),
        ),
      ]
    : [];

  return {
    status: input.status,
    executing: input.status === 'running',
    terminal: ['needs_attention', 'failed', 'cancelled', 'succeeded'].includes(input.status),
    stopped,
    recovery:
      input.status === 'needs_attention'
        ? 'confirm_unknown'
        : input.status === 'failed'
          ? 'retry'
          : 'none',
    retryAt: input.status === 'retry_wait' ? (input.retryAt ?? null) : null,
    affectedOutlineIds,
    triggerIssues,
    unknownIssues,
  };
}
