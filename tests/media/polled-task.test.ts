import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPolledTask } from '@/lib/media/polled-task';
import { ConfirmedMediaFailure } from '@/lib/media/generation-errors';
import { withPolledTaskPersistence } from '@/lib/server/generation-jobs/polled-task-persistence';

describe('runPolledTask', () => {
  it.each(['failed', 'network', 'timeout'] as const)(
    'only marks a confirmed terminal poll failure safe: %s',
    async (outcome) => {
      vi.useFakeTimers();
      const result = runPolledTask({
        submit: async () => ({ status: 'submitted', taskId: 'accepted-task' }),
        poll: async () => {
          if (outcome === 'network') throw new Error('Poll HTTP 404');
          return outcome === 'failed'
            ? { status: 'failed', message: 'Confirmed task failure' }
            : { status: 'pending' };
        },
        intervalMs: 10,
        maxAttempts: 1,
        label: 'Test',
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect((await result) instanceof ConfirmedMediaFailure).toBe(outcome === 'failed');
    },
  );
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an immediately completed submission without waiting or polling', async () => {
    vi.useFakeTimers();
    const submit = vi.fn().mockResolvedValue({ status: 'done', result: 'video-url' });
    const poll = vi.fn();

    const result = await runPolledTask({
      submit,
      poll,
      intervalMs: 1_000,
      maxAttempts: 3,
      label: 'Test task',
    });

    expect(result).toBe('video-url');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an immediately failed submission without waiting or polling', async () => {
    vi.useFakeTimers();
    const submit = vi.fn().mockResolvedValue({ status: 'failed', message: 'submit failed' });
    const poll = vi.fn();

    await expect(
      runPolledTask({
        submit,
        poll,
        intervalMs: 1_000,
        maxAttempts: 3,
        label: 'Test task',
      }),
    ).rejects.toThrow('submit failed');

    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits before each poll and passes the submitted task id until completion', async () => {
    vi.useFakeTimers();
    const submit = vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'task-123' });
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending', detail: 'queued' })
      .mockResolvedValueOnce({ status: 'done', result: 'video-url' });

    const promise = runPolledTask({
      submit,
      poll,
      intervalMs: 1_000,
      maxAttempts: 3,
      label: 'Test task',
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(poll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenNthCalledWith(1, 'task-123');

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBe('video-url');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenNthCalledWith(2, 'task-123');
  });

  it('persists an accepted task before polling and resumes it without another paid submit', async () => {
    const persisted: string[] = [];
    const submit = vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'paid-123' });
    const poll = vi.fn().mockResolvedValue({ status: 'done', result: 'video-url' });
    await withPolledTaskPersistence(
      { persistTaskId: async (taskId) => void persisted.push(taskId) },
      () => runPolledTask({ submit, poll, intervalMs: 0, maxAttempts: 1, label: 'paid' }),
    );
    expect(persisted).toEqual(['paid-123']);
    expect(poll).toHaveBeenCalledWith('paid-123');

    const resumedSubmit = vi.fn();
    const resumedPersist = vi.fn();
    await withPolledTaskPersistence(
      { resumeTaskId: 'paid-123', persistTaskId: resumedPersist },
      () =>
        runPolledTask({
          submit: resumedSubmit,
          poll,
          intervalMs: 0,
          maxAttempts: 1,
          label: 'paid',
        }),
    );
    expect(resumedSubmit).not.toHaveBeenCalled();
    expect(resumedPersist).not.toHaveBeenCalled();
  });

  it('keeps interleaved persistence contexts isolated across concurrent tasks', async () => {
    let releaseFirstSubmit!: () => void;
    const firstSubmitMayFinish = new Promise<void>((resolve) => {
      releaseFirstSubmit = resolve;
    });
    const persistedByFirst: string[] = [];
    const persistedBySecond: string[] = [];
    const firstPoll = vi.fn().mockResolvedValue({ status: 'done', result: 'first-result' });
    const secondPoll = vi.fn().mockResolvedValue({ status: 'done', result: 'second-result' });

    const first = withPolledTaskPersistence(
      { persistTaskId: async (taskId) => void persistedByFirst.push(taskId) },
      () =>
        runPolledTask({
          submit: async () => {
            await firstSubmitMayFinish;
            return { status: 'submitted', taskId: 'task-first' };
          },
          poll: firstPoll,
          intervalMs: 0,
          maxAttempts: 1,
          label: 'first',
        }),
    );
    const second = withPolledTaskPersistence(
      { persistTaskId: async (taskId) => void persistedBySecond.push(taskId) },
      () =>
        runPolledTask({
          submit: async () => {
            releaseFirstSubmit();
            await Promise.resolve();
            return { status: 'submitted', taskId: 'task-second' };
          },
          poll: secondPoll,
          intervalMs: 0,
          maxAttempts: 1,
          label: 'second',
        }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual(['first-result', 'second-result']);
    expect(persistedByFirst).toEqual(['task-first']);
    expect(persistedBySecond).toEqual(['task-second']);
    expect(firstPoll).toHaveBeenCalledWith('task-first');
    expect(secondPoll).toHaveBeenCalledWith('task-second');
  });

  it('waits for durable task-id persistence before the first poll', async () => {
    let markPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    let finishPersistence!: () => void;
    const persistenceMayFinish = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const events: string[] = [];
    const poll = vi.fn(async () => {
      events.push('poll');
      return { status: 'done' as const, result: 'video-url' };
    });
    const result = withPolledTaskPersistence(
      {
        persistTaskId: async (taskId) => {
          events.push(`persist:start:${taskId}`);
          markPersistenceStarted();
          await persistenceMayFinish;
          events.push(`persist:end:${taskId}`);
        },
      },
      () =>
        runPolledTask({
          submit: async () => ({ status: 'submitted', taskId: 'durable-first' }),
          poll,
          intervalMs: 0,
          maxAttempts: 1,
          label: 'paid',
        }),
    );

    await persistenceStarted;
    expect(poll).not.toHaveBeenCalled();
    finishPersistence();

    await expect(result).resolves.toBe('video-url');
    expect(events).toEqual(['persist:start:durable-first', 'persist:end:durable-first', 'poll']);
  });

  it('fails before polling when the durable task-id receipt cannot be written', async () => {
    const poll = vi.fn();
    await expect(
      withPolledTaskPersistence(
        {
          persistTaskId: async () => {
            throw new Error('receipt unavailable');
          },
        },
        () =>
          runPolledTask({
            submit: async () => ({ status: 'submitted', taskId: 'accepted-but-unknown' }),
            poll,
            intervalMs: 0,
            maxAttempts: 1,
            label: 'paid',
          }),
      ),
    ).rejects.toThrow('receipt unavailable');
    expect(poll).not.toHaveBeenCalled();
  });

  it('rejects a terminal poll failure without scheduling another attempt', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ status: 'failed', message: 'provider failed' });
    const promise = runPolledTask({
      submit: vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'task-123' }),
      poll,
      intervalMs: 1_000,
      maxAttempts: 3,
      label: 'Test task',
    });
    const rejection = expect(promise).rejects.toThrow('provider failed');

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates submit and poll exceptions without wrapping them', async () => {
    const submitError = new TypeError('submit network error');
    await expect(
      runPolledTask({
        submit: vi.fn().mockRejectedValue(submitError),
        poll: vi.fn(),
        intervalMs: 0,
        maxAttempts: 1,
        label: 'Test task',
      }),
    ).rejects.toBe(submitError);

    const pollError = new SyntaxError('invalid poll response');
    await expect(
      runPolledTask({
        submit: vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'task-123' }),
        poll: vi.fn().mockRejectedValue(pollError),
        intervalMs: 0,
        maxAttempts: 1,
        label: 'Test task',
      }),
    ).rejects.toBe(pollError);
  });

  it('polls exactly maxAttempts times before using the default timeout message', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ status: 'pending' });
    const promise = withPolledTaskPersistence({ persistTaskId: vi.fn() }, () =>
      runPolledTask({
        submit: vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'task-123' }),
        poll,
        intervalMs: 250,
        maxAttempts: 3,
        label: 'Test task',
      }),
    );
    const rejection = expect(promise).rejects.toThrow('Test task timed out after 3 polls');

    await vi.advanceTimersByTimeAsync(750);

    await rejection;
    expect(poll).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes the latest pending detail and timing data to a custom timeout formatter', async () => {
    vi.useFakeTimers();
    const formatTimeout = vi.fn(
      ({ lastPendingDetail }: { lastPendingDetail?: string }) =>
        `last status: ${lastPendingDetail}`,
    );
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending', detail: 'Queued' })
      .mockResolvedValueOnce({ status: 'pending', detail: 'Processing' });
    const promise = runPolledTask({
      submit: vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'task-123' }),
      poll,
      intervalMs: 500,
      maxAttempts: 2,
      label: 'Test task',
      formatTimeout,
    });
    const rejection = expect(promise).rejects.toThrow('last status: Processing');

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(formatTimeout).toHaveBeenCalledWith({
      label: 'Test task',
      taskId: 'task-123',
      attempts: 2,
      intervalMs: 500,
      elapsedMs: 1_000,
      lastPendingDetail: 'Processing',
    });
  });
});
