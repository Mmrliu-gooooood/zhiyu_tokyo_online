// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listener: undefined as
    | ((event: { name: string; status: 'unavailable' | 'changes-lost' | 'recovered' }) => void)
    | undefined,
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
  acknowledge: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    warning: mocks.warning,
    error: mocks.error,
    success: mocks.success,
    dismiss: mocks.dismiss,
  },
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/store/persist-health', () => ({
  subscribeToPersistHealth: (
    listener: (event: {
      name: string;
      status: 'unavailable' | 'changes-lost' | 'recovered';
    }) => void,
  ) => {
    mocks.listener = listener;
    return () => {
      mocks.listener = undefined;
    };
  },
  acknowledgePersistLoss: mocks.acknowledge,
}));

import { StorageHealthNotice } from '@/components/storage-health-notice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('StorageHealthNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(StorageHealthNotice)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('projects truthful degraded, error and recovered events to distinct toast states', () => {
    act(() => mocks.listener?.({ name: 'settings', status: 'unavailable' }));
    expect(mocks.warning).toHaveBeenCalledWith(
      'settings.persistUnavailable',
      expect.objectContaining({
        id: 'persist-unavailable:settings',
        className: 'zhiyu-storage-health zhiyu-storage-health--degraded',
      }),
    );

    act(() => mocks.listener?.({ name: 'settings', status: 'changes-lost' }));
    expect(mocks.error).toHaveBeenCalledWith(
      'settings.persistChangesLost',
      expect.objectContaining({
        id: 'persist-changes-lost:settings',
        className: 'zhiyu-storage-health zhiyu-storage-health--error',
      }),
    );

    act(() => mocks.listener?.({ name: 'settings', status: 'recovered' }));
    expect(mocks.dismiss).toHaveBeenCalledWith('persist-unavailable:settings');
    expect(mocks.success).toHaveBeenCalledWith(
      'settings.persistRecovered',
      expect.objectContaining({
        id: 'persist-recovered:settings',
        className: 'zhiyu-storage-health zhiyu-storage-health--recovered',
      }),
    );
  });
});
