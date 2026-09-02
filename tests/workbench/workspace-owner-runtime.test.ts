import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceOwnerRuntime,
  type WorkspaceOwnerRuntimeOptions,
} from '@/lib/workbench/workspace-owner-runtime';
import type { OwnerEventSource } from '@/lib/workbench/owner-session-client';
import type { ProHomeSessionItem } from '@/lib/workbench/pro-home-data';

class CountingEventSource implements OwnerEventSource {
  static created = 0;
  static live = 0;
  static closed = 0;
  readonly listeners = new Map<string, Set<EventListener>>();
  readyState = 1;
  onerror: ((event: Event) => void) | null = null;

  constructor() {
    CountingEventSource.created += 1;
    CountingEventSource.live += 1;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    if (this.readyState === 2) return;
    this.readyState = 2;
    CountingEventSource.closed += 1;
    CountingEventSource.live -= 1;
  }
}

const row = (title: string | null = 'Old title'): ProHomeSessionItem => ({
  id: 'session-1',
  stageId: 'course-1',
  prompt: 'Build a course',
  title,
  status: 'succeeded',
  createdAt: 100,
  updatedAt: 200,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class TestSessionTitleLocks {
  readonly signals: AbortSignal[] = [];
  private active = false;
  private readonly waiters: Array<() => void> = [];

  request<T>(
    _name: string,
    optionsOrTask:
      | { readonly ifAvailable?: boolean; readonly signal?: AbortSignal }
      | ((lock: object | null) => Promise<T> | T),
    maybeTask?: (lock: object | null) => Promise<T> | T,
  ): Promise<T> {
    const options = typeof optionsOrTask === 'function' ? {} : optionsOrTask;
    const task = typeof optionsOrTask === 'function' ? optionsOrTask : maybeTask!;
    if (options.ifAvailable && options.signal) {
      return Promise.reject(
        new DOMException('Unsupported option combination', 'NotSupportedError'),
      );
    }
    if (options.signal) this.signals.push(options.signal);
    if (options.ifAvailable && this.active) return Promise.resolve(task(null));
    return new Promise<T>((resolve, reject) => {
      let waiting = true;
      const run = () => {
        if (!waiting) return;
        waiting = false;
        if (options.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          this.release();
          return;
        }
        this.active = true;
        void Promise.resolve(task({}))
          .then(resolve, reject)
          .finally(() => this.release());
      };
      const onAbort = () => {
        if (!waiting) return;
        waiting = false;
        const waiterIndex = this.waiters.indexOf(run);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (this.active) this.waiters.push(run);
      else run();
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active = false;
  }
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { locks: new TestSessionTitleLocks() });
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('sessionStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function options(
  overrides: Partial<WorkspaceOwnerRuntimeOptions> = {},
): WorkspaceOwnerRuntimeOptions {
  return {
    fetchSessions: vi.fn(async () => [row()]),
    createEventSource: () => new CountingEventSource(),
    getAttachedSession: () => ({ id: 'session-1', title: 'Old title', prompt: 'Build a course' }),
    syncAttachedTitle: vi.fn(),
    saveSessionTitle: vi.fn(async (_sessionId, title) => title),
    ...overrides,
  };
}

describe('WorkspaceOwnerRuntime public seam', () => {
  it('owns one OwnerSessionClient per mount and cleans up 20 mounts idempotently', async () => {
    CountingEventSource.created = 0;
    CountingEventSource.live = 0;
    CountingEventSource.closed = 0;
    for (let index = 0; index < 20; index += 1) {
      const runtime = new WorkspaceOwnerRuntime(options());
      runtime.start();
      runtime.start();
      await flushPromises();
      expect(CountingEventSource.live).toBe(1);
      runtime.stop();
      runtime.stop();
    }

    expect(CountingEventSource.created).toBe(20);
    expect(CountingEventSource.closed).toBe(20);
    expect(CountingEventSource.live).toBe(0);
  });

  it('publishes one stable snapshot seam for owner rows and state', async () => {
    const runtime = new WorkspaceOwnerRuntime(options());
    const publications: unknown[] = [];
    const unsubscribe = runtime.subscribe(() => publications.push(runtime.getSnapshot()));

    runtime.start();
    await flushPromises();

    expect(runtime.getSnapshot()).toMatchObject({ state: 'ready', sessions: [row()] });
    expect(publications.length).toBeGreaterThan(0);
    unsubscribe();
    runtime.stop();
  });

  it('serializes rapid A to B to C renames and lets only C settle the attached title', async () => {
    const requests = [
      deferred<string | null>(),
      deferred<string | null>(),
      deferred<string | null>(),
    ];
    let storedTitle: string | null = 'Old title';
    const saveSessionTitle = vi.fn((_: string, _title: string | null) => {
      const request = requests[saveSessionTitle.mock.calls.length - 1]!.promise;
      return request.then((stored) => {
        storedTitle = stored;
        return stored;
      });
    });
    const syncAttachedTitle = vi.fn();
    const runtime = new WorkspaceOwnerRuntime(
      options({
        fetchSessions: vi.fn(async () => [row(storedTitle)]),
        saveSessionTitle,
        syncAttachedTitle,
      }),
    );
    runtime.start();
    await flushPromises();

    const renameA = runtime.renameSession('session-1', 'Title A');
    const renameB = runtime.renameSession('session-1', 'Title B');
    const renameC = runtime.renameSession('session-1', 'Title C');
    await flushPromises();
    expect(saveSessionTitle.mock.calls.map((call) => call[1])).toEqual(['Title A']);

    requests[0]!.resolve('Title A');
    await renameA;
    await flushPromises();
    requests[1]!.resolve('Title B');
    await renameB;
    await flushPromises();
    requests[2]!.resolve('Title C');
    await renameC;

    expect(saveSessionTitle.mock.calls.map((call) => call[1])).toEqual([
      'Title A',
      'Title B',
      'Title C',
    ]);
    expect(syncAttachedTitle).toHaveBeenLastCalledWith('session-1', 'Title C');
    expect(runtime.getSnapshot().sessions[0]?.title).toBe('Title C');
    runtime.stop();
  });

  it('keeps a fresh unchanged title as a zero-request decision', async () => {
    const saveSessionTitle = vi.fn(async (_sessionId: string, title: string | null) => title);
    const runtime = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    runtime.start();
    await flushPromises();

    await expect(runtime.renameSession('session-1', 'Old title')).resolves.toBe('unchanged');
    expect(saveSessionTitle).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('keeps a remounted writer behind the previous mount so the newest title wins', async () => {
    const firstSave = deferred<string | null>();
    let storedTitle: string | null = 'Old title';
    const saveSessionTitle = vi.fn((_sessionId: string, title: string | null) => {
      if (saveSessionTitle.mock.calls.length === 1) {
        return firstSave.promise.then((stored) => {
          storedTitle = stored;
          return stored;
        });
      }
      storedTitle = title;
      return Promise.resolve(title);
    });
    const locks = new TestSessionTitleLocks();
    vi.stubGlobal('navigator', { locks });

    const first = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    first.start();
    await flushPromises();
    const renameA = first.renameSession('session-1', 'Title A');
    await flushPromises();
    expect(saveSessionTitle).toHaveBeenCalledTimes(1);
    first.stop();

    const second = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    second.start();
    await flushPromises();
    const renameB = second.renameSession('session-1', 'Title B');
    await flushPromises();
    expect(saveSessionTitle).toHaveBeenCalledTimes(1);

    firstSave.resolve('Title A');
    await renameA;
    await renameB;

    expect(saveSessionTitle.mock.calls.map((call) => call[1])).toEqual(['Title A', 'Title B']);
    expect(storedTitle).toBe('Title B');
    second.stop();
    vi.unstubAllGlobals();
  });

  it('persists an explicit return to the stale snapshot after a remount', async () => {
    const firstSave = deferred<string | null>();
    let storedTitle: string | null = 'Old title';
    const saveSessionTitle = vi.fn((_sessionId: string, title: string | null) => {
      if (saveSessionTitle.mock.calls.length === 1) {
        return firstSave.promise.then((stored) => {
          storedTitle = stored;
          return stored;
        });
      }
      storedTitle = title;
      return Promise.resolve(title);
    });
    vi.stubGlobal('navigator', { locks: new TestSessionTitleLocks() });

    const first = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    first.start();
    await flushPromises();
    const renameA = first.renameSession('session-1', 'Title A');
    await flushPromises();
    first.stop();

    const second = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    second.start();
    await flushPromises();
    const renameBack = second.renameSession('session-1', 'Old title');
    await flushPromises();
    expect(saveSessionTitle).toHaveBeenCalledTimes(1);

    firstSave.resolve('Title A');
    await renameA;
    await renameBack;

    expect(saveSessionTitle.mock.calls.map((call) => call[1])).toEqual(['Title A', 'Old title']);
    expect(storedTitle).toBe('Old title');
    second.stop();
    vi.unstubAllGlobals();
  });

  it('retains recency evidence until an already-queued remount consumes it', async () => {
    const firstSave = deferred<string | null>();
    let storedTitle: string | null = 'Old title';
    const saveSessionTitle = vi.fn((_sessionId: string, title: string | null) => {
      if (saveSessionTitle.mock.calls.length === 1) {
        return firstSave.promise.then((stored) => {
          storedTitle = stored;
          return stored;
        });
      }
      storedTitle = title;
      return Promise.resolve(title);
    });
    const fetchSessions = vi.fn(async () => [row(storedTitle)]);
    const first = new WorkspaceOwnerRuntime(options({ fetchSessions, saveSessionTitle }));
    first.start();
    await flushPromises();
    const renameA = first.renameSession('session-1', 'Title A');
    await flushPromises();

    const second = new WorkspaceOwnerRuntime(options({ fetchSessions, saveSessionTitle }));
    second.start();
    await flushPromises();
    const renameBack = second.renameSession('session-1', 'Old title');
    await flushPromises();
    expect(saveSessionTitle).toHaveBeenCalledTimes(1);

    firstSave.resolve('Title A');
    await renameA;
    await renameBack;

    expect(fetchSessions.mock.calls.length).toBeGreaterThan(2);
    expect(saveSessionTitle.mock.calls.map((call) => call[1])).toEqual(['Title A', 'Old title']);
    expect(storedTitle).toBe('Old title');
    first.stop();
    second.stop();
  });

  it('persists a stale-projection decision after the previous lock was already released', async () => {
    let storedTitle: string | null = 'Old title';
    const saveSessionTitle = vi.fn(async (_sessionId: string, title: string | null) => {
      storedTitle = title;
      return title;
    });
    const first = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    first.start();
    await flushPromises();
    await first.renameSession('session-1', 'Title A');
    first.stop();
    expect(storedTitle).toBe('Title A');

    // The new mount has not reconciled A yet and still projects Old title.
    const second = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    second.start();
    await flushPromises();
    await second.renameSession('session-1', 'Old title');

    expect(saveSessionTitle.mock.calls.map((call) => call[1])).toEqual(['Title A', 'Old title']);
    expect(storedTitle).toBe('Old title');
    second.stop();
  });

  it('preserves an ordinary title write when Web Locks are unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const saveSessionTitle = vi.fn(async (_sessionId: string, title: string | null) => title);
    const runtime = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    runtime.start();
    await flushPromises();

    await expect(runtime.renameSession('session-1', 'Title A')).resolves.toBe('renamed');
    expect(saveSessionTitle).toHaveBeenCalledOnce();
    runtime.stop();
    vi.unstubAllGlobals();
  });

  it('serializes remounted writers through the storage lease without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    const firstSave = deferred<string | null>();
    let storedTitle: string | null = 'Old title';
    const saveSessionTitle = vi.fn((_sessionId: string, title: string | null) => {
      if (saveSessionTitle.mock.calls.length === 1) {
        return firstSave.promise.then((stored) => {
          storedTitle = stored;
          return stored;
        });
      }
      storedTitle = title;
      return Promise.resolve(title);
    });
    const first = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    first.start();
    await flushPromises();
    const renameA = first.renameSession('session-1', 'Title A');
    await flushPromises();
    first.stop();

    const second = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    second.start();
    await flushPromises();
    const renameB = second.renameSession('session-1', 'Title B');
    await flushPromises();
    expect(saveSessionTitle).toHaveBeenCalledTimes(1);

    firstSave.resolve('Title A');
    await renameA;
    await renameB;
    expect(saveSessionTitle.mock.calls.map((call) => call[1])).toEqual(['Title A', 'Title B']);
    expect(storedTitle).toBe('Title B');
    second.stop();
    vi.unstubAllGlobals();
  });

  it('does not turn a successful PATCH into failure when lock cleanup is denied', async () => {
    vi.stubGlobal('navigator', {});
    const storage = new MemoryStorage();
    const removeItem = vi.spyOn(storage, 'removeItem').mockImplementation((key) => {
      if (key.includes('session-title-lock:openmaic:session-title:')) {
        throw new DOMException('Denied', 'SecurityError');
      }
      MemoryStorage.prototype.removeItem.call(storage, key);
    });
    vi.stubGlobal('localStorage', storage);
    const saveSessionTitle = vi.fn(async (_sessionId: string, title: string | null) => title);
    const runtime = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    runtime.start();
    await flushPromises();

    await expect(runtime.renameSession('session-1', 'Title A')).resolves.toBe('renamed');
    expect(removeItem).toHaveBeenCalled();
    runtime.stop();
    vi.unstubAllGlobals();
  });

  it('aborts a stale remount waiter before it acquires the browser lock', async () => {
    const firstSave = deferred<string | null>();
    const saveSessionTitle = vi
      .fn<(_sessionId: string, title: string | null) => Promise<string | null>>()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValue('Title B');
    const locks = new TestSessionTitleLocks();
    vi.stubGlobal('navigator', { locks });
    const first = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    const stale = new WorkspaceOwnerRuntime(options({ saveSessionTitle }));
    first.start();
    stale.start();
    await flushPromises();
    const renameA = first.renameSession('session-1', 'Title A');
    await flushPromises();
    const renameB = stale.renameSession('session-1', 'Title B');
    await flushPromises();

    stale.stop();
    expect(locks.signals.some((signal) => signal.aborted)).toBe(true);
    firstSave.resolve('Title A');
    await renameA;
    await expect(renameB).resolves.toBe('unchanged');
    expect(saveSessionTitle).toHaveBeenCalledTimes(1);
    first.stop();
    vi.unstubAllGlobals();
  });
});
