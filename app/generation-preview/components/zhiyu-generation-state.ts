import type { GenerationCanonicalPhase } from '../generation-session-runtime';

export type ZhiyuGenerationStatus = 'done' | 'active' | 'pending' | 'error';

export type ZhiyuGenerationStep = {
  id: 'goal' | 'outline' | 'agents' | 'scenes' | 'media';
  labelKey: string;
  status: ZhiyuGenerationStatus;
  detail?: string;
};

export type GenerationJobPresentation = {
  titleKey: string;
  detailKey: string;
  detailValues?: Record<string, number>;
  terminal: boolean;
};

export function projectGenerationJobPresentation(input: {
  job: {
    status: string;
    phase: string;
    queueReason?: 'owner_limit' | 'site_limit' | 'queued' | 'service_unavailable' | null;
    retryAt?: string | null;
    readyScenes: number;
    totalScenes: number;
    lastErrorCode: string | null;
    activeSteps?: Array<{ kind: string }>;
  } | null;
  observationError?: Error | null;
  cancelling?: boolean;
  cancelError?: Error | null;
}): GenerationJobPresentation {
  if (input.job?.status === 'failed' && input.job.lastErrorCode === 'QUEUE_WAIT_EXPIRED') {
    return {
      titleKey: 'generation.statusQueueExpired',
      detailKey: 'generation.statusQueueExpiredDesc',
      terminal: true,
    };
  }
  if (input.job?.status === 'failed' && input.job.lastErrorCode === 'OUTLINE_REVIEW_EXPIRED') {
    return {
      titleKey: 'generation.statusOutlineReviewExpired',
      detailKey: 'generation.statusOutlineReviewExpiredDesc',
      terminal: true,
    };
  }
  if (input.job?.status === 'succeeded') {
    return {
      titleKey: 'generation.statusCourseComplete',
      detailKey: 'generation.statusCourseCompleteDesc',
      terminal: true,
    };
  }
  if (input.job?.status === 'failed') {
    return {
      titleKey: 'generation.statusGenerationFailed',
      detailKey: 'generation.statusGenerationFailedDesc',
      terminal: true,
    };
  }
  if (input.job?.status === 'cancelled') {
    return {
      titleKey: 'generation.statusGenerationCancelled',
      detailKey: 'generation.statusGenerationCancelledDesc',
      terminal: true,
    };
  }
  if (input.job?.status === 'needs_attention') {
    return {
      titleKey: 'generation.statusNeedsAttention',
      detailKey: 'generation.statusNeedsAttentionDesc',
      terminal: true,
    };
  }
  if (input.cancelling) {
    return {
      titleKey: 'generation.statusCancelling',
      detailKey: 'generation.statusCancellingDesc',
      terminal: false,
    };
  }
  if (input.cancelError) {
    return {
      titleKey: 'generation.statusCancelFailed',
      detailKey: 'generation.statusCancelFailedDesc',
      terminal: false,
    };
  }
  const observationCode = input.observationError
    ? ((input.observationError as Error & { code?: string }).code ?? input.observationError.message)
    : null;
  if (
    observationCode &&
    ['GENERATION_NOT_READY', 'GENERATION_DATABASE_UNAVAILABLE', 'GENERATION_UNAVAILABLE'].includes(
      observationCode,
    )
  ) {
    return {
      titleKey: 'generation.statusServiceUnavailable',
      detailKey: 'generation.statusServiceUnavailableDesc',
      terminal: false,
    };
  }
  if (input.observationError) {
    return {
      titleKey: 'generation.statusReconnecting',
      detailKey: 'generation.statusReconnectingDesc',
      terminal: false,
    };
  }
  if (
    input.job &&
    (input.job.queueReason === 'service_unavailable' ||
      ['service_unavailable', 'worker_unavailable', 'database_unavailable'].includes(
        input.job.phase.toLowerCase(),
      ) ||
      input.job.lastErrorCode === 'GENERATION_SERVICE_UNAVAILABLE')
  ) {
    return {
      titleKey: 'generation.statusServiceUnavailable',
      detailKey: 'generation.statusServiceUnavailableDesc',
      terminal: false,
    };
  }
  if (input.job?.status === 'awaiting_confirmation') {
    return {
      titleKey: 'generation.statusAwaitingOutlineReview',
      detailKey: 'generation.statusAwaitingOutlineReviewDesc',
      terminal: false,
    };
  }
  if (input.job?.status === 'retry_wait') {
    return {
      titleKey: 'generation.statusRetryWait',
      detailKey: input.job.retryAt
        ? 'generation.statusRetryScheduledDesc'
        : 'generation.statusRetryWaitDesc',
      terminal: false,
    };
  }
  if (input.job?.status === 'queued' && input.job.queueReason === 'owner_limit') {
    return {
      titleKey: 'generation.statusOwnerWait',
      detailKey: 'generation.statusOwnerWaitDesc',
      terminal: false,
    };
  }
  if (input.job?.status === 'queued') {
    return {
      titleKey: 'generation.statusSiteQueue',
      detailKey: 'generation.statusSiteQueueDesc',
      terminal: false,
    };
  }
  if (input.job?.status === 'running') {
    const phase = (
      input.job.activeSteps?.find((step) => ['tts', 'media', 'actions'].includes(step.kind))
        ?.kind ??
      input.job.activeSteps?.[0]?.kind ??
      input.job.phase
    ).toLowerCase();
    if (['material', 'materials', 'parse', 'parsing', 'document', 'preparing'].includes(phase)) {
      return {
        titleKey: 'generation.statusParsingMaterials',
        detailKey: 'generation.statusParsingMaterialsDesc',
        terminal: false,
      };
    }
    if (['outline', 'outlines', 'research'].includes(phase)) {
      return {
        titleKey: 'generation.statusGeneratingOutline',
        detailKey: 'generation.statusGeneratingOutlineDesc',
        terminal: false,
      };
    }
    if (phase === 'agents') {
      return {
        titleKey: 'generation.statusGeneratingAgents',
        detailKey: 'generation.statusGeneratingAgentsDesc',
        terminal: false,
      };
    }
    if (['content', 'scene', 'scenes'].includes(phase)) {
      return {
        titleKey: 'generation.statusGeneratingScenes',
        detailKey:
          input.job.totalScenes > 0
            ? 'generation.statusGeneratingScenesProgress'
            : 'generation.statusGeneratingScenesDesc',
        ...(input.job.totalScenes > 0
          ? {
              detailValues: {
                ready: Math.min(input.job.readyScenes, input.job.totalScenes),
                total: input.job.totalScenes,
              },
            }
          : {}),
        terminal: false,
      };
    }
    if (phase === 'tts') {
      return {
        titleKey: 'generation.statusGeneratingSpeech',
        detailKey: 'generation.statusGeneratingSpeechDesc',
        terminal: false,
      };
    }
    if (['actions', 'media'].includes(phase)) {
      return {
        titleKey: 'generation.statusGeneratingMedia',
        detailKey: 'generation.statusGeneratingMediaDesc',
        terminal: false,
      };
    }
  }
  return {
    titleKey: 'generation.statusPreparing',
    detailKey: 'generation.statusPreparingDesc',
    terminal: false,
  };
}

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
