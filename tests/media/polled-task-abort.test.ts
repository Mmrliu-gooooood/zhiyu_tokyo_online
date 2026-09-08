import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPolledTask } from '@/lib/media/polled-task';

describe('runPolledTask cancellation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not submit when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel before submit');
    controller.abort(reason);
    const submit = vi.fn();

    await expect(
      runPolledTask({
        submit,
        poll: vi.fn(),
        intervalMs: 1_000,
        maxAttempts: 3,
        label: 'Abortable task',
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(submit).not.toHaveBeenCalled();
  });

  it('cancels an in-progress wait without polling or leaking a timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error('stop polling');
    const poll = vi.fn();
    const promise = runPolledTask({
      submit: vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'task-1' }),
      poll,
      intervalMs: 10_000,
      maxAttempts: 3,
      label: 'Abortable task',
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
