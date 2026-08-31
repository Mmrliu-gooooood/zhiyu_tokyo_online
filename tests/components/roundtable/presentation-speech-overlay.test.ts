// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/avatar-display', () => ({
  AvatarDisplay: ({ alt }: { alt: string }) => createElement('span', null, alt),
}));

import { PresentationBubbleCard } from '@/components/roundtable/presentation-speech-overlay';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('PresentationBubbleCard controls', () => {
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

  it('exposes the card, collapse and playback actions to keyboard users', () => {
    const onClick = vi.fn();
    const onCollapse = vi.fn();
    act(() => {
      root.render(
        createElement(PresentationBubbleCard, {
          bubble: {
            key: 'teacher',
            role: 'teacher',
            side: 'left',
            name: 'Teacher',
            avatar: '/teacher.png',
            text: 'Welcome',
            isLoading: false,
            isTopicPending: false,
          },
          onClick,
          onCollapse,
          buttonState: 'play',
        }),
      );
    });

    const card = container.querySelector<HTMLElement>('[role="button"][tabindex="0"]');
    const collapse = container.querySelector<HTMLButtonElement>(
      'button[aria-label="classroomWorkspace.collapseInteraction"]',
    );
    const play = container.querySelector<HTMLButtonElement>(
      'button[aria-label="classroomWorkspace.play"]',
    );
    expect(card).not.toBeNull();
    expect(collapse).not.toBeNull();
    expect(play).not.toBeNull();

    act(() => card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => collapse?.click());
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
