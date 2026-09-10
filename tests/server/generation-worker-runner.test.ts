import { describe, expect, it } from 'vitest';

import { safeWorkerStopReport } from '@/workers/generation/runner';
import type { GenerationLease } from '@/lib/server/generation-jobs/contracts';

const lease = {
  jobId: 'job-1',
  stageId: 'stage-1',
  ownerId: 'owner-1',
  workerId: 'worker-1',
  leaseEpoch: 1,
  ownershipEpoch: 1,
  planRevision: 3,
  input: {
    version: 1,
    requirements: { requirement: 'test' },
    review: { mode: 'auto' },
  },
} as GenerationLease;

describe('generation worker stop diagnostics', () => {
  it('reports an unknown TTS timeout without leaking provider details', () => {
    const error = Object.assign(
      new Error('POST https://api.example.test Bearer sk-secret-account-token'),
      {
        code: 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT',
        phase: 'tts',
        timeoutMs: 120_000,
      },
    );

    const report = safeWorkerStopReport(error, lease, 1_000, 5_250);

    expect(report).toEqual({
      event: 'job_stopped',
      jobId: 'job-1',
      category: 'external_result_unknown',
      code: 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT',
      summary: 'TTS request exceeded its deadline after dispatch; the external result is unknown.',
      phase: 'tts',
      elapsedMs: 4_250,
      deadlineMs: 120_000,
    });
    expect(JSON.stringify(report)).not.toContain('api.example.test');
    expect(JSON.stringify(report)).not.toContain('sk-secret');
  });

  it.each([
    ['GENERATION_LEASE_LOST', 'lease_lost'],
    ['WORKER_DRAIN_TIMEOUT', 'drain_timeout'],
    ['WORKER_DATABASE_UNAVAILABLE', 'database_unavailable'],
  ] as const)('classifies %s safely as %s', (code, category) => {
    const report = safeWorkerStopReport(
      Object.assign(new Error('private detail'), { code }),
      lease,
      10,
      20,
    );
    expect(report).toMatchObject({ event: 'job_stopped', jobId: 'job-1', code, category });
    expect(report.summary).not.toContain('private detail');
  });

  it('uses a bounded generic report for an unexpected error', () => {
    expect(safeWorkerStopReport(new Error('customer secret'), lease, 100, 50)).toEqual({
      event: 'job_stopped',
      jobId: 'job-1',
      category: 'unexpected',
      summary:
        'Generation execution stopped unexpectedly; inspect the durable job failure evidence.',
      phase: 'execution',
      elapsedMs: 0,
    });
  });
});
