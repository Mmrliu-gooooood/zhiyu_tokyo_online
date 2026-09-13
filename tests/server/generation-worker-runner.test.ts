import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runWorker,
  safeWorkerStopReport,
  type GenerationWorkerReport,
  type WorkerRepository,
} from '@/workers/generation/runner';
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
  afterEach(() => vi.useRealTimers());

  it.each([
    ['GENERATION_LEASE_LOST', 'lease_lost', false],
    ['WORKER_DRAIN_TIMEOUT', 'drain_timeout', false],
    ['WORKER_DATABASE_UNAVAILABLE', 'database_unavailable', false],
    ['GENERATION_LEASE_LOST', 'lease_lost', true],
    ['WORKER_DRAIN_TIMEOUT', 'drain_timeout', true],
    ['WORKER_DATABASE_UNAVAILABLE', 'database_unavailable', true],
  ] as const)(
    'reports runWorker %s as %s when provider wraps abort: %s',
    async (code, category, wrapped) => {
      vi.useFakeTimers();
      const workerController = new AbortController();
      const reports: GenerationWorkerReport[] = [];
      let onStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        onStarted = resolve;
      });
      const repository: WorkerRepository = {
        claim: vi.fn().mockResolvedValueOnce(lease).mockResolvedValue(null),
        heartbeat: async () => {
          if (code === 'WORKER_DATABASE_UNAVAILABLE') throw new Error('private database details');
          return code !== 'GENERATION_LEASE_LOST';
        },
        workerHeartbeat: async () => {},
        reapExpired: async () => 0,
        expireWaitingJobs: async () => 0,
        confirmDuePlans: async () => 0,
      };
      const worker = runWorker({
        repository,
        workerId: 'worker-1',
        concurrency: 1,
        heartbeatMs: 1000,
        signal: workerController.signal,
        execute: async (_lease, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () =>
                reject(
                  wrapped
                    ? new Error('provider wrapped abort with private request details')
                    : signal.reason,
                ),
              { once: true },
            );
            onStarted();
          }),
        report: (report) => {
          reports.push(report);
          if (report.event === 'job_stopped') workerController.abort();
        },
      });
      await started;
      if (code === 'WORKER_DRAIN_TIMEOUT') workerController.abort();
      await vi.advanceTimersByTimeAsync(code === 'WORKER_DRAIN_TIMEOUT' ? 25_000 : 1000);
      await worker;

      expect(reports.find((report) => report.event === 'job_stopped')).toMatchObject({
        event: 'job_stopped',
        jobId: lease.jobId,
        code,
        category,
      });
      expect(JSON.stringify(reports)).not.toContain('private database details');
      expect(JSON.stringify(reports)).not.toContain('private request details');
    },
  );

  it('preserves the execute failure when the worker did not abort its own job signal', async () => {
    const workerController = new AbortController();
    const reports: GenerationWorkerReport[] = [];
    await runWorker({
      repository: {
        claim: vi.fn().mockResolvedValueOnce(lease).mockResolvedValue(null),
        heartbeat: async () => true,
        workerHeartbeat: async () => {},
        reapExpired: async () => 0,
        expireWaitingJobs: async () => 0,
        confirmDuePlans: async () => 0,
      },
      workerId: 'worker-1',
      concurrency: 1,
      heartbeatMs: 1000,
      signal: workerController.signal,
      execute: async (_lease, signal) => {
        expect(signal.aborted).toBe(false);
        throw Object.assign(new Error('private request details'), {
          code: 'EXTERNAL_RESULT_UNKNOWN',
        });
      },
      report: (report) => {
        reports.push(report);
        if (report.event === 'job_stopped') workerController.abort();
      },
    });
    expect(reports.find((report) => report.event === 'job_stopped')).toMatchObject({
      category: 'external_result_unknown',
      code: 'EXTERNAL_RESULT_UNKNOWN',
    });
    expect(JSON.stringify(reports)).not.toContain('private request details');
  });

  it('reports only whitelisted provider failure fields', () => {
    const error = Object.assign(new Error('private response body'), {
      code: 'TTS_PROVIDER_TERMINAL_FAILURE',
      provider: 'minimax-tts',
      httpStatus: 200,
      providerCode: 1004,
      traceId: 'trace-123',
      apiKey: 'private-secret',
    });
    const report = safeWorkerStopReport(error, lease, 0, 1);
    expect(report).toMatchObject({
      code: 'TTS_PROVIDER_TERMINAL_FAILURE',
      diagnostic: {
        providerId: 'minimax-tts',
        httpStatus: 200,
        providerCode: 1004,
        traceId: 'trace-123',
      },
    });
    expect(JSON.stringify(report)).not.toContain('private');
  });

  it('does not infer an internal stop code from an arbitrary error message', () => {
    expect(safeWorkerStopReport(new Error('GENERATION_LEASE_LOST'), lease, 0, 1)).toMatchObject({
      category: 'unexpected',
    });
    expect(
      safeWorkerStopReport(new Error('GENERATION_LEASE_LOST'), lease, 0, 1),
    ).not.toHaveProperty('code');
  });

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

  it('does not describe a generic unknown LLM result as a TTS timeout', () => {
    const report = safeWorkerStopReport(
      Object.assign(new Error('private provider detail'), {
        code: 'EXTERNAL_RESULT_UNKNOWN',
        phase: 'agents:call:0',
      }),
      lease,
      100,
      250,
    );

    expect(report).toMatchObject({
      category: 'external_result_unknown',
      code: 'EXTERNAL_RESULT_UNKNOWN',
      phase: 'agents:call:0',
      summary: 'External provider request outcome is unknown; durable evidence requires review.',
    });
    expect(report.summary).not.toContain('TTS');
  });

  it('reports a DNS failure as a request that was not sent', () => {
    expect(
      safeWorkerStopReport(
        Object.assign(new Error('getaddrinfo EAI_AGAIN private.example'), {
          code: 'PROVIDER_REQUEST_NOT_SENT',
          phase: 'agents:call:0',
        }),
        lease,
        100,
        250,
      ),
    ).toMatchObject({
      category: 'provider_request_not_sent',
      code: 'PROVIDER_REQUEST_NOT_SENT',
      phase: 'agents:call:0',
      summary:
        'Provider request was not sent because DNS resolution failed; a bounded retry is safe.',
    });
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
