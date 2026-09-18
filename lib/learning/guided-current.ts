import type { Scene } from '@/lib/types/stage';
import type { GuidedLearningContext } from './guided-contracts';
import { createLearningContentSnapshot } from './content-snapshot';

export interface GuidedCurrentSourceState {
  stage: { id: string; name: string } | null | undefined;
  scenes: readonly Scene[];
  currentSceneId: string | null | undefined;
}

/** Recompute scene evidence from the current authored scene instead of trusting a supplied digest. */
export async function isGuidedLearningContextCurrent(
  context: GuidedLearningContext,
  current: GuidedCurrentSourceState,
): Promise<boolean> {
  if (!current.stage || current.stage.id !== context.stageId) return false;
  if (context.source.kind !== 'scene') return true;
  const sourceSceneId = context.source.sceneId;
  if (current.currentSceneId !== sourceSceneId) return false;
  const scene = current.scenes.find((candidate) => candidate.id === sourceSceneId);
  if (!scene) return false;
  try {
    const snapshot = await createLearningContentSnapshot({
      courseTitle: current.stage.name,
      scenes: [scene],
    });
    return snapshot.contentRevision === context.scopedRevision;
  } catch {
    return false;
  }
}
