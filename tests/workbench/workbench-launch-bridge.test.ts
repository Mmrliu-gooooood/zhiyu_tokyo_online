// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  createSession: vi.fn(),
  params: { get: (key: string) => (key === 'prompt' ? 'Build a lesson' : null) },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.params,
}));

vi.mock('@/lib/workbench/session-store', () => ({
  createWorkbenchSession: mocks.createSession,
  WorkbenchApiError: class WorkbenchApiError extends Error {
    status = 500;
  },
}));

vi.mock('@/lib/workbench/workspace-panes', () => ({
  workspaceHref: ({ sessionId }: { sessionId: string }) => `/workspace?session=${sessionId}`,
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/brand/ZhiyuLockup', () => ({
  ZhiyuLockup: () => createElement('div', null, '智域'),
}));

vi.mock('@/components/brand/ZhiyuRouteLoading', () => ({
  ZhiyuRouteLoading: ({ testId }: { testId: string }) =>
    createElement('div', { 'data-testid': testId, role: 'status' }),
}));

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

import { WorkbenchLaunchBridge } from '@/app/workbench/new/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => act(async () => Promise.resolve());

describe('WorkbenchLaunchBridge state contract', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.replace.mockReset();
    mocks.createSession.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('forwards a legacy launch to the canonical workspace route', async () => {
    mocks.createSession.mockResolvedValue({ id: 'session-1', courseRefsAccepted: true });
    act(() => root.render(createElement(WorkbenchLaunchBridge)));
    expect(container.querySelector('[data-testid="workbench-bridge-forwarding"]')).not.toBeNull();

    await flush();
    expect(mocks.createSession).toHaveBeenCalledWith({ prompt: 'Build a lesson' });
    expect(mocks.replace).toHaveBeenCalledWith('/workspace?session=session-1');
  });

  it('renders an alert and retries the same real launch after failure', async () => {
    mocks.createSession
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ id: 'session-2', courseRefsAccepted: true });
    act(() => root.render(createElement(WorkbenchLaunchBridge)));
    await flush();

    expect(container.querySelector('[data-testid="workbench-bridge-error"]')?.textContent).toContain(
      'offline',
    );
    act(() => {
      container
        .querySelector('[data-testid="workbench-bridge-retry"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="workbench-bridge-forwarding"]')).not.toBeNull();

    await flush();
    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(mocks.replace).toHaveBeenCalledWith('/workspace?session=session-2');
  });
});
