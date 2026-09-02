// @vitest-environment jsdom

import { act, createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePlaybackChromeStageProjection } from '@/lib/classroom/playback-chrome-stage-projection';
import { useStageStore } from '@/lib/store/stage';

const firstScene = {
  id: 'scene-1',
  stageId: 'stage-1',
  title: 'First scene',
  order: 0,
  type: 'slide',
  content: { type: 'slide', canvas: { elements: [] } },
  actions: [],
} as const;

describe('Playback chrome StageStore projection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useStageStore.setState({
      mode: 'playback',
      stage: { id: 'stage-1', name: 'Course' },
      scenes: [firstScene],
      currentSceneId: firstScene.id,
      generatingOutlines: [],
      outlines: [],
      failedOutlines: [],
      generationComplete: true,
      toolbarState: 'design',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('ignores unrelated store updates and refreshes the selected scene', async () => {
    const onRender = vi.fn();

    function Probe() {
      const projection = usePlaybackChromeStageProjection();
      return createElement('span', null, projection.currentScene?.title ?? '');
    }

    await act(async () =>
      root.render(createElement(Profiler, { id: 'projection', onRender }, createElement(Probe))),
    );
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('First scene');

    await act(async () => useStageStore.setState({ toolbarState: 'ai' }));
    expect(onRender).toHaveBeenCalledTimes(1);

    await act(async () =>
      useStageStore.setState({
        scenes: [{ ...firstScene, title: 'Updated scene' }],
      }),
    );
    expect(onRender).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('Updated scene');
  });
});
