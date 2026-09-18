export type LearningCheckReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: 'no-course-content' | 'server-generation-incomplete' | 'local-generation-incomplete';
    };

export interface LearningReadinessInput {
  generationComplete: boolean;
  generationStatus: 'idle' | 'generating' | 'paused' | 'completed' | 'error';
  outlineProducer: string | null;
  scenes: readonly { id: string; order: number }[];
  outlines: readonly { id: string; order: number }[];
  generatingOutlines: readonly unknown[];
  failedOutlines: readonly unknown[];
}

export function getLearningCheckReadiness(input: LearningReadinessInput): LearningCheckReadiness {
  if (input.scenes.length === 0) return { ready: false, reason: 'no-course-content' };
  if (input.generationComplete) return { ready: true };
  if (input.outlineProducer === 'server-job') {
    return { ready: false, reason: 'server-generation-incomplete' };
  }
  const activeOrUncertain =
    input.generationStatus === 'generating' ||
    input.generationStatus === 'paused' ||
    input.generationStatus === 'error' ||
    input.generatingOutlines.length > 0 ||
    input.failedOutlines.length > 0;
  const everyOutlineMaterialized =
    input.outlines.length > 0 &&
    input.outlines.every((outline) => input.scenes.some((scene) => scene.order === outline.order));
  if (input.outlines.length > 0 && (!everyOutlineMaterialized || activeOrUncertain)) {
    return { ready: false, reason: 'local-generation-incomplete' };
  }
  if (activeOrUncertain) return { ready: false, reason: 'local-generation-incomplete' };
  return { ready: true };
}
