// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationJobSnapshot } from '@/lib/generation/job-client';

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  observe: vi.fn(() => vi.fn()),
}));

vi.mock('@/lib/generation/job-client', async (load) => ({
  ...(await load<typeof import('@/lib/generation/job-client')>()),
  cancelGenerationJob: mocks.cancel,
  observeGenerationJob: mocks.observe,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

import { useGenerationJob } from '@/lib/hooks/use-generation-job';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type HookValue = ReturnType<typeof useGenerationJob>;

describe('useGenerationJob cancellation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: HookValue;
  const Harness = ({ jobId }: { jobId: string }) => {
    const value = useGenerationJob(jobId);
    useEffect(() => {
      latest = value;
    }, [value]);
    return null;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('reports pending and failed cancellation without claiming the job was cancelled', async () => {
    const request = deferred<GenerationJobSnapshot>();
    mocks.cancel.mockReturnValueOnce(request.promise);
    await act(async () => root.render(createElement(Harness, { jobId: 'job-a' })));

    let command!: Promise<GenerationJobSnapshot | undefined>;
    act(() => {
      command = latest.cancel();
    });
    const outcome = expect(command).rejects.toThrow('network unavailable');
    expect(latest.cancelling).toBe(true);
    expect(latest.cancelError).toBeNull();

    await act(async () => request.reject(new Error('network unavailable')));
    await outcome;
    expect(latest.cancelling).toBe(false);
    expect(latest.cancelError?.message).toBe('network unavailable');
    expect(latest.job?.status).not.toBe('cancelled');
  });

  it('drops a late cancellation response after observing a different job', async () => {
    const request = deferred<GenerationJobSnapshot>();
    mocks.cancel.mockReturnValueOnce(request.promise);
    await act(async () => root.render(createElement(Harness, { jobId: 'job-a' })));
    let command!: Promise<GenerationJobSnapshot | undefined>;
    act(() => {
      command = latest.cancel();
    });
    await act(async () => root.render(createElement(Harness, { jobId: 'job-b' })));
    await act(async () =>
      request.resolve({ jobId: 'job-a', status: 'cancelled' } as GenerationJobSnapshot),
    );
    await expect(command).resolves.toBeUndefined();

    expect(latest.job).toBeNull();
    expect(latest.cancelling).toBe(false);
    expect(latest.cancelError).toBeNull();
  });

  it('reuses the cancellation command key when the first request fails ambiguously', async () => {
    mocks.cancel
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ jobId: 'job-a', status: 'cancelled' } as GenerationJobSnapshot);
    await act(async () => root.render(createElement(Harness, { jobId: 'job-a' })));

    await act(async () => {
      await latest.cancel().catch(() => undefined);
    });
    await act(async () => {
      await latest.cancel();
    });

    expect(mocks.cancel).toHaveBeenCalledTimes(2);
    expect(mocks.cancel.mock.calls[0][1]).toBe(mocks.cancel.mock.calls[1][1]);
    expect(latest.job?.status).toBe('cancelled');
    expect(latest.cancelError).toBeNull();
  });
});
