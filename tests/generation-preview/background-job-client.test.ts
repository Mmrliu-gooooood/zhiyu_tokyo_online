import { afterEach, describe, expect, it, vi } from 'vitest';
import { canGenerateLocally } from '@/lib/generation/ownership';
import {
  createGenerationJob,
  observeGenerationJob,
  readBackgroundGenerationCapability,
  retryGenerationJob,
  cancelGenerationJob,
} from '@/lib/generation/job-client';
import type { GenerationJobSnapshot } from '@/lib/generation/job-client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('durable job client ownership', () => {
  it('requires explicit acknowledgement before retrying an unknown billable result', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json({ jobId: 'job-1', status: 'queued' }));
    vi.stubGlobal('fetch', fetchMock);
    const confirm = vi.fn().mockReturnValue(false);
    const job = { jobId: 'job-1', status: 'needs_attention' as const, stateVersion: 7 };
    expect(await retryGenerationJob(job, { key: 'retry-1', confirmUnknown: confirm })).toBeNull();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('重复费用'));
    expect(fetchMock).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await retryGenerationJob(job, { key: 'retry-1', confirmUnknown: confirm });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/generate-classroom/job-1/retry');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      commandKey: 'retry-1',
      expectedVersion: 7,
      acknowledged: true,
    });
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('retry-1');
  });

  it('retries an ordinary failed job without creating a replacement or acknowledging unknown cost', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json({ jobId: 'job-1', status: 'queued' }));
    vi.stubGlobal('fetch', fetchMock);
    const confirm = vi.fn();
    await retryGenerationJob(
      { jobId: 'job-1', status: 'failed', stateVersion: 9 },
      { key: 'retry-2', confirmUnknown: confirm },
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/generate-classroom/job-1/retry');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      commandKey: 'retry-2',
      expectedVersion: 9,
    });
  });

  it('only cancels through an explicit command and does not retry a cancelled job', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => Response.json({ jobId: 'job-1', status: 'cancelled' }));
    vi.stubGlobal('fetch', fetchMock);
    await cancelGenerationJob('job-1', 'cancel-1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/generate-classroom/job-1/cancel');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ commandKey: 'cancel-1' });
    await retryGenerationJob({ jobId: 'job-1', status: 'cancelled', stateVersion: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks both server producer kinds and viewer generation regardless of completion', () => {
    expect(canGenerateLocally({ outlineProducer: 'server-job' })).toBe(false);
    expect(canGenerateLocally({ outlineProducer: 'unknown-producer' })).toBe(false);
    expect(canGenerateLocally({ outlineProducer: 'client', readOnly: true })).toBe(false);
    expect(canGenerateLocally({ isOwner: false })).toBe(false);
    expect(canGenerateLocally({ outlineProducer: 'client' })).toBe(true);
    expect(canGenerateLocally({ outlineProducer: null })).toBe(true);
  });

  it('does not mistake a failed capability request for local generation permission', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    await expect(readBackgroundGenerationCapability()).rejects.toThrow(
      'GENERATION_CAPABILITY_UNAVAILABLE',
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ generation: { background: { enabled: true, available: false } } }),
        ),
    );
    expect(await readBackgroundGenerationCapability()).toEqual({ enabled: true, available: false });
  });

  it('reuses the persisted create key and never sends provider credentials in headers', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ jobId: 'job' }));
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      version: 1 as const,
      requirements: { requirement: 'Physics' },
      review: { mode: 'manual' as const },
    };
    await createGenerationJob(input, 'session:1');
    await createGenerationJob(input, 'session:1');
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'session:1' },
        body: JSON.stringify(input),
      }),
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(fetchMock.mock.calls[1][1]);
  });

  it('closing an observer only aborts reads and drops a late response', async () => {
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onSnapshot = vi.fn();
    const stop = observeGenerationJob('a', onSnapshot, vi.fn());
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    stop();
    resolve(Response.json({ jobId: 'a', status: 'running', stateVersion: 1 }));
    await new Promise((done) => setTimeout(done, 0));
    expect(signal.aborted).toBe(true);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('ignores regressions and equal versions without resetting playback consumers', async () => {
    vi.useFakeTimers();
    const snapshots = [3, 2, 3, 4].map((stateVersion) => ({
      jobId: 'a',
      stateVersion,
      status: 'running',
      pollIntervalMs: 1000,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => Response.json(snapshots.shift())),
    );
    const versions: number[] = [];
    const stop = observeGenerationJob(
      'a',
      (snapshot: GenerationJobSnapshot) => {
        versions.push(snapshot.stateVersion);
      },
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(3100);
    stop();
    expect(versions).toEqual([3, 4]);
  });

  it('reports a recovered observation connection without republishing an equal snapshot', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ jobId: 'a', stateVersion: 3, status: 'running', pollIntervalMs: 1000 }),
      )
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        Response.json({ jobId: 'a', stateVersion: 3, status: 'running', pollIntervalMs: 1000 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const onSnapshot = vi.fn();
    const onError = vi.fn();
    const onReconnect = vi.fn();
    const stop = observeGenerationJob('a', onSnapshot, onError, onReconnect);

    await vi.advanceTimersByTimeAsync(6100);
    stop();

    expect(onError).toHaveBeenCalledOnce();
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onSnapshot).toHaveBeenCalledOnce();
  });
});
