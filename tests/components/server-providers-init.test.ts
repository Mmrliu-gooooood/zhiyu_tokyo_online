// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchProviders: vi.fn(async () => {}),
  hydrationListeners: new Set<() => void>(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: { fetchServerProviders: typeof mocks.fetchProviders }) => unknown) =>
      selector({ fetchServerProviders: mocks.fetchProviders }),
    {
      persist: {
        onFinishHydration: (listener: () => void) => {
          mocks.hydrationListeners.add(listener);
          return () => mocks.hydrationListeners.delete(listener);
        },
      },
    },
  ),
}));

import { ServerProvidersInit } from '@/components/server-providers-init';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('server provider initialization across persisted settings hydration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.fetchProviders.mockClear();
    mocks.hydrationListeners.clear();
    container = document.createElement('div');
    root = createRoot(container);
    act(() => root.render(createElement(ServerProvidersInit)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('refreshes the catalog when late hydration restores an obsolete model revision', () => {
    expect(mocks.fetchProviders).toHaveBeenCalledTimes(1);

    act(() => mocks.hydrationListeners.forEach((listener) => listener()));

    // Persisted settings can overwrite the first fetch or invalidate it while
    // it is in flight. A fresh fetch must follow every successful hydration.
    expect(mocks.fetchProviders).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes the hydration listener on unmount', () => {
    expect(mocks.hydrationListeners.size).toBe(1);
    act(() => root.unmount());
    root = createRoot(container);
    expect(mocks.hydrationListeners.size).toBe(0);
  });
});
