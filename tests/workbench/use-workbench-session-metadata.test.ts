// @vitest-environment jsdom

import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { useWorkbenchStream } from '@/lib/workbench/use-workbench-session';

class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  readonly listeners = new Map<string, Set<EventListener>>();
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
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
    this.readyState = 2;
  }
  emit(type: string, data: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function jsonResponse(value: unknown): Response {
  return { ok: true, json: async () => value } as Response;
}

function Harness({
  sessionId,
  seedTitle,
}: {
  readonly sessionId: string;
  readonly seedTitle?: { readonly title: string | null };
}) {
  const attach = useWorkbenchStore((state) => state.attach);
  const setSessionTitle = useWorkbenchStore((state) => state.setSessionTitle);
  useLayoutEffect(() => {
    attach(sessionId, null);
    if (seedTitle) setSessionTitle(seedTitle.title);
  }, [attach, seedTitle, sessionId, setSessionTitle]);
  useWorkbenchStream(sessionId);
  return null;
}

describe('session detail bootstrap attachment lifetime', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    FakeEventSource.instances = [];
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useWorkbenchStore.getState().detach();
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('replays unapplied durable events after hide, resumes from the applied cursor, and cleans up reconnect/unmount', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ prompt: 'task' })));
    await act(async () => root.render(createElement(Harness, { sessionId: 'session-a' })));
    const first = FakeEventSource.instances[0]!;
    // Buffered replay is not yet in the store: hiding must resume before it, not skip it.
    const start = { id: 1, type: 'session_start', attempt: 1, data: { prompt: 'durable prompt' } };
    await act(async () => first.emit('session_start', start));
    expect(useWorkbenchStore.getState().lastEventId).toBe(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(first.readyState).toBe(2);
    expect([...first.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(first.onerror).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toContain('lastEventId=0');
    await act(async () => {
      second.emit('session_start', start);
      second.emit('caught_up');
    });
    expect(useWorkbenchStore.getState()).toMatchObject({
      lastEventId: 1,
      attached: true,
      status: 'running',
    });
    await act(async () => {
      second.readyState = 0;
      second.onerror?.(new Event('error'));
    });
    expect(useWorkbenchStore.getState().attached).toBe(false);
    await act(async () => second.emit('caught_up'));
    expect(useWorkbenchStore.getState().attached).toBe(true);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    const third = FakeEventSource.instances[2]!;
    expect(third.url).toContain('lastEventId=1');
    await act(async () => {
      third.emit('session_start', start);
      third.emit('caught_up');
    });
    expect(useWorkbenchStore.getState().chat.filter((node) => node.kind === 'user')).toHaveLength(
      1,
    );
    await act(async () => root.render(null));
    expect(third.readyState).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('ignores an old A detail response after navigating A to B to A', async () => {
    const firstA = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(firstA.promise)
      .mockResolvedValueOnce(
        jsonResponse({
          prompt: 'B prompt',
          title: 'B title',
          status: 'running',
          stageId: 'stage-b',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          prompt: 'Current A prompt',
          title: 'Current A title',
          status: 'succeeded',
          stageId: 'stage-a-current',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => root.render(createElement(Harness, { sessionId: 'session-a' })));
    await act(async () => root.render(createElement(Harness, { sessionId: 'session-b' })));
    await act(async () => root.render(createElement(Harness, { sessionId: 'session-a' })));

    await act(async () => {
      firstA.resolve(
        jsonResponse({
          prompt: 'Stale A prompt',
          title: 'Stale A title',
          status: 'failed',
          stageId: 'stage-a-stale',
        }),
      );
      await firstA.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useWorkbenchStore.getState()).toMatchObject({
      sessionId: 'session-a',
      sessionPrompt: 'Current A prompt',
      sessionTitle: 'Current A title',
      status: 'succeeded',
      stageId: 'stage-a-current',
    });
  });

  it.each([
    { name: 'rename', title: 'Pending title' },
    { name: 'clear', title: null },
  ])('keeps a pending $name while bootstrapping other metadata', async ({ title }) => {
    const detail = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValueOnce(detail.promise));

    await act(async () =>
      root.render(createElement(Harness, { sessionId: 'session-a', seedTitle: { title } })),
    );
    await act(async () => {
      detail.resolve(
        jsonResponse({
          prompt: 'Current prompt',
          title: 'Old title',
          status: 'running',
          stageId: 'stage-a',
        }),
      );
      await detail.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useWorkbenchStore.getState()).toMatchObject({
      sessionPrompt: 'Current prompt',
      sessionTitle: title,
      status: 'running',
      stageId: 'stage-a',
    });
  });
});
