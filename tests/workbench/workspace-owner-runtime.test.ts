import { describe, expect, it, vi } from 'vitest';
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
});
