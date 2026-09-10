import { describe, expect, it } from 'vitest';

import {
  projectBackgroundGenerationSnapshot,
  projectGenerationJobPresentation,
  projectZhiyuGenerationSteps,
} from '@/app/generation-preview/components/zhiyu-generation-state';
import {
  projectGenerationDisplayProgress,
  type GenerationDisplaySceneFact,
  type GenerationDisplayStepFact,
} from '@/lib/server/generation-jobs/display-progress';
import { parseGenerationInput } from '@/lib/server/generation-jobs/contracts';

const generationInput = parseGenerationInput({
  version: 1,
  requirements: { requirement: 'Two-page event replay' },
  review: { mode: 'auto' },
  tts: {
    enabled: true,
    providerId: 'minimax-tts',
    modelId: 'speech-2.8-hd',
    voice: 'female-yujie',
  },
});

const scenes: GenerationDisplaySceneFact[] = [
  {
    outlineId: 'scene_1',
    status: 'actions_ready',
    actions: [{ id: 'speech_1', type: 'speech', text: 'First page' }],
  },
  { outlineId: 'scene_2', status: 'pending', actions: null },
];

function step(
  key: string,
  kind: string,
  outlineId: string,
  status: string,
  errorCode: string | null = null,
): GenerationDisplayStepFact {
  return { key, kind, outlineId, status, errorCode, startedAt: '2026-09-09T00:00:00Z' };
}

describe('real generation event replay through DTO and five-column projection', () => {
  it('keeps a content child event in the fourth column instead of returning to preparing', () => {
    const displayProgress = projectGenerationDisplayProgress({
      phase: 'scene_content',
      status: 'running',
      totalScenes: 2,
      lastErrorCode: null,
      generationInput,
      scenes,
      steps: [
        step('content:scene_1', 'content', 'scene_1', 'succeeded'),
        step('content:scene_2', 'llm', 'scene_2', 'running'),
      ],
    });
    const job = {
      status: 'running',
      phase: 'scene_content',
      readyScenes: 0,
      totalScenes: 2,
      lastErrorCode: null,
      displayProgress,
    };

    expect(displayProgress).toMatchObject({
      phase: 'content',
      content: { completed: 1, total: 2, active: 1 },
      published: { completed: 0, total: 2 },
    });
    expect(projectGenerationJobPresentation({ job })).toMatchObject({
      titleKey: 'generation.statusGeneratingScenes',
      detailValues: { ready: 1, total: 2 },
    });
    expect(projectBackgroundGenerationSnapshot(job)).toEqual({
      canonicalPhase: 'scene-generation',
      stepId: 'slide-content',
      generatedContentCount: 1,
    });
  });

  it('does not complete content when first-page TTS overlaps second-page content', () => {
    const displayProgress = projectGenerationDisplayProgress({
      phase: 'tts',
      status: 'running',
      totalScenes: 2,
      lastErrorCode: null,
      generationInput,
      scenes,
      steps: [
        step('content:scene_1', 'content', 'scene_1', 'succeeded'),
        step('content:scene_2', 'content', 'scene_2', 'running'),
        step('actions:scene_1', 'actions', 'scene_1', 'succeeded'),
        step('tts:scene_1:call:speech_1', 'tts', 'scene_1', 'running'),
      ],
    });
    const columns = projectZhiyuGenerationSteps({
      outlineReady: true,
      agentsReady: true,
      generatedSceneCount: 0,
      totalSceneCount: 2,
      mediaPending: true,
      jobStatus: 'running',
      displayProgress,
    });

    expect(displayProgress).toMatchObject({
      phase: 'tts',
      content: { completed: 1, total: 2, active: 1 },
      actions: { completed: 1, total: 2 },
      speech: { completed: 0, total: null, active: 1 },
      published: { completed: 0, total: 2 },
    });
    expect(columns.find((column) => column.id === 'scenes')).toMatchObject({
      status: 'active',
      detail: '1 / 2',
    });
    expect(columns.find((column) => column.id === 'media')).toMatchObject({
      status: 'active',
      detail: '0 / 2',
    });
  });

  it('retains completed content and locates an unknown TTS result in the fifth column', () => {
    const steps = [
      step('content:scene_1', 'content', 'scene_1', 'succeeded'),
      step('actions:scene_1', 'actions', 'scene_1', 'succeeded'),
      step(
        'tts:scene_1:call:speech_1',
        'tts',
        'scene_1',
        'uncertain',
        'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT',
      ),
    ];
    const displayProgress = projectGenerationDisplayProgress({
      phase: 'failed',
      status: 'needs_attention',
      totalScenes: 2,
      lastErrorCode: 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT',
      generationInput,
      scenes,
      steps,
    });

    expect(displayProgress).toMatchObject({
      phase: 'tts',
      content: { completed: 1, total: 2 },
      failedStep: {
        phase: 'tts',
        outlineId: 'scene_1',
        code: 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT',
      },
    });
    expect(
      projectGenerationJobPresentation({
        job: {
          status: 'needs_attention',
          phase: 'failed',
          readyScenes: 0,
          totalScenes: 2,
          lastErrorCode: 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT',
          outlines: [{ id: 'scene_1' }, { id: 'scene_2' }],
          displayProgress,
        },
      }),
    ).toMatchObject({
      titleKey: 'generation.statusSpeechNeedsAttention',
      detailValues: { page: 1, completed: 1, total: 2 },
      terminal: true,
    });
  });
});
