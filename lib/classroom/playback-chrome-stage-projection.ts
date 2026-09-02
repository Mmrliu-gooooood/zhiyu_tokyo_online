'use client';

import { useShallow } from 'zustand/react/shallow';

import { useStageStore } from '@/lib/store';

/**
 * The complete StageStore surface consumed by PlaybackChromeRoot.
 * Shallow equality keeps unrelated store writes outside the playback chrome.
 */
export function usePlaybackChromeStageProjection() {
  return useStageStore(
    useShallow((state) => ({
      mode: state.mode,
      stage: state.stage,
      scenes: state.scenes,
      currentSceneId: state.currentSceneId,
      currentScene: state.scenes.find((scene) => scene.id === state.currentSceneId) ?? null,
      setCurrentSceneId: state.setCurrentSceneId,
      generatingOutlines: state.generatingOutlines,
      outlines: state.outlines,
      failedOutlines: state.failedOutlines,
      generationComplete: state.generationComplete,
    })),
  );
}
