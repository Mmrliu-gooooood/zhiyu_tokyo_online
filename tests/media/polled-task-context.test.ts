import { afterEach, describe, expect, it, vi } from 'vitest';

import { POLLED_TASK_PERSISTENCE_GLOBAL_KEY } from '@/lib/media/polled-task-context';

const state = globalThis as Record<string, unknown>;
const contextKey = POLLED_TASK_PERSISTENCE_GLOBAL_KEY;
let originalContext: unknown;

describe('polled task persistence context boundary', () => {
  afterEach(() => {
    vi.doUnmock('node:async_hooks');
    if (originalContext === undefined) delete state[contextKey];
    else state[contextKey] = originalContext;
    vi.resetModules();
  });

  it('loads and runs the shared polling module without Node async hooks or a carrier', async () => {
    originalContext = state[contextKey];
    delete state[contextKey];
    vi.resetModules();
    vi.doMock('node:async_hooks', () => ({}));

    const { runPolledTask } = await import('@/lib/media/polled-task');
    const result = await runPolledTask({
      submit: async () => ({ status: 'submitted', taskId: 'browser-safe-task' }),
      poll: async () => ({ status: 'done', result: 'video-url' }),
      intervalMs: 0,
      maxAttempts: 1,
      label: 'browser-safe',
    });

    expect(result).toBe('video-url');
    expect(state[contextKey]).toBeUndefined();
  });

  it('reuses one server carrier across module copies', async () => {
    originalContext = state[contextKey];
    delete state[contextKey];
    vi.resetModules();

    await import('@/lib/server/generation-jobs/polled-task-persistence');
    const firstCarrier = state[contextKey];
    vi.resetModules();
    await import('@/lib/server/generation-jobs/polled-task-persistence');

    expect(firstCarrier).toBeDefined();
    expect(state[contextKey]).toBe(firstCarrier);
  });
});
