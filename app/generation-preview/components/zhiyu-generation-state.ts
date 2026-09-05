import type { GenerationCanonicalPhase } from '../generation-session-runtime';

export type ZhiyuGenerationStatus = 'done' | 'active' | 'pending' | 'error';

export type ZhiyuGenerationStep = {
  id: 'goal' | 'outline' | 'agents' | 'scenes' | 'media';
  labelKey: string;
  status: ZhiyuGenerationStatus;
  detail?: string;
};

type ZhiyuGenerationErrorStage = 'outline' | 'agents' | 'scenes' | 'media';

export function projectZhiyuGenerationSteps(input: {
  outlineReady: boolean;
  agentsReady: boolean;
  generatedSceneCount: number;
  totalSceneCount: number;
  scenesStarted?: boolean;
  phase?: GenerationCanonicalPhase;
  mediaPending: boolean;
  errorStage?: ZhiyuGenerationErrorStage | null;
}): readonly ZhiyuGenerationStep[] {
  const generatedSceneCount = Math.max(0, input.generatedSceneCount);
  const totalSceneCount = Math.max(0, input.totalSceneCount);
  const scenesComplete = totalSceneCount > 0 && generatedSceneCount >= totalSceneCount;
  // Foreground generation hands off after its first scene. The remaining pages
  // are generated in Classroom, so publication counts cannot identify this phase.
  const contentReady = input.phase
    ? input.phase === 'media-actions' || input.phase === 'completed' || input.errorStage === 'media'
    : scenesComplete;

  const statusFor = (
    stage: ZhiyuGenerationErrorStage,
    done: boolean,
    active: boolean,
  ): ZhiyuGenerationStatus => {
    if (input.errorStage === stage) return 'error';
    if (done) return 'done';
    if (active) return 'active';
    return 'pending';
  };

  return [
    {
      id: 'goal',
      labelKey: 'generation.learningGoal',
      status: 'done',
    },
    {
      id: 'outline',
      labelKey: 'generation.generatingOutlines',
      status: statusFor('outline', input.outlineReady, !input.outlineReady),
    },
    {
      id: 'agents',
      labelKey: 'generation.agentGeneration',
      status: statusFor('agents', input.agentsReady, input.outlineReady),
    },
    {
      id: 'scenes',
      labelKey: 'generation.generatingSlideContent',
      status: statusFor('scenes', contentReady, input.agentsReady && (input.scenesStarted ?? true)),
      ...(totalSceneCount > 0 && !contentReady
        ? { detail: `${Math.min(generatedSceneCount, totalSceneCount)} / ${totalSceneCount}` }
        : {}),
    },
    {
      id: 'media',
      labelKey: 'generation.generatingActions',
      status: statusFor('media', contentReady && !input.mediaPending, contentReady),
    },
  ];
}
