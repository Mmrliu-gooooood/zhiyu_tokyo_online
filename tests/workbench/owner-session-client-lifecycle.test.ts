// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  constructor() {
    CountingEventSource.created += 1;
    CountingEventSource.live += 1;
  }

  addEventListener(_type: string, _listener: EventListener): void {}

  removeEventListener(_type: string, _listener: EventListener): void {}

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('OwnerSessionClient lifecycle baseline', () => {
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
