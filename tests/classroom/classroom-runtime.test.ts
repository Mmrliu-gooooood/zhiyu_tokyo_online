import { describe, expect, it, vi } from 'vitest';

import {
  createClassroomLiveRuntime,
  createInitialClassroomRuntimeState,
  reduceClassroomRuntime,
} from '@/lib/classroom/classroom-runtime';

describe('Classroom runtime transitions', () => {
  it('keeps narrow scene and interaction drawers mutually exclusive', () => {
    const narrow = reduceClassroomRuntime(createInitialClassroomRuntimeState(), {
      type: 'viewport.changed',
      compact: true,
      narrow: true,
    });
    const interactionOpen = reduceClassroomRuntime(narrow, {
      type: 'interaction.presentationChanged',
      collapsed: false,
    });
    const sceneOpen = reduceClassroomRuntime(interactionOpen, {
      type: 'sceneRail.presentationChanged',
      collapsed: false,
    });

    expect(interactionOpen).toMatchObject({
      compactInteractionOpen: true,
      narrowSceneRailOpen: false,
    });
    expect(sceneOpen).toMatchObject({
      compactInteractionOpen: false,
      narrowSceneRailOpen: true,
    });
  });

  it('defines presentation, discussion, scene-switch, and idempotent cleanup transitions', () => {
    const active = reduceClassroomRuntime(
      {
        ...createInitialClassroomRuntimeState(),
        compactViewport: true,
        narrowViewport: true,
        compactInteractionOpen: true,
        isDiscussionPaused: true,
      },
      { type: 'presentation.changed', active: true },
    );
    const sceneSwitched = reduceClassroomRuntime(active, {
      type: 'scene.switched',
    });
    const cleaned = reduceClassroomRuntime(sceneSwitched, {
      type: 'session.cleaned',
    });

    expect(active).toMatchObject({
      isPresenting: true,
      compactInteractionOpen: false,
      narrowSceneRailOpen: false,
      isDiscussionPaused: true,
    });
    expect(sceneSwitched).toMatchObject({
      isPresenting: true,
      isDiscussionPaused: false,
    });
    expect(cleaned).toEqual({
      ...createInitialClassroomRuntimeState(),
      compactViewport: true,
      narrowViewport: true,
    });
    expect(reduceClassroomRuntime(cleaned, { type: 'session.cleaned' })).toBe(cleaned);
  });

  it('isolates mount-scoped runtimes and rejects stale epochs after idempotent cleanup', () => {
    const first = createClassroomLiveRuntime();
    const second = createClassroomLiveRuntime();
    const notify = vi.fn();
    const unsubscribe = first.subscribe(notify);
    const staleScene = first.captureEpoch();

    first.setLiveSpeech('first mount');
    first.advanceScene();

    expect(second.getState().liveSpeech).toBeNull();
    expect(first.isCurrentEpoch(staleScene)).toBe(false);
    expect(first.getState().liveSpeech).toBeNull();

    const staleSession = first.captureEpoch();
    first.advanceSession();
    expect(first.isCurrentEpoch(staleSession)).toBe(false);

    first.dispose();
    first.dispose();
    unsubscribe();
    unsubscribe();
    first.setThinkingState({ stage: 'stale' });

    expect(first.getState().thinkingState).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
