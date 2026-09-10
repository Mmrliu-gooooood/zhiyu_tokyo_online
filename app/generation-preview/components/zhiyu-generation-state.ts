import type { GenerationCanonicalPhase } from '../generation-session-runtime';
import type { GenerationDisplayProgress } from '@/lib/server/generation-jobs/contracts';

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

type BackgroundGenerationSnapshot = {
  status: string;
  phase: string;
  readyScenes: number;
  activeSteps?: Array<{ kind: string }>;
  displayProgress?: GenerationDisplayProgress;
};

function legacyActivePhase(job: BackgroundGenerationSnapshot): string {
  return (
    job.activeSteps?.find((step) => ['actions', 'tts', 'media'].includes(step.kind))?.kind ??
    job.activeSteps?.[0]?.kind ??
    job.phase
  ).toLowerCase();
}

export function projectBackgroundGenerationSnapshot(
  job: BackgroundGenerationSnapshot,
): {
  canonicalPhase: GenerationCanonicalPhase;
  stepId: 'outline' | 'web-search' | 'agent-generation' | 'slide-content' | 'actions';
  generatedContentCount: number;
} {
  const displayPhase =
    job.displayProgress?.failedStep?.phase ??
    job.displayProgress?.phase ??
    legacyActivePhase(job);
  const canonicalPhase: GenerationCanonicalPhase =
    job.status === 'succeeded'
      ? 'completed'
      : ['failed', 'needs_attention'].includes(job.status)
        ? 'failed'
        : job.status === 'cancelled'
          ? 'cancelled'
          : job.status === 'awaiting_confirmation'
            ? 'outline-review'
            : displayPhase === 'agents'
              ? 'agent-generation'
              : ['content', 'scene', 'scenes', 'scene_content'].includes(displayPhase)
                ? 'scene-generation'
                : ['actions', 'tts', 'media', 'finalizing'].includes(displayPhase)
                  ? 'media-actions'
                  : 'outline-streaming';
  const stepId =
    displayPhase === 'agents'
      ? ('agent-generation' as const)
      : ['content', 'scene', 'scenes', 'scene_content'].includes(displayPhase)
        ? ('slide-content' as const)
        : ['actions', 'tts', 'media', 'finalizing'].includes(displayPhase) ||
            canonicalPhase === 'completed'
          ? ('actions' as const)
          : displayPhase === 'research'
            ? ('web-search' as const)
            : ('outline' as const);
  return {
    canonicalPhase,
    stepId,
    generatedContentCount: job.displayProgress?.content.completed ?? job.readyScenes,
  };
}

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
    displayProgress?: GenerationDisplayProgress;
    outlines?: Array<{ id: string }>;
    reviewHold?: boolean;
    autoContinueAt?: string | null;
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
  if (
    input.job?.status === 'needs_attention' &&
    input.job.displayProgress?.failedStep?.phase === 'tts'
  ) {
    const progress = input.job.displayProgress;
    const failedOutlineIndex = progress.failedStep.outlineId
      ? (input.job.outlines?.findIndex(
          (outline) => outline.id === progress.failedStep?.outlineId,
        ) ?? -1)
      : -1;
    return {
      titleKey: 'generation.statusSpeechNeedsAttention',
      detailKey:
        failedOutlineIndex >= 0
          ? 'generation.statusSpeechNeedsAttentionDesc'
          : 'generation.statusSpeechNeedsAttentionFallbackDesc',
      detailValues: {
        page: failedOutlineIndex + 1,
        completed: progress.content.completed,
        total: progress.content.total,
      },
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
    if (!input.job.reviewHold && input.job.autoContinueAt) {
      return {
        titleKey: 'generation.statusOutlineAutoContinue',
        detailKey: 'generation.reviewOutlineAutoContinue',
        terminal: false,
      };
    }
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
    const phase = input.job.displayProgress?.phase ?? legacyActivePhase(input.job);
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
      const content = input.job.displayProgress?.content;
      const completed = content?.completed ?? input.job.readyScenes;
      const total = content?.total ?? input.job.totalScenes;
      return {
        titleKey: 'generation.statusGeneratingScenes',
        detailKey:
          total > 0
            ? 'generation.statusGeneratingScenesProgress'
            : 'generation.statusGeneratingScenesDesc',
        ...(total > 0
          ? {
              detailValues: {
                ready: Math.min(completed, total),
                total,
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
  jobStatus?: string;
  displayProgress?: GenerationDisplayProgress;
}): readonly ZhiyuGenerationStep[] {
  if (input.displayProgress) {
    const progress = input.displayProgress;
    const displayOrder: GenerationDisplayProgress['phase'][] = [
      'preparing',
      'research',
      'outlines',
      'agents',
      'content',
      'actions',
      'tts',
      'media',
      'finalizing',
    ];
    const phaseIndex = displayOrder.indexOf(progress.phase);
    const errorStage: ZhiyuGenerationErrorStage | null = progress.failedStep
      ? ['preparing', 'research', 'outlines'].includes(progress.failedStep.phase)
        ? 'outline'
        : progress.failedStep.phase === 'agents'
          ? 'agents'
          : progress.failedStep.phase === 'content'
            ? 'scenes'
            : 'media'
      : null;
    const stopped = ['failed', 'needs_attention', 'cancelled'].includes(input.jobStatus ?? '');
    const contentDone =
      progress.content.total > 0 && progress.content.completed >= progress.content.total;
    const speechDone =
      progress.speech.total !== null &&
      progress.speech.completed + progress.speech.skipped >= progress.speech.total;
    const mediaDone =
      progress.actions.total > 0 &&
      progress.actions.completed >= progress.actions.total &&
      speechDone &&
      progress.published.total > 0 &&
      progress.published.completed >= progress.published.total;
    const statusFor = (
      stage: ZhiyuGenerationErrorStage,
      done: boolean,
      active: boolean,
    ): ZhiyuGenerationStatus => {
      if (errorStage === stage) return 'error';
      if (done) return 'done';
      if (active && !stopped) return 'active';
      return 'pending';
    };
    const outlineDone = input.outlineReady || phaseIndex > displayOrder.indexOf('outlines');
    const agentsDone = input.agentsReady || phaseIndex > displayOrder.indexOf('agents');
    const contentActive =
      progress.content.active > 0 ||
      (!contentDone && phaseIndex >= displayOrder.indexOf('content'));
    const mediaActive =
      progress.actions.active > 0 ||
      progress.speech.active > 0 ||
      ['actions', 'tts', 'media', 'finalizing'].includes(progress.phase);

    return [
      { id: 'goal', labelKey: 'generation.learningGoal', status: 'done' },
      {
        id: 'outline',
        labelKey: 'generation.generatingOutlines',
        status: statusFor('outline', outlineDone, !outlineDone),
      },
      {
        id: 'agents',
        labelKey: 'generation.agentGeneration',
        status: statusFor('agents', agentsDone, outlineDone),
      },
      {
        id: 'scenes',
        labelKey: 'generation.generatingSlideContent',
        status: statusFor('scenes', contentDone, contentActive),
        ...(!contentDone && progress.content.total > 0
          ? {
              detail: `${Math.min(progress.content.completed, progress.content.total)} / ${progress.content.total}`,
            }
          : {}),
      },
      {
        id: 'media',
        labelKey: 'generation.generatingActions',
        status: statusFor('media', mediaDone, mediaActive),
        ...(!mediaDone && progress.published.total > 0
          ? {
              detail: `${Math.min(progress.published.completed, progress.published.total)} / ${progress.published.total}`,
            }
          : {}),
      },
    ];
  }

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
