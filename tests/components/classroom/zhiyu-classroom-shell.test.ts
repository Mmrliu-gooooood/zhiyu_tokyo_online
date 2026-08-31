// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZhiyuClassroomShell } from '@/components/classroom/ZhiyuClassroomShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ZhiyuClassroomShell responsive drawers', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderShell = (overrides: Record<string, unknown> = {}) => {
    const onSceneRailDismiss = vi.fn();
    const onInteractionDismiss = vi.fn();
    act(() => {
      root.render(
        createElement(ZhiyuClassroomShell, {
          header: createElement('button', { type: 'button' }, 'header action'),
          sceneRail: createElement('button', { type: 'button' }, 'scene action'),
          stage: createElement('button', { type: 'button' }, 'stage action'),
          interaction: createElement('button', { type: 'button' }, 'chat action'),
          playbackBar: createElement('button', { type: 'button' }, 'playback action'),
          sceneRailCollapsed: false,
          interactionCollapsed: true,
          sceneRailDrawer: true,
          interactionDrawer: true,
          onSceneRailDismiss,
          onInteractionDismiss,
          sceneRailDismissLabel: 'Close scenes',
          interactionDismissLabel: 'Close interaction',
          ...overrides,
        }),
      );
    });
    return { onSceneRailDismiss, onInteractionDismiss };
  };

  it('makes only the open compact panel modal, traps focus, inerts the stage and dismisses on Escape', () => {
    const { onSceneRailDismiss } = renderShell();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    const stage = container.querySelector<HTMLElement>('[data-testid="zhiyu-learning-stage"]');
    const otherPanel = container.querySelector<HTMLElement>('[data-presentation="drawer"]:last-of-type');

    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-label')).toBe('Close scenes');
    expect(stage?.hasAttribute('inert')).toBe(true);
    expect(otherPanel?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('button')?.closest('[inert]')).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'playback action',
      )?.closest('[inert]'),
    ).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('scene action');

    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement?.textContent).toBe('scene action');

    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onSceneRailDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not expose a collapsed drawer as a dialog or intercept desktop Escape', () => {
    renderShell({
      sceneRailCollapsed: true,
      sceneRailDrawer: true,
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const desktop = renderShell({ sceneRailDrawer: false, sceneRailCollapsed: false });
    act(() => {
      container
        .querySelector('[data-testid="zhiyu-classroom-shell"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(desktop.onSceneRailDismiss).not.toHaveBeenCalled();
  });

  it('returns focus to the opener after a responsive drawer closes', () => {
    const opener = document.createElement('button');
    opener.textContent = 'open scenes';
    document.body.append(opener);
    renderShell({ sceneRailCollapsed: true });
    opener.focus();

    renderShell();
    expect(document.activeElement?.textContent).toBe('scene action');
    renderShell({ sceneRailCollapsed: true });
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
