import { describe, expect, it } from 'vitest';

import { isGuidedLearningContextCurrent } from '@/lib/learning/guided-current';
import type { GuidedLearningContext } from '@/lib/learning/guided-contracts';
import type { Scene, Stage } from '@/lib/types/stage';

const scene = {
  id: 'scene-2',
  stageId: 'stage-1',
  order: 0,
  title: 'Energy',
  type: 'slide',
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-2',
      elements: [
        { id: 'text-1', type: 'text', content: 'Plants store captured energy in glucose.' },
      ],
    },
  },
} as unknown as Scene;

const context = {
  schemaVersion: 1,
  requestId: 'request-1',
  chatSessionId: 'session-1',
  stageId: 'stage-1',
  contentRevision: 'course-revision-1',
  scopedRevision: 'sha256:0b5384130fa848394382bcecc8f6122514f9f9be2762b9d0c92c9344b8672215',
  phase: 'explain',
  source: { kind: 'scene', sceneId: 'scene-2' },
  evidence: [{ ref: 'scene:scene-2', content: 'Plants store captured energy in glucose.' }],
} satisfies GuidedLearningContext;

describe('guided current-source guard', () => {
  it('accepts the bound scene and rejects the same id after authored content changes', async () => {
    const current = {
      stage: { id: 'stage-1', name: 'Physics' } as Stage,
      scenes: [scene],
      currentSceneId: 'scene-2',
    };
    expect(await isGuidedLearningContextCurrent(context, current)).toBe(true);

    const changed = structuredClone(scene);
    if (changed.content.type === 'slide') {
      (changed.content.canvas.elements[0] as { content: string }).content =
        'Plants now store energy in a revised molecule.';
    }
    expect(await isGuidedLearningContextCurrent(context, { ...current, scenes: [changed] })).toBe(
      false,
    );
  });
});
