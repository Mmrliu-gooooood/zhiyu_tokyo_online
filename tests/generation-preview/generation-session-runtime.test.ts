import { describe, expect, it, vi } from 'vitest';

import {
  GenerationResourceLease,
  GenerationSessionRuntime,
  type GenerationCanonicalPhase,
} from '@/app/generation-preview/generation-session-runtime';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('GenerationSessionRuntime public seam', () => {
  it('accepts the canonical happy-path transitions and rejects illegal jumps', () => {
    const phases: GenerationCanonicalPhase[] = [];
    const runtime = new GenerationSessionRuntime({ onPhase: (phase) => phases.push(phase) });
    const run = runtime.start();

    expect(runtime.transition(run.epoch, 'outline-review')).toBe(true);
    expect(runtime.transition(run.epoch, 'agent-generation')).toBe(true);
    expect(runtime.transition(run.epoch, 'scene-generation')).toBe(true);
    expect(runtime.transition(run.epoch, 'media-actions')).toBe(true);
    expect(runtime.transition(run.epoch, 'completed')).toBe(true);
    expect(runtime.transition(run.epoch, 'outline-streaming')).toBe(false);
    expect(phases).toEqual([
      'outline-streaming',
      'outline-review',
      'agent-generation',
      'scene-generation',
      'media-actions',
      'completed',
    ]);
  });

  it('allows no-review generation and terminal failure or cancellation paths', () => {
    const runtime = new GenerationSessionRuntime();
    const noReview = runtime.start();
    expect(runtime.transition(noReview.epoch, 'agent-generation')).toBe(true);
    expect(runtime.transition(noReview.epoch, 'failed')).toBe(true);
    expect(noReview.signal.aborted).toBe(true);

    const restarted = runtime.restart('agent-generation');
    expect(restarted.epoch).toBeGreaterThan(noReview.epoch);
    expect(runtime.phase).toBe('agent-generation');
    runtime.cancel();
    expect(runtime.phase).toBe('cancelled');
    expect(restarted.signal.aborted).toBe(true);
  });

  it('fences stale async commits after restart, cancellation, and stop', () => {
    const commit = vi.fn();
    const runtime = new GenerationSessionRuntime();
    const first = runtime.start();
    expect(runtime.commit(first.epoch, commit)).toBe(true);

    const second = runtime.restart();
    expect(runtime.commit(first.epoch, commit)).toBe(false);
    expect(runtime.commit(second.epoch, commit)).toBe(true);

    runtime.cancel();
    expect(runtime.commit(second.epoch, commit)).toBe(false);
    const third = runtime.restart('scene-generation');
    runtime.stop();
    runtime.stop();
    expect(runtime.commit(third.epoch, commit)).toBe(false);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('keeps independent mounts isolated without module-scoped runtime state', () => {
    const first = new GenerationSessionRuntime();
    const second = new GenerationSessionRuntime();
    const firstRun = first.start();
    const secondRun = second.start();

    first.cancel();
    expect(firstRun.signal.aborted).toBe(true);
    expect(secondRun.signal.aborted).toBe(false);
    expect(second.isCurrent(secondRun.epoch)).toBe(true);
  });

  it('aborts every owned signal across 20 mount cleanup cycles', () => {
    const signals: AbortSignal[] = [];

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const runtime = new GenerationSessionRuntime();
      signals.push(runtime.start().signal);
      runtime.stop();
      runtime.stop();
      expect(runtime.phase).toBe('cancelled');
    }

    expect(signals).toHaveLength(20);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('keeps stale scene, timeline, and session persistence out of cancel-restart state', async () => {
    const late = deferred();
    const projection = {
      scenes: [] as string[],
      timeline: [] as string[],
      sessionStorage: '' as string,
    };
    const runtime = new GenerationSessionRuntime();
    const retired = runtime.start();
    const retiredCompletion = late.promise.then(() =>
      runtime.commit(retired.epoch, () => {
        projection.scenes.push('stale-scene');
        projection.timeline.push('stale-media');
        projection.sessionStorage = 'stale-session';
      }),
    );

    runtime.cancel();
    const current = runtime.restart('scene-generation');
    runtime.commit(current.epoch, () => {
      projection.scenes.push('fresh-scene');
      projection.timeline.push('fresh-scene-generation');
      projection.sessionStorage = 'fresh-session';
    });
    late.resolve();

    await expect(retiredCompletion).resolves.toBe(false);
    expect(projection).toEqual({
      scenes: ['fresh-scene'],
      timeline: ['fresh-scene-generation'],
      sessionStorage: 'fresh-session',
    });
  });

  it('persists a candidate before publish and discards it when its epoch retires', async () => {
    const retiredPersistence = deferred();
    const events: string[] = [];
    const runtime = new GenerationSessionRuntime();
    const retired = runtime.start('media-actions');
    const retiredFinish = runtime.publishAfterPersist(retired.epoch, {
      persist: async () => {
        events.push('retired:persist:start');
        await retiredPersistence.promise;
        events.push('retired:persist:end');
      },
      discard: async () => {
        events.push('retired:discard');
      },
      publish: () => {
        events.push('retired:publish');
      },
    });

    const current = runtime.restart('media-actions');
    await expect(
      runtime.publishAfterPersist(current.epoch, {
        persist: async () => {
          events.push('current:persist');
        },
        discard: async () => {
          events.push('current:discard');
        },
        publish: () => {
          events.push('current:publish');
        },
      }),
    ).resolves.toBe(true);

    retiredPersistence.resolve();
    await expect(retiredFinish).resolves.toBe(false);
    expect(events).toEqual([
      'retired:persist:start',
      'current:persist',
      'current:publish',
      'retired:persist:end',
      'retired:discard',
    ]);
  });

  it('transfers recoverable resources across refresh but discards abandoned run resources', async () => {
    const discard = vi.fn(async (_ids: readonly string[]) => undefined);
    const lease = new GenerationResourceLease(discard);

    lease.own(['image-1', 'image-2']);
    lease.transfer();
    await lease.discard();
    expect(discard).not.toHaveBeenCalled();

    lease.own(['image-3']);
    await lease.discard();
    await lease.discard();
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith(['image-3']);
  });

  it('revokes a failed session and aborts its signal before awaiting resource cleanup', async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const events: string[] = [];
    const runtime = new GenerationSessionRuntime({
      onPhase: (phase) => events.push(`phase:${phase}`),
    });
    const { epoch, signal } = runtime.start('agent-generation');

    const failure = runtime.failAfterRevoking(epoch, {
      revoke: () => events.push('session:revoked'),
      discard: async () => {
        events.push(`discard:started:${signal.aborted}`);
        await cleanup;
        events.push('discard:finished');
      },
    });

    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(events).toEqual([
      'phase:agent-generation',
      'session:revoked',
      'phase:failed',
      'discard:started:true',
    ]);

    releaseCleanup();
    await expect(failure).resolves.toBe(true);
    expect(events.at(-1)).toBe('discard:finished');
  });
});
