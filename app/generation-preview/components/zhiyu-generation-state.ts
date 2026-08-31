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
  mediaPending: boolean;
  errorStage?: ZhiyuGenerationErrorStage | null;
}): readonly ZhiyuGenerationStep[] {
  const generatedSceneCount = Math.max(0, input.generatedSceneCount);
  const totalSceneCount = Math.max(0, input.totalSceneCount);
  const scenesComplete = totalSceneCount > 0 && generatedSceneCount >= totalSceneCount;

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
      status: statusFor(
        'scenes',
        scenesComplete,
        input.agentsReady && (input.scenesStarted ?? true),
      ),
      ...(totalSceneCount > 0
        ? { detail: `${Math.min(generatedSceneCount, totalSceneCount)} / ${totalSceneCount}` }
        : {}),
    },
    {
      id: 'media',
      labelKey: 'generation.generatingActions',
      status: statusFor('media', scenesComplete && !input.mediaPending, scenesComplete),
    },
  ];
}
