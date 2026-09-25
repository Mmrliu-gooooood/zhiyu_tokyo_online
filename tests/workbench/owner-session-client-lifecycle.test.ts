// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerSessionClient, type OwnerEventSource } from '@/lib/workbench/owner-session-client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class CountingEventSource implements OwnerEventSource {
  static created = 0;
  static closed = 0;
  static live = 0;

  readyState = 1;
  onerror: ((event: Event) => void) | null = null;
  private isClosed = false;
  readonly listeners = new Map<string, Set<EventListener>>();

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

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.readyState = 2;
    CountingEventSource.closed += 1;
    CountingEventSource.live -= 1;
  }
}

function OwnerSessionLifecycleHarness() {
  useEffect(() => {
    const client = new OwnerSessionClient({
      fetchSessions: async () => [],
      createEventSource: () => new CountingEventSource(),
      onSessions: () => undefined,
      onState: () => undefined,
    });
    client.start();
    return () => client.stop();
  }, []);

  return null;
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('OwnerSessionClient lifecycle baseline', () => {
  it('releases hidden streams/timers, resumes the exact decimal cursor and retires stale snapshots', async () => {
    vi.useFakeTimers();
    const stale = deferred<[]>();
    const fetchSessions = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue([]);
    const sources: CountingEventSource[] = [];
    const urls: string[] = [];
    const onSessions = vi.fn();
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: (url) => {
        urls.push(url);
        const source = new CountingEventSource();
        sources.push(source);
        return source;
      },
      onSessions,
      onState: vi.fn(),
    });
    client.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    sources[0]!.emit('session_title', {
      id: '9007199254740993',
      type: 'session_title',
      sessionId: 's1',
      title: 'new',
      ts: 100,
    });
    expect(fetchSessions).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sources[0]!.readyState).toBe(2);
    expect([...sources[0]!.listeners.values()].every((listeners) => listeners.size === 0)).toBe(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
    client.requestFullFetch();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetchSessions).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(urls[1]).toBe('/api/agent/owner-events?lastEventId=9007199254740993');
    expect(fetchSessions).toHaveBeenCalledTimes(3);
    const beforeStale = onSessions.mock.calls.length;
    stale.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(onSessions).toHaveBeenCalledTimes(beforeStale);
    sources[1]!.emit('owner_moved', { type: 'owner_moved' });
    expect(sources[1]!.readyState).toBe(2);
    expect(urls[2]).toBe('/api/agent/owner-events');
    client.stop();
    expect(sources[2]!.readyState).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sources).toHaveLength(3);
  });

  it('does not open or fetch while starting hidden', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const fetchSessions = vi.fn(async () => []);
    const createEventSource = vi.fn(() => new CountingEventSource());
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource,
      onSessions: vi.fn(),
      onState: vi.fn(),
    });
    client.start();
    expect(createEventSource).not.toHaveBeenCalled();
    expect(fetchSessions).not.toHaveBeenCalled();
    client.stop();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(createEventSource).not.toHaveBeenCalled();
  });

  it('starts a fresh fetch immediately after stop/start and ignores the retired fetch', async () => {
    const first = deferred<[]>();
    const second = deferred<[]>();
    const fetchSessions = vi
      .fn<() => Promise<[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onSessions = vi.fn();
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: () => new CountingEventSource(),
      onSessions,
      onState: vi.fn(),
    });

    client.start();
    expect(fetchSessions).toHaveBeenCalledTimes(1);
    client.stop();
    client.start();
    expect(fetchSessions).toHaveBeenCalledTimes(2);

    second.resolve([]);
    await second.promise;
    await Promise.resolve();
    expect(onSessions).toHaveBeenCalledTimes(1);

    first.resolve([]);
    await first.promise;
    await Promise.resolve();
    expect(onSessions).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('releases EventSource, health interval, and reconcile timeout across 20 mounts', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    CountingEventSource.created = 0;
    CountingEventSource.closed = 0;
    CountingEventSource.live = 0;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const timerBaseline = vi.getTimerCount();
    const activeTimerDeltas: number[] = [];
    const postUnmountTimerDeltas: number[] = [];
    let lifecycleRoot: Root | null = null;
    let lifecycleContainer: HTMLDivElement | null = null;

    try {
      for (let cycle = 0; cycle < 20; cycle += 1) {
        lifecycleContainer = document.createElement('div');
        document.body.appendChild(lifecycleContainer);
        const cycleRoot = createRoot(lifecycleContainer);
        lifecycleRoot = cycleRoot;
        await act(async () => {
          cycleRoot.render(createElement(OwnerSessionLifecycleHarness));
          await Promise.resolve();
          await Promise.resolve();
        });
        activeTimerDeltas.push(vi.getTimerCount() - timerBaseline);

        act(() => cycleRoot.unmount());
        lifecycleRoot = null;
        lifecycleContainer.remove();
        lifecycleContainer = null;
        postUnmountTimerDeltas.push(vi.getTimerCount() - timerBaseline);
      }

      expect(activeTimerDeltas).toEqual(Array(20).fill(2));
      expect(postUnmountTimerDeltas).toEqual(Array(20).fill(0));
      expect(setTimeoutSpy).toHaveBeenCalledTimes(20);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(20);
      expect(setIntervalSpy).toHaveBeenCalledTimes(20);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(20);
      expect({
        created: CountingEventSource.created,
        closed: CountingEventSource.closed,
        live: CountingEventSource.live,
      }).toEqual({ created: 20, closed: 20, live: 0 });
    } finally {
      if (lifecycleRoot) act(() => lifecycleRoot?.unmount());
      lifecycleContainer?.remove();
      vi.clearAllTimers();
    }
  });
});
