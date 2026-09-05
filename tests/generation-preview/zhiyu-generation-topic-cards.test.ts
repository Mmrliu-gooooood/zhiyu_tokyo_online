// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZhiyuGenerationTopicCards } from '@/app/generation-preview/components/ZhiyuGenerationTopicCards';

const preferences = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('motion/react', async () => {
  const { createElement } = await import('react');
  return {
    useReducedMotion: () => preferences.reducedMotion,
    motion: {
      div: ({
        initial: _initial,
        animate: _animate,
        transition: _transition,
        ...props
      }: Record<string, unknown>) => createElement('div', props),
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const outlines = Array.from({ length: 10 }, (_, index) => ({
  id: `topic-${index + 1}`,
  title: `Topic ${index + 1}`,
}));

describe('ZhiyuGenerationTopicCards', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    preferences.reducedMotion = false;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const visibleTopics = () =>
    Array.from(container.querySelectorAll('button'))
      .map((button) => button.textContent)
      .filter((title) => title?.startsWith('Topic '));

  it('rotates every five seconds through all groups, including the partial last card, then wraps', () => {
    act(() => root.render(createElement(ZhiyuGenerationTopicCards, { outlines, rotating: true })));
    expect(visibleTopics()).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
    act(() => vi.advanceTimersByTime(4_999));
    expect(visibleTopics()).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
    act(() => vi.advanceTimersByTime(1));
    expect(visibleTopics()).toEqual(['Topic 5', 'Topic 6', 'Topic 7', 'Topic 8']);
    act(() => vi.advanceTimersByTime(5_000));
    expect(visibleTopics()).toEqual(['Topic 9', 'Topic 10']);
    act(() => vi.advanceTimersByTime(5_000));
    expect(visibleTopics()).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
  });

  it('preserves the four-topic outline review and opens it on click without rotating', () => {
    const onExpand = vi.fn();
    act(() =>
      root.render(
        createElement(ZhiyuGenerationTopicCards, { outlines, rotating: false, onExpand }),
      ),
    );
    expect(visibleTopics()).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
    act(() => container.querySelector('button')?.click());
    expect(onExpand).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(15_000));
    expect(visibleTopics()).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses and resumes automatic changes while retaining manual access to every card', () => {
    act(() => root.render(createElement(ZhiyuGenerationTopicCards, { outlines, rotating: true })));
    const pause = container.querySelector<HTMLButtonElement>('[aria-label="proactiveCard.pause"]');
    expect(pause).not.toBeNull();
    act(() => pause?.click());
    act(() => vi.advanceTimersByTime(10_000));
    expect(visibleTopics()).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
    const pages = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="generation.outlineEditorTitle"] button',
    );
    expect(pages).toHaveLength(3);
    act(() => pages[2].click());
    expect(visibleTopics()).toEqual(['Topic 9', 'Topic 10']);
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="proactiveCard.resume"]')?.click(),
    );
    act(() => vi.advanceTimersByTime(5_000));
    expect(visibleTopics()).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
  });

  it('starts paused for reduced motion and permits deliberate paging', () => {
    preferences.reducedMotion = true;
    act(() => root.render(createElement(ZhiyuGenerationTopicCards, { outlines, rotating: true })));
    act(() => vi.advanceTimersByTime(10_000));
    expect(visibleTopics()).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
    expect(vi.getTimerCount()).toBe(0);
    const nextPage = container.querySelector<HTMLButtonElement>('[aria-label="2 / 3"]');
    act(() => nextPage?.click());
    expect(visibleTopics()).toEqual(['Topic 5', 'Topic 6', 'Topic 7', 'Topic 8']);
  });

  it('clamps changed outlines immediately and keeps a single-page or empty preview idle', () => {
    act(() => root.render(createElement(ZhiyuGenerationTopicCards, { outlines, rotating: true })));
    act(() => vi.advanceTimersByTime(10_000));
    expect(visibleTopics()).toEqual(['Topic 9', 'Topic 10']);
    act(() =>
      root.render(
        createElement(ZhiyuGenerationTopicCards, {
          outlines: outlines.slice(0, 6),
          rotating: true,
        }),
      ),
    );
    expect(visibleTopics()).toEqual(['Topic 5', 'Topic 6']);
    act(() => vi.advanceTimersByTime(5_000));
    expect(visibleTopics()).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
    act(() =>
      root.render(
        createElement(ZhiyuGenerationTopicCards, {
          outlines: outlines.slice(0, 3),
          rotating: true,
        }),
      ),
    );
    expect(visibleTopics()).toEqual(['Topic 1', 'Topic 2', 'Topic 3']);
    expect(vi.getTimerCount()).toBe(0);
    act(() =>
      root.render(createElement(ZhiyuGenerationTopicCards, { outlines: [], rotating: true })),
    );
    expect(visibleTopics()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('owns only one timer in Strict Mode and releases it when rotation stops or the component unmounts', () => {
    const render = (rotating: boolean) =>
      act(() =>
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(ZhiyuGenerationTopicCards, { outlines, rotating }),
          ),
        ),
      );
    render(true);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(5_000));
    expect(visibleTopics()).toEqual(['Topic 5', 'Topic 6', 'Topic 7', 'Topic 8']);
    render(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(visibleTopics()).toEqual(['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
    render(true);
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.textContent).toBe('');
  });

  it('keeps the rotation cadence across streamed title updates and new array references', () => {
    act(() => root.render(createElement(ZhiyuGenerationTopicCards, { outlines, rotating: true })));
    act(() => vi.advanceTimersByTime(4_000));
    act(() =>
      root.render(
        createElement(ZhiyuGenerationTopicCards, {
          outlines: outlines.map((outline) => ({ ...outline, title: `${outline.title} updated` })),
          rotating: true,
        }),
      ),
    );
    expect(visibleTopics()).toEqual([
      'Topic 1 updated',
      'Topic 2 updated',
      'Topic 3 updated',
      'Topic 4 updated',
    ]);
    act(() => vi.advanceTimersByTime(1_000));
    expect(visibleTopics()).toEqual([
      'Topic 5 updated',
      'Topic 6 updated',
      'Topic 7 updated',
      'Topic 8 updated',
    ]);
    expect(vi.getTimerCount()).toBe(1);
  });
});
