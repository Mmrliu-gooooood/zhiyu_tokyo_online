'use client';

import { useEffect, useState, Suspense, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { AlertCircle, AlertTriangle, ArrowLeft, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ZhiyuLockup } from '@/components/brand/ZhiyuLockup';
import { ZhiyuLearningVisual } from '@/components/home/ZhiyuLearningVisual';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { OutlinesEditor } from '@/components/generation/outlines-editor';
import { cn } from '@/lib/utils';
import { persistStageCandidate, useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import {
  applyGeneratedAgentsToRegistry,
  useAgentRegistry,
} from '@/lib/orchestration/registry/store';
import {
  getEnabledProvidersWithVoices,
  resolveNarratorVoiceForGeneration,
} from '@/lib/audio/voice-resolver';
import { isQwenCloneVoice, resolveTTSModelForVoice } from '@/lib/audio/constants';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { useAllVoiceProfiles } from '@/lib/audio/voxcpm-voices';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  fetchSceneActions,
  fetchSceneContent,
  generateTTSForScene,
} from '@/lib/hooks/use-scene-generator';
import { isAbortError } from '@openmaic/generation';
import { FOREGROUND_SCENE_RETRY_OPTIONS } from './foreground-retry';
import {
  loadImageMapping,
  loadDocumentBlob,
  cleanupOldImages,
  deleteStoredImages,
  storeImages,
} from '@/lib/utils/image-storage';
import { deleteStageData } from '@/lib/utils/stage-storage';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { resolveSessionDocumentSources } from '@/lib/document/session-sources';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import {
  MAX_DOCUMENT_BUNDLE_FILES,
  MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES,
  buildDocumentBundle,
  type ParsedDocumentPart,
} from '@/lib/document/bundle';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import { nanoid } from 'nanoid';
import type { GeneratedAgentConfig, Scene, Stage } from '@/lib/types/stage';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  SessionDocumentSource,
} from '@/lib/types/generation';
import { AgentRevealModal } from '@/components/agent/agent-reveal-modal';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { createLogger } from '@/lib/logger';
import {
  type GenerationSessionState,
  ALL_STEPS,
  getActiveSteps,
  getGenerationStepText,
} from './types';
import { ZhiyuGenerationShell } from './components/ZhiyuGenerationShell';
import { GenerationExitDialog } from './components/GenerationExitDialog';
import { ZhiyuGenerationTopicCards } from './components/ZhiyuGenerationTopicCards';
import {
  projectBackgroundGenerationSnapshot,
  projectGenerationJobPresentation,
  projectZhiyuGenerationSteps,
} from './components/zhiyu-generation-state';
import { resolveTaskEngineModeFromOutlineDoneEvent } from './vocational-mode';
import {
  GenerationResourceLease,
  GenerationSessionRuntime,
  type GenerationCanonicalPhase,
} from './generation-session-runtime';
import { resolveOptionalWebSearch } from './optional-web-search';
import { useGenerationJob } from '@/lib/hooks/use-generation-job';
import { buildGenerationJobInput } from '@/lib/generation/session-input';
import {
  createGenerationJob,
  generationJobRequest,
  readBackgroundGenerationCapability,
  retryGenerationJob,
  type GenerationJobSnapshot,
} from '@/lib/generation/job-client';
import { getDocumentStore } from '@/lib/document-store';

const log = createLogger('GenerationPreview');
const OUTLINE_REVIEW_AUTO_CONTINUE_MS = 2500;

type ParsedDocumentResponseImage = {
  id: string;
  src?: string;
  pageNumber?: number;
  description?: string;
  width?: number;
  height?: number;
};

function validateDocumentSources(
  sources: SessionDocumentSource[],
  t: (key: string, values?: Record<string, unknown>) => string,
) {
  if (sources.length > MAX_DOCUMENT_BUNDLE_FILES) {
    throw new Error(t('upload.courseMaterialCountLimit', { n: MAX_DOCUMENT_BUNDLE_FILES }));
  }

  const totalSize = sources.reduce((sum, source) => sum + source.size, 0);
  if (totalSize > MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES) {
    throw new Error(
      t('upload.courseMaterialTotalSizeLimit', {
        n: Math.floor(MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES / 1024 / 1024),
      }),
    );
  }
}

type SceneGenerationFailure = {
  error?: string;
  errorCode?: string;
  statusCode?: number;
};

function GenerationPreviewContent() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const hasStartedRef = useRef(false);
  const outlineReviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outlineReviewResolveRef = useRef<((outlines: SceneOutline[]) => void) | null>(null);
  // Sticky flag: true once the user signals review intent (either by clicking the
  // streaming card mid-stream, or by restoring a session that was already in review).
  // Combined with `reviewOutlineEnabled` to decide whether the post-stream timer fires.
  const outlineReviewIntentRef = useRef(false);
  const { profiles: voiceProfiles } = useAllVoiceProfiles();

  const [session, setSession] = useState<GenerationSessionState | null>(null);
  const sessionRef = useRef<GenerationSessionState | null>(null);
  const backgroundJobRef = useRef<GenerationJobSnapshot | null>(null);
  const outlineDraftRef = useRef<SceneOutline[] | null>(null);
  const backgroundCommandRef = useRef<Promise<void>>(Promise.resolve());
  const backgroundRetryRef = useRef<Promise<void> | null>(null);
  const backgroundObservationEpoch = useRef(0);
  const backgroundAgentRevealRef = useRef<'unseen' | 'revealing' | 'revealed'>('unseen');
  const backgroundReadyStageRef = useRef<string | null>(null);
  const [canonicalPhase, setCanonicalPhase] = useState<GenerationCanonicalPhase>('idle');
  const generationRuntimeRef = useRef<GenerationSessionRuntime | null>(null);
  if (!generationRuntimeRef.current) {
    generationRuntimeRef.current = new GenerationSessionRuntime({ onPhase: setCanonicalPhase });
  }
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [showExitDialog, setShowExitDialog] = useState(false);
  const [exitCancelError, setExitCancelError] = useState<Error | null>(null);
  const [streamingOutlines, setStreamingOutlines] = useState<SceneOutline[] | null>(null);
  const [isOutlineStreaming, setIsOutlineStreaming] = useState(false);
  const [truncationWarnings, setTruncationWarnings] = useState<string[]>([]);
  const [showAgentReveal, setShowAgentReveal] = useState(false);
  const [isConfirmingOutlines, setIsConfirmingOutlines] = useState(false);
  const [generatedSceneCount, setGeneratedSceneCount] = useState(0);
  const [generatedScene, setGeneratedScene] = useState<Scene | undefined>(undefined);
  const [generatedAgents, setGeneratedAgents] = useState<
    Array<{
      id: string;
      name: string;
      role: string;
      persona: string;
      avatar: string;
      color: string;
      priority: number;
    }>
  >([]);
  const agentRevealResolveRef = useRef<(() => void) | null>(null);
  const reviewOutlineEnabled = useSettingsStore((s) => s.reviewOutlineEnabled);
  const setReviewOutlineEnabled = useSettingsStore((s) => s.setReviewOutlineEnabled);
  // Compute active steps based on session state
  const activeSteps = getActiveSteps(session);
  const isReviewingOutlines = session?.previewPhase === 'review';

  const applyBackgroundSnapshot = (job: GenerationJobSnapshot) => {
    const current = sessionRef.current;
    if (!current || current.generationJobId !== job.jobId) return;
    const previous = backgroundJobRef.current;
    if (previous?.jobId === job.jobId && previous.stateVersion > job.stateVersion) return;
    backgroundJobRef.current = job;
    const runningPhase =
      job.displayProgress?.phase ??
      job.activeSteps?.find((step) => ['actions', 'tts', 'media'].includes(step.kind))?.kind ??
      job.activeSteps?.[0]?.kind ??
      job.phase;
    const snapshotProjection = projectBackgroundGenerationSnapshot(job);
    const awaiting = job.status === 'awaiting_confirmation';
    const reviewing = awaiting && (job.reviewHold || !job.autoContinueAt);
    const next = {
      ...current,
      sceneOutlines: outlineDraftRef.current ?? job.outlines ?? current.sceneOutlines,
      previewPhase: reviewing
        ? ('review' as const)
        : awaiting
          ? ('outline-ready' as const)
          : ('generating-content' as const),
    };
    persistSession(next);
    setIsOutlineStreaming(
      !job.outlines?.length &&
        ['preparing', 'outline', 'outlines', 'research'].includes(runningPhase),
    );
    setGeneratedSceneCount(snapshotProjection.generatedContentCount);
    setCanonicalPhase(snapshotProjection.canonicalPhase);
    setCurrentStepIndex(
      Math.max(
        0,
        getActiveSteps(next).findIndex((step) => step.id === snapshotProjection.stepId),
      ),
    );
    setStatusMessage(awaiting && !reviewing ? t('generation.reviewOutlineAutoContinue') : '');
    setError(
      ['failed', 'needs_attention'].includes(job.status)
        ? job.lastErrorCode || t('generation.sceneGenerateFailed')
        : null,
    );
    if (job.readyScenes > 0 || (!awaiting && job.totalScenes > 0)) {
      const epoch = ++backgroundObservationEpoch.current;
      void getDocumentStore()
        .loadDocument(job.stageId)
        .then((document) => {
          if (
            !document ||
            epoch !== backgroundObservationEpoch.current ||
            sessionRef.current?.generationJobId !== job.jobId
          )
            return;
          setGeneratedScene(document.scenes[0]);
          if (document.stage.generatedAgentConfigs?.length) {
            setGeneratedAgents(
              document.stage.generatedAgentConfigs.map((agent) => ({
                id: agent.id,
                name: agent.name,
                role: agent.role,
                persona: agent.persona,
                avatar: agent.avatar,
                color: agent.color,
                priority: agent.priority,
              })),
            );
            if (
              current.backgroundInput?.agents?.mode === 'generate' &&
              backgroundAgentRevealRef.current === 'unseen'
            ) {
              backgroundAgentRevealRef.current = 'revealing';
              setShowAgentReveal(true);
              agentRevealResolveRef.current = () => {
                backgroundAgentRevealRef.current = 'revealed';
                const readyStage = backgroundReadyStageRef.current;
                if (readyStage) router.push(`/classroom/${encodeURIComponent(readyStage)}`);
              };
            }
          }
          // The first scene is already published transactionally. The classroom becomes an observer.
          if (job.readyScenes > 0) {
            backgroundReadyStageRef.current = job.stageId;
            if (backgroundAgentRevealRef.current !== 'revealing')
              router.push(`/classroom/${encodeURIComponent(job.stageId)}`);
          }
        })
        .catch((failure) =>
          setError(
            failure instanceof Error ? failure.message : t('generation.sceneGenerateFailed'),
          ),
        );
    }
  };
  const backgroundObservation = useGenerationJob(
    session?.generationJobId ?? null,
    applyBackgroundSnapshot,
  );
  const sceneGenerationErrorMessage = (failure: SceneGenerationFailure): string => {
    if (
      failure.errorCode === 'MISSING_API_KEY' ||
      failure.statusCode === 401 ||
      failure.statusCode === 403
    ) {
      return t('generation.sceneGenerateAuthFailed');
    }

    if (failure.errorCode === 'RATE_LIMITED' || failure.statusCode === 429) {
      return t('generation.sceneGenerateRateLimited');
    }

    if (failure.errorCode === 'UPSTREAM_ERROR' && failure.statusCode && failure.statusCode >= 500) {
      return t('generation.sceneGenerateProviderUnavailable');
    }

    if (failure.errorCode === 'INTERNAL_ERROR') {
      return t('generation.sceneGenerateFailed');
    }

    if (failure.errorCode === 'GENERATION_FAILED') {
      return t('generation.sceneGenerateInvalidResponse');
    }

    return failure.error || t('generation.sceneGenerateFailed');
  };

  const persistSession = (nextSession: GenerationSessionState, epoch?: number) => {
    const persist = () => {
      sessionRef.current = nextSession;
      setSession(nextSession);
      sessionStorage.setItem('generationSession', JSON.stringify(nextSession));
    };
    if (epoch === undefined) {
      persist();
      return;
    }
    generationRuntimeRef.current?.commit(epoch, persist);
  };

  const clearOutlineReviewTimer = () => {
    if (outlineReviewTimerRef.current) {
      clearTimeout(outlineReviewTimerRef.current);
      outlineReviewTimerRef.current = null;
    }
  };

  const waitForOutlineReviewChoice = (
    outlines: SceneOutline[],
    shouldReview: boolean,
    signal: AbortSignal,
  ): Promise<SceneOutline[]> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      outlineReviewResolveRef.current = resolve;
      // Reject on abort so navigating away (`goBackToHome`) or unmounting
      // settles this promise instead of leaking the awaiting startGeneration
      // closure. The catch at the bottom of startGeneration already swallows
      // AbortError silently.
      const onAbort = () => {
        clearOutlineReviewTimer();
        outlineReviewResolveRef.current = null;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (!shouldReview) {
        outlineReviewTimerRef.current = setTimeout(() => {
          outlineReviewTimerRef.current = null;
          outlineReviewResolveRef.current = null;
          signal.removeEventListener('abort', onAbort);
          resolve(outlines);
        }, OUTLINE_REVIEW_AUTO_CONTINUE_MS);
      }
    });

  // Load session from sessionStorage
  useEffect(() => {
    let active = true;
    cleanupOldImages(24).catch((e) => log.error(e));

    const requestedJob = new URL(window.location.href).searchParams.get('jobId');
    const saved = requestedJob ? null : sessionStorage.getItem('generationSession');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as GenerationSessionState;
        if (!parsed.previewPhase) {
          parsed.previewPhase = parsed.sceneOutlines?.length ? 'outline-ready' : 'preparing';
        }
        // Restore review intent: a saved 'review' phase without outlines means the user
        // had opened the editor mid-stream before the refresh — preserve that intent so
        // the post-stream auto-continue timer doesn't fire after SSE restart.
        if (parsed.previewPhase === 'review' && !parsed.sceneOutlines?.length) {
          outlineReviewIntentRef.current = true;
        }
        parsed.taskEngineMode = parsed.taskEngineMode === true;
        sessionRef.current = parsed;
        setSession(parsed);
      } catch (e) {
        log.error('Failed to parse generation session:', e);
      }
    } else {
      // A new browser session recovers durable work by owner, without recreating it.
      void (async () => {
        try {
          const capability = await readBackgroundGenerationCapability();
          if (!capability.enabled && !requestedJob) return;
          const jobs = requestedJob
            ? [
                await generationJobRequest<GenerationJobSnapshot>(
                  `/${encodeURIComponent(requestedJob)}`,
                ),
              ]
            : (await generationJobRequest<{ jobs: GenerationJobSnapshot[] }>('?active=1')).jobs;
          const job = jobs[0];
          if (!active || !job) return;
          const document = await getDocumentStore().loadDocument(job.stageId);
          if (!active) return;
          const recovered: GenerationSessionState = {
            sessionId: job.jobId,
            generationBackend: 'server-job',
            generationJobId: job.jobId,
            requirements: {
              requirement: document?.stage.description || document?.stage.name || '',
            },
            pdfText: '',
            currentStep: 'generating',
            previewPhase: 'preparing',
            courseTitle: document?.stage.name,
          };
          persistSession(recovered);
        } catch (failure) {
          if (active)
            setError(
              failure instanceof Error ? failure.message : t('generation.sceneGenerateFailed'),
            );
        } finally {
          if (active) setSessionLoaded(true);
        }
      })();
      return () => {
        active = false;
      };
    }
    setSessionLoaded(true);
    return () => {
      active = false;
    };
    // Session recovery runs once per mount; changing locale must not resubmit or replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Abort all in-flight requests on unmount
  useEffect(() => {
    return () => {
      generationRuntimeRef.current?.stop();
      backgroundObservationEpoch.current += 1;
      backgroundReadyStageRef.current = null;
      clearOutlineReviewTimer();
    };
  }, []);

  // Get API credentials from localStorage
  const getApiHeaders = () => {
    const modelConfig = getCurrentModelConfig();
    const settings = useSettingsStore.getState();
    const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
    const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];
    return {
      'Content-Type': 'application/json',
      'x-model': modelConfig.modelString,
      'x-api-key': modelConfig.apiKey,
      'x-base-url': modelConfig.baseUrl,
      'x-provider-type': modelConfig.providerType || '',
      // Image generation provider
      'x-image-provider': settings.imageProviderId || '',
      'x-image-model': settings.imageModelId || '',
      'x-image-api-key': imageProviderConfig?.apiKey || '',
      'x-image-base-url': imageProviderConfig?.baseUrl || '',
      // Video generation provider
      'x-video-provider': settings.videoProviderId || '',
      'x-video-model': settings.videoModelId || '',
      'x-video-api-key': videoProviderConfig?.apiKey || '',
      'x-video-base-url': videoProviderConfig?.baseUrl || '',
      // Media generation toggles
      'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
      'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
    };
  };

  const withThinkingConfig = <T extends Record<string, unknown>>(body: T) => {
    const { thinkingConfig } = getCurrentModelConfig();
    return thinkingConfig ? { ...body, thinkingConfig } : body;
  };

  // Auto-start generation when session is loaded
  useEffect(() => {
    if (!session || hasStartedRef.current) return;
    if (session.generationJobId) {
      hasStartedRef.current = true;
      return;
    }
    const needsOutlines = !session.sceneOutlines || session.sceneOutlines.length === 0;
    const phase = session.previewPhase;
    const shouldAutoStart =
      !phase ||
      phase === 'preparing' ||
      phase === 'generating-content' ||
      // Refresh during early-review: editor is shown but outlines weren't persisted,
      // so kick off SSE again — the editor will receive streaming outlines.
      (phase === 'review' && needsOutlines);
    if (shouldAutoStart) {
      hasStartedRef.current = true;
      startGeneration();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Main generation flow
  const startGeneration = async (sessionOverride?: GenerationSessionState) => {
    const generationSession = sessionOverride ?? session;
    if (!generationSession) return;

    // Resolve execution ownership before any document/model/media call. Once selected,
    // server ownership is sticky even when submission fails or its response is lost.
    const ownershipRun = generationRuntimeRef.current!.restart('outline-streaming');
    try {
      const capability =
        generationSession.generationBackend === 'server-job'
          ? { enabled: true, available: true }
          : await readBackgroundGenerationCapability(ownershipRun.signal);
      if (!generationRuntimeRef.current?.isCurrent(ownershipRun.epoch)) return;
      if (capability.enabled) {
        let backgroundSession: GenerationSessionState = {
          ...generationSession,
          generationBackend: 'server-job',
        };
        persistSession(backgroundSession);
        if (!capability.available) throw new Error('BACKGROUND_GENERATION_UNAVAILABLE');
        const run = generationRuntimeRef.current!.restart('outline-streaming');
        const input =
          backgroundSession.backgroundInput ??
          (await buildGenerationJobInput(backgroundSession, locale, run.signal, (key, asset) => {
            if (!generationRuntimeRef.current?.isCurrent(run.epoch)) return;
            backgroundSession = {
              ...backgroundSession,
              backgroundAssets: { ...backgroundSession.backgroundAssets, [key]: asset },
            };
            persistSession(backgroundSession);
          }));
        if (!generationRuntimeRef.current?.isCurrent(run.epoch)) return;
        backgroundSession = { ...backgroundSession, backgroundInput: input };
        persistSession(backgroundSession);
        const job = await createGenerationJob(
          input,
          `generation:${backgroundSession.sessionId}`,
          run.signal,
        );
        if (!generationRuntimeRef.current?.isCurrent(run.epoch)) return;
        persistSession({ ...backgroundSession, generationJobId: job.jobId });
        applyBackgroundSnapshot(job);
        return;
      }
    } catch (failure) {
      if (!isAbortError(failure))
        setError(failure instanceof Error ? failure.message : t('generation.sceneGenerateFailed'));
      return;
    }

    const runtime = generationRuntimeRef.current as GenerationSessionRuntime;
    const needsOutlines = !generationSession.sceneOutlines?.length;
    const run = runtime.restart(needsOutlines ? 'outline-streaming' : 'agent-generation');
    const { epoch, signal } = run;
    const commit = (effect: () => void) => runtime.commit(epoch, effect);

    // Use a local mutable copy so we can update it after document extraction
    let currentSession = generationSession;
    const imageLease = new GenerationResourceLease<string>(deleteStoredImages);

    commit(() => {
      setError(null);
      setCurrentStepIndex(0);
      setGeneratedSceneCount(0);
      setGeneratedScene(undefined);
    });

    try {
      // Compute active steps for this session (recomputed after session mutations)
      let activeSteps = getActiveSteps(currentSession);

      // Determine if we need the document analysis step
      const documentSources = resolveSessionDocumentSources(currentSession);
      const hasPdfToAnalyze = documentSources.length > 0 && !currentSession.pdfText;
      // If no document to analyze, skip to the next available step
      if (!hasPdfToAnalyze) {
        const firstNonPdfIdx = activeSteps.findIndex((s) => s.id !== 'pdf-analysis');
        setCurrentStepIndex(Math.max(0, firstNonPdfIdx));
      }

      // Step 0: Extract uploaded course material if needed
      if (hasPdfToAnalyze) {
        log.debug('=== Generation Preview: Extracting course material bundle ===');
        validateDocumentSources(documentSources, t);
        const sortedDocumentSources = [...documentSources].sort((a, b) => a.order - b.order);
        const parsedParts = await Promise.all(
          sortedDocumentSources.map(async (source): Promise<ParsedDocumentPart> => {
            const providerId = source.providerId || currentSession.pdfProviderId;
            const legacySourceConfig = (
              source as SessionDocumentSource & {
                providerConfig?: {
                  apiKey?: string;
                  baseUrl?: string;
                  accessKeyId?: string;
                  accessKeySecret?: string;
                };
              }
            ).providerConfig;
            const providerConfig = currentSession.pdfProviderConfig || legacySourceConfig;
            const documentBlob = await loadDocumentBlob(source.storageKey);
            if (!(documentBlob instanceof Blob) || documentBlob.size === 0) {
              throw new Error(t('generation.courseMaterialLoadFailed'));
            }
            const documentFile = new File([documentBlob], source.name || 'document.pdf', {
              type: source.mimeType || documentBlob.type || 'application/pdf',
            });
            const parseFormData = new FormData();
            parseFormData.append('file', documentFile);
            if (providerId) parseFormData.append('providerId', providerId);
            if (providerConfig?.apiKey?.trim())
              parseFormData.append('apiKey', providerConfig.apiKey);
            if (providerConfig?.baseUrl?.trim())
              parseFormData.append('baseUrl', providerConfig.baseUrl);
            if (providerConfig?.accessKeyId?.trim()) {
              parseFormData.append('accessKeyId', providerConfig.accessKeyId);
            }
            if (providerConfig?.accessKeySecret?.trim()) {
              parseFormData.append('accessKeySecret', providerConfig.accessKeySecret);
            }
            const parseResponse = await fetch('/api/extract-document', {
              method: 'POST',
              body: parseFormData,
              signal,
            });
            if (!parseResponse.ok) throw new Error(t('generation.courseMaterialParseFailed'));
            const parseResult = await parseResponse.json();
            if (!parseResult.success || !parseResult.data) {
              throw new Error(t('generation.courseMaterialParseFailed'));
            }
            const parseData = parseResult.data;
            const rawImages = parseData.metadata?.pdfImages;
            const images = rawImages
              ? rawImages.map((img: ParsedDocumentResponseImage) => ({
                  id: img.id,
                  src: img.src || '',
                  pageNumber: img.pageNumber ?? 1,
                  description: img.description,
                  width: img.width,
                  height: img.height,
                }))
              : ((parseData.images as string[] | undefined) ?? []).map((src, i) => ({
                  id: `img_${i + 1}`,
                  src,
                  pageNumber: 1,
                }));

            return {
              source: {
                id: source.id,
                name: source.name,
                size: source.size,
                lastModified: source.lastModified,
                mimeType: source.mimeType,
                order: source.order,
                providerId,
              },
              text: parseData.text as string,
              rawTextLength: (parseData.text as string).length,
              pageCount: parseData.metadata?.pageCount,
              images,
            };
          }),
        );
        if (!runtime.isCurrent(epoch)) return;

        const bundle = buildDocumentBundle(parsedParts);
        const imageStorageIds = await storeImages(bundle.images, signal);
        imageLease.own(imageStorageIds);
        if (!runtime.isCurrent(epoch)) return;

        const pdfImages: PdfImage[] = bundle.images.map((img, i) => ({
          id: img.id,
          src: '',
          pageNumber: img.pageNumber,
          description: img.description,
          width: img.width,
          height: img.height,
          originalId: img.originalId,
          sourceDocumentId: img.sourceDocumentId,
          sourceDocumentName: img.sourceDocumentName,
          sourceDocumentOrder: img.sourceDocumentOrder,
          visionPriority: img.visionPriority,
          storageId: imageStorageIds[i],
        }));

        // Update session with extracted document data
        const updatedSession = {
          ...currentSession,
          documentSources,
          pdfText: bundle.text,
          pdfImages,
          imageStorageIds,
          pdfStorageKey: undefined, // Clear so we don't re-parse
        };
        if (
          !commit(() => {
            setSession(updatedSession);
            sessionStorage.setItem('generationSession', JSON.stringify(updatedSession));
          })
        ) {
          return;
        }
        imageLease.transfer();

        // Truncation warnings
        const warnings: string[] = [];
        if (bundle.totalRawTextLength > bundle.textContentBudget) {
          warnings.push(t('generation.textTruncated', { n: bundle.textContentBudget }));
        }
        if (bundle.totalImageCount > MAX_VISION_IMAGES) {
          warnings.push(
            t('generation.imageTruncated', {
              total: bundle.totalImageCount,
              max: MAX_VISION_IMAGES,
            }),
          );
        }
        if (warnings.length > 0) {
          commit(() => setTruncationWarnings(warnings));
        }

        // Reassign local reference for subsequent steps
        currentSession = updatedSession;
        activeSteps = getActiveSteps(currentSession);
      }

      // Step: Web Search (if enabled)
      const webSearchStepIdx = activeSteps.findIndex((s) => s.id === 'web-search');
      if (currentSession.requirements.webSearch && webSearchStepIdx >= 0) {
        setCurrentStepIndex(webSearchStepIdx);

        const wsSettings = useSettingsStore.getState();
        const wsProviderId = wsSettings.webSearchProviderId;
        const wsConfig = wsSettings.webSearchProvidersConfig?.[wsProviderId];
        const searchResult = await resolveOptionalWebSearch(() =>
          fetch('/api/web-search', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify(
              withThinkingConfig({
                query: currentSession.requirements.requirement,
                pdfText: currentSession.pdfText || undefined,
                providerId: wsProviderId,
                apiKey: wsConfig?.apiKey || undefined,
                baseUrl: wsProviderId === 'searxng' ? undefined : wsConfig?.baseUrl || undefined,
                baiduSubSources: wsProviderId === 'baidu' ? wsSettings.baiduSubSources : undefined,
                claudeModelId:
                  wsProviderId === 'claude' ? wsConfig?.modelId || undefined : undefined,
              }),
            ),
            signal,
          }),
        );
        if (!runtime.isCurrent(epoch)) return;

        if (searchResult.warning) {
          log.warn(`${searchResult.warning}; continuing without search context`);
        }

        const updatedSessionWithSearch = {
          ...currentSession,
          researchContext: searchResult.researchContext,
          researchSources: searchResult.researchSources,
        };
        commit(() => {
          setSession(updatedSessionWithSearch);
          sessionStorage.setItem('generationSession', JSON.stringify(updatedSessionWithSearch));
        });
        currentSession = updatedSessionWithSearch;
        activeSteps = getActiveSteps(currentSession);
      }

      // Load imageMapping early (needed for both outline and scene generation).
      let imageMapping: ImageMapping = {};
      if (currentSession.imageStorageIds && currentSession.imageStorageIds.length > 0) {
        log.debug('Loading images from IndexedDB');
        imageMapping = await loadImageMapping(currentSession.imageStorageIds);
        if (!runtime.isCurrent(epoch)) return;
      } else if (
        currentSession.imageMapping &&
        Object.keys(currentSession.imageMapping).length > 0
      ) {
        log.debug('Using imageMapping from session (old format)');
        imageMapping = currentSession.imageMapping;
      }

      // Create stage client-side
      const stageId = nanoid(10);
      const stage: Stage = {
        id: stageId,
        name: extractTopicFromRequirement(currentSession.requirements.requirement),
        description: '',
        style: 'professional',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        interactiveMode: !!currentSession.requirements.interactiveMode,
        taskEngineMode: currentSession.taskEngineMode === true,
      };

      // ── Generate outlines first (infers languageDirective) ──
      let outlines = currentSession.sceneOutlines;
      let languageDirective = currentSession.languageDirective;
      let courseTitle = currentSession.courseTitle;

      const outlineStepIdx = activeSteps.findIndex((s) => s.id === 'outline');
      setCurrentStepIndex(outlineStepIdx >= 0 ? outlineStepIdx : 0);
      if (!outlines || outlines.length === 0) {
        log.debug('=== Generating outlines (SSE) ===');
        setStreamingOutlines([]);
        setIsOutlineStreaming(true);

        const outlineResult = await new Promise<{
          outlines: SceneOutline[];
          languageDirective: string;
          courseTitle?: string;
          taskEngineMode: boolean;
        }>((resolve, reject) => {
          const collected: SceneOutline[] = [];
          let directive: string | undefined;
          let title: string | undefined;

          fetch('/api/generate/scene-outlines-stream', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify(
              withThinkingConfig({
                requirements: currentSession.requirements,
                pdfText: currentSession.pdfText,
                pdfImages: currentSession.pdfImages,
                imageMapping,
                researchContext: currentSession.researchContext,
              }),
            ),
            signal,
          })
            .then((res) => {
              if (!res.ok) {
                return res.json().then((d) => {
                  reject(new Error(d.error || t('generation.outlineGenerateFailed')));
                });
              }

              const reader = res.body?.getReader();
              if (!reader) {
                reject(new Error(t('generation.streamNotReadable')));
                return;
              }

              const decoder = new TextDecoder();
              let sseBuffer = '';

              const pump = (): Promise<void> =>
                reader.read().then(({ done, value }) => {
                  if (value) {
                    sseBuffer += decoder.decode(value, { stream: !done });
                    const lines = sseBuffer.split('\n');
                    sseBuffer = lines.pop() || '';

                    for (const line of lines) {
                      if (!line.startsWith('data: ')) continue;
                      try {
                        const evt = JSON.parse(line.slice(6));
                        if (evt.type === 'languageDirective') {
                          directive = evt.data;
                        } else if (evt.type === 'courseTitle') {
                          title = evt.data;
                        } else if (evt.type === 'outline') {
                          collected.push(evt.data);
                          commit(() => setStreamingOutlines([...collected]));
                        } else if (evt.type === 'retry') {
                          collected.length = 0;
                          // Drop any directive/title latched from the failed
                          // attempt — the server resets these per attempt, so a
                          // succeeding attempt that omits them must fall back, not
                          // inherit the previous attempt's stale values.
                          directive = undefined;
                          title = undefined;
                          commit(() => {
                            setStreamingOutlines([]);
                            setStatusMessage(t('generation.outlineRetrying'));
                          });
                        } else if (evt.type === 'done') {
                          directive = evt.languageDirective || directive;
                          resolve({
                            outlines: evt.outlines || collected,
                            languageDirective:
                              directive ||
                              'Teach in the language that matches the user requirement.',
                            courseTitle: evt.courseTitle || title,
                            taskEngineMode: resolveTaskEngineModeFromOutlineDoneEvent(evt),
                          });
                          return;
                        } else if (evt.type === 'error') {
                          reject(new Error(evt.error));
                          return;
                        }
                      } catch (e) {
                        log.error('Failed to parse outline SSE:', line, e);
                      }
                    }
                  }
                  if (done) {
                    if (collected.length > 0) {
                      resolve({
                        outlines: collected,
                        languageDirective:
                          directive || 'Teach in the language that matches the user requirement.',
                        // Carry any title latched from a streaming `courseTitle`
                        // event here too — symmetric with languageDirective — so
                        // a stream that ends without an explicit `done` event
                        // does not silently drop a valid inferred title.
                        courseTitle: title,
                        taskEngineMode: false,
                      });
                    } else {
                      reject(new Error(t('generation.outlineEmptyResponse')));
                    }
                    return;
                  }
                  return pump();
                });

              pump().catch(reject);
            })
            .catch(reject);
        });
        if (!runtime.isCurrent(epoch)) return;

        outlines = outlineResult.outlines;
        languageDirective = outlineResult.languageDirective;
        courseTitle = outlineResult.courseTitle;
        const effectiveTaskEngineMode = outlineResult.taskEngineMode;
        commit(() => setIsOutlineStreaming(false));

        // Mid-stream review intent (sticky ref) overrides the auto-continue timer.
        const userOpenedReviewEarly = outlineReviewIntentRef.current;
        const shouldReviewOutlines =
          useSettingsStore.getState().reviewOutlineEnabled || userOpenedReviewEarly;
        const updatedSession: GenerationSessionState = {
          ...currentSession,
          sceneOutlines: outlines,
          languageDirective,
          courseTitle,
          taskEngineMode: effectiveTaskEngineMode,
          previewPhase: shouldReviewOutlines ? 'review' : 'outline-ready',
        };
        if (!runtime.transition(epoch, 'outline-review')) return;
        persistSession(updatedSession, epoch);
        currentSession = updatedSession;
        setStreamingOutlines(outlines);

        setStatusMessage(shouldReviewOutlines ? '' : t('generation.reviewOutlineAutoContinue'));
        setIsConfirmingOutlines(false);
        outlines = await waitForOutlineReviewChoice(outlines, shouldReviewOutlines, signal);
        if (!runtime.isCurrent(epoch)) return;
        clearOutlineReviewTimer();
        currentSession = {
          ...currentSession,
          sceneOutlines: outlines,
          taskEngineMode: effectiveTaskEngineMode,
          previewPhase: 'generating-content',
        };
        if (!runtime.transition(epoch, 'agent-generation')) return;
        persistSession(currentSession, epoch);

        // User has committed to course generation (either by confirming the
        // outline review or by letting the auto-continue timer fire). Now it's
        // safe to wipe the homepage draft cache; before this point, "back to
        // requirements" must restore the user's original input.
        try {
          localStorage.removeItem('requirementDraft');
        } catch {
          /* ignore */
        }
      }

      // Move to next step
      setStatusMessage('');
      if (!outlines || outlines.length === 0) {
        throw new Error(t('generation.outlineEmptyResponse'));
      }
      stage.taskEngineMode = currentSession.taskEngineMode === true;

      // Store languageDirective on the stage
      if (languageDirective) {
        stage.languageDirective = languageDirective;
      }

      // Adopt the LLM-inferred course title as the stage name when available,
      // replacing the raw-requirement placeholder set at stage creation time.
      if (courseTitle) {
        stage.name = courseTitle;
      }

      // ── Agent generation (after outlines — uses languageDirective + outlines) ──
      const settings = useSettingsStore.getState();
      let agents: Array<{
        id: string;
        name: string;
        role: string;
        persona?: string;
      }> = [];

      if (settings.agentMode === 'auto') {
        const agentStepIdx = activeSteps.findIndex((s) => s.id === 'agent-generation');
        if (agentStepIdx >= 0) setCurrentStepIndex(agentStepIdx);

        try {
          const allAvatars = [
            {
              path: '/avatars/teacher.png',
              desc: 'Male teacher with glasses, holding a book, green background',
            },
            {
              path: '/avatars/teacher-2.png',
              desc: 'Female teacher with long dark hair, blue traditional outfit, gentle expression',
            },
            {
              path: '/avatars/assist.png',
              desc: 'Young female assistant with glasses, pink background, friendly smile',
            },
            {
              path: '/avatars/assist-2.png',
              desc: 'Young female in orange top and purple overalls, cheerful and approachable',
            },
            {
              path: '/avatars/clown.png',
              desc: 'Energetic girl with glasses pointing up, green shirt, lively and fun',
            },
            {
              path: '/avatars/clown-2.png',
              desc: 'Playful girl with curly hair doing rock gesture, blue shirt, humorous vibe',
            },
            {
              path: '/avatars/curious.png',
              desc: 'Surprised boy with glasses, hand on cheek, curious expression',
            },
            {
              path: '/avatars/curious-2.png',
              desc: 'Boy with backpack holding a book and question mark bubble, inquisitive',
            },
            {
              path: '/avatars/note-taker.png',
              desc: 'Studious boy with glasses, blue shirt, calm and organized',
            },
            {
              path: '/avatars/note-taker-2.png',
              desc: 'Active boy with yellow backpack waving, blue outfit, enthusiastic learner',
            },
            {
              path: '/avatars/thinker.png',
              desc: 'Thoughtful girl with hand on chin, purple background, contemplative',
            },
            {
              path: '/avatars/thinker-2.png',
              desc: 'Girl reading a book intently, long dark hair, intellectual and focused',
            },
          ];

          const getAvailableVoicesForGeneration = () => {
            const providers = getEnabledProvidersWithVoices(
              settings.ttsProvidersConfig,
              voiceProfiles,
            );
            return providers.flatMap((p) =>
              p.voices.map((v) => {
                const cloneModelGroup =
                  p.providerId === 'qwen-tts' && isQwenCloneVoice(v.id)
                    ? p.modelGroups.find((group) =>
                        group.voices.some((groupVoice) => groupVoice.id === v.id),
                      )
                    : undefined;
                const modelId = cloneModelGroup
                  ? resolveTTSModelForVoice(p.providerId, v.id, cloneModelGroup.modelId)
                  : undefined;
                return {
                  providerId: p.providerId,
                  ...(modelId ? { modelId } : {}),
                  voiceId: v.id,
                  voiceName: v.name,
                  voiceLanguage: v.language,
                };
              }),
            );
          };

          // The user's global TTS voice is the narrator voice. Pass it along so
          // the server pins the teacher agent to it instead of letting the LLM
          // pick a different voice. Reuse the same resolution helpers as the
          // advertised list: the model follows the voice, and only clones carry
          // a model on the wire. An unusable global voice (disabled/unconfigured
          // provider) is NOT pinned — the LLM then picks a working advertised
          // voice and the narration fallback machinery stays alive.
          const getNarratorVoiceForGeneration = () =>
            resolveNarratorVoiceForGeneration(
              settings.ttsProviderId,
              settings.ttsVoice,
              settings.ttsProvidersConfig[settings.ttsProviderId],
            );

          const agentResp = await fetch('/api/generate/agent-profiles', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify(
              withThinkingConfig({
                stageInfo: { name: stage.name, description: stage.description },
                sceneOutlines: outlines.map((o) => ({
                  title: o.title,
                  description: o.description,
                })),
                languageDirective,
                availableAvatars: allAvatars.map((a) => a.path),
                avatarDescriptions: allAvatars.map((a) => ({ path: a.path, desc: a.desc })),
                availableVoices: getAvailableVoicesForGeneration(),
                narratorVoice: getNarratorVoiceForGeneration(),
              }),
            ),
            signal,
          });
          if (!runtime.isCurrent(epoch)) return;

          if (!agentResp.ok) throw new Error('Agent generation failed');
          const agentData = await agentResp.json();
          if (!runtime.isCurrent(epoch)) return;
          if (!agentData.success) throw new Error(agentData.error || 'Agent generation failed');

          // Embed the roster (including its voice binding) on the stage — it
          // persists with the stage document via saveToStorage below — and
          // mirror it into the in-memory registry. The agent-profile LLM has
          // already bound each agent's voice (from availableVoices); the
          // fallback for an invalid/unavailable voice is applied later at the
          // live TTS call.
          const generatedConfigs = agentData.agents as GeneratedAgentConfig[];
          stage.generatedAgentConfigs = generatedConfigs;
          const savedIds = generatedConfigs.map((agent) => agent.id);
          stage.agentIds = savedIds;

          // Show card-reveal modal, continue generation once all cards are revealed
          setGeneratedAgents(agentData.agents);
          setShowAgentReveal(true);
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              agentRevealResolveRef.current = null;
              reject(new DOMException('Aborted', 'AbortError'));
            };
            agentRevealResolveRef.current = () => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            };
            signal.addEventListener('abort', onAbort, { once: true });
          });
          if (!runtime.isCurrent(epoch)) return;

          agents = generatedConfigs.map((agent) => ({
            id: agent.id,
            name: agent.name,
            role: agent.role,
            persona: agent.persona,
          }));
        } catch (err: unknown) {
          if (!runtime.isCurrent(epoch)) return;
          log.warn('[Generation] Agent generation failed, falling back to presets:', err);
          const registry = useAgentRegistry.getState();
          const fallbackIds = settings.selectedAgentIds.filter((id) => {
            const a = registry.getAgent(id);
            return a && !a.isGenerated;
          });
          agents = fallbackIds
            .map((id) => registry.getAgent(id))
            .filter(Boolean)
            .map((a) => ({
              id: a!.id,
              name: a!.name,
              role: a!.role,
              persona: a!.persona,
            }));
          stage.agentIds = fallbackIds;
        }
      } else {
        // Preset mode — use selected agents (include persona)
        // Filter out stale generated agent IDs that may linger in settings
        const registry = useAgentRegistry.getState();
        const presetAgentIds = settings.selectedAgentIds.filter((id) => {
          const a = registry.getAgent(id);
          return a && !a.isGenerated;
        });
        agents = presetAgentIds
          .map((id) => registry.getAgent(id))
          .filter(Boolean)
          .map((a) => ({
            id: a!.id,
            name: a!.name,
            role: a!.role,
            persona: a!.persona,
          }));
        stage.agentIds = presetAgentIds;
      }

      // Move to scene generation step
      setStatusMessage('');
      if (!outlines || outlines.length === 0) {
        throw new Error(t('generation.outlineEmptyResponse'));
      }

      // Store stage and outlines
      const store = useStageStore.getState();
      stage.videoManifest = buildVideoManifestFromOutlines(outlines);
      if (!runtime.transition(epoch, 'scene-generation')) return;

      // Advance to slide-content step
      const contentStepIdx = activeSteps.findIndex((s) => s.id === 'slide-content');
      if (contentStepIdx >= 0) setCurrentStepIndex(contentStepIdx);

      // Build stageInfo and userProfile for API call
      const stageInfo = {
        name: stage.name,
        description: stage.description,
        style: stage.style,
      };

      const userProfile =
        currentSession.requirements.userNickname || currentSession.requirements.userBio
          ? `Student: ${currentSession.requirements.userNickname || 'Unknown'}${currentSession.requirements.userBio ? ` — ${currentSession.requirements.userBio}` : ''}`
          : undefined;

      // Generate ONLY the first scene. Keep the candidate stage local until
      // its first scene is complete so cancel/restart cannot expose a stale
      // half-built course through the shared StageStore.

      const firstOutline = outlines[0];

      // Step 2: Generate content (currentStepIndex is already 2)
      const contentData = await fetchSceneContent(
        {
          outline: firstOutline,
          allOutlines: outlines,
          pdfImages: currentSession.pdfImages,
          imageMapping,
          stageInfo,
          stageId: stage.id,
          agents,
          languageDirective,
          requirements: currentSession.requirements,
        },
        signal,
        FOREGROUND_SCENE_RETRY_OPTIONS,
      );
      if (!runtime.isCurrent(epoch)) return;

      if (!contentData.success || !contentData.content) {
        throw new Error(sceneGenerationErrorMessage(contentData));
      }

      // Generate actions (activate actions step indicator)
      if (!runtime.transition(epoch, 'media-actions')) return;
      const actionsStepIdx = activeSteps.findIndex((s) => s.id === 'actions');
      setCurrentStepIndex(actionsStepIdx >= 0 ? actionsStepIdx : currentStepIndex + 1);

      const data = await fetchSceneActions(
        {
          outline: contentData.effectiveOutline || firstOutline,
          allOutlines: outlines,
          content: contentData.content,
          stageId: stage.id,
          agents,
          previousSpeeches: [],
          userProfile,
          languageDirective,
        },
        signal,
        FOREGROUND_SCENE_RETRY_OPTIONS,
      );
      if (!runtime.isCurrent(epoch)) return;

      if (!data.success || !data.scene) {
        throw new Error(sceneGenerationErrorMessage(data));
      }
      const firstScene = data.scene;

      // Generate TTS for first scene (part of actions step — blocking)
      if (
        settings.ttsEnabled &&
        settings.ttsProviderId !== 'browser-native-tts' &&
        isTTSProviderEnabled(
          settings.ttsProviderId,
          settings.ttsProvidersConfig?.[settings.ttsProviderId],
        )
      ) {
        const ttsResult = await generateTTSForScene(
          firstScene,
          languageDirective,
          signal,
          FOREGROUND_SCENE_RETRY_OPTIONS,
        );
        if (!runtime.isCurrent(epoch)) return;
        if (!ttsResult.success) throw new Error(t('generation.speechFailed'));
      }

      const remaining = outlines.filter((o) => o.order !== firstScene.order);
      const persistedAt = Date.now();
      const published = await runtime.publishAfterPersist(epoch, {
        persist: async () => {
          await persistStageCandidate({
            stage,
            scenes: [firstScene],
            currentSceneId: firstScene.id,
            chats: [],
            outline: {
              outlines,
              generationComplete: false,
              createdAt: persistedAt,
              updatedAt: persistedAt,
            },
          });
        },
        discard: async () => {
          await deleteStageData(stage.id);
        },
        publish: () => {
          if (stage.generatedAgentConfigs) {
            const savedIds = applyGeneratedAgentsToRegistry(stage.id, stage.generatedAgentConfigs);
            settings.setSelectedAgentIds(savedIds);
            // Stage-derived, not a user choice — must not carry across classrooms.
            settings.setAgentSelectionIsUserSet(false);
          }
          store.setStage(stage);
          store.setOutlines(outlines);
          store.setGeneratingOutlines(outlines);
          store.addScene(firstScene);
          store.setCurrentSceneId(firstScene.id);
          setGeneratedScene(firstScene);
          setGeneratedSceneCount(1);
          setCurrentStepIndex(activeSteps.length);
          store.setGeneratingOutlines(remaining);

          sessionStorage.setItem(
            'generationParams',
            JSON.stringify({
              pdfImages: currentSession.pdfImages,
              agents,
              userProfile,
              languageDirective,
            }),
          );
          sessionStorage.removeItem('generationSession');
        },
      });
      if (!published) return;
      if (!runtime.transition(epoch, 'completed')) return;
      router.push(`/classroom/${stage.id}`);
    } catch (err) {
      if (!runtime.isCurrent(epoch)) return;
      commit(() => setIsOutlineStreaming(false));
      // AbortError is expected when navigating away — don't show as error
      if (isAbortError(err)) {
        log.info('[GenerationPreview] Generation aborted');
        return;
      }
      const imageStorageIds = currentSession.imageStorageIds ?? [];
      const errorMessage = err instanceof Error ? err.message : String(err);
      await runtime.failAfterRevoking(epoch, {
        revoke: () => {
          sessionStorage.removeItem('generationSession');
          setError(errorMessage);
        },
        discard: async () => {
          await deleteStoredImages(imageStorageIds).catch((cleanupError) => {
            log.warn('[GenerationPreview] Failed to discard session image records:', cleanupError);
          });
        },
      });
    } finally {
      await imageLease.discard().catch((cleanupError) => {
        log.warn('[GenerationPreview] Failed to discard retired image records:', cleanupError);
      });
    }
  };

  const extractTopicFromRequirement = (requirement: string): string => {
    const trimmed = requirement.trim();
    if (trimmed.length <= 500) {
      return trimmed;
    }
    return trimmed.substring(0, 500).trim() + '...';
  };

  const queueBackgroundOutlineCommand = (command: {
    reviewHold?: boolean;
    outlines?: SceneOutline[];
    confirm?: boolean;
  }): Promise<void> => {
    const requestedJobId = sessionRef.current?.generationJobId;
    const execute = async () => {
      let job = backgroundJobRef.current;
      if (
        !requestedJobId ||
        !job ||
        job.jobId !== requestedJobId ||
        sessionRef.current?.generationJobId !== requestedJobId
      )
        return;
      if (command.confirm && outlineDraftRef.current) {
        // A failed/lost edit command must never confirm a stale server plan.
        const draft = outlineDraftRef.current;
        const saveKey = nanoid();
        const saved = await generationJobRequest<GenerationJobSnapshot>(
          `/${encodeURIComponent(requestedJobId)}/outline`,
          {
            method: 'PATCH',
            key: saveKey,
            body: {
              commandKey: saveKey,
              expectedVersion: job.stateVersion,
              planRevision: job.planRevision,
              outlines: draft,
              reviewHold: true,
            },
          },
        );
        if (sessionRef.current?.generationJobId !== requestedJobId) return;
        if (outlineDraftRef.current === draft) outlineDraftRef.current = null;
        job = { ...job, ...saved };
        applyBackgroundSnapshot(job);
      }
      const commandKey = nanoid();
      const path = command.confirm ? 'confirm' : 'outline';
      const updated = await generationJobRequest<GenerationJobSnapshot>(
        `/${encodeURIComponent(requestedJobId)}/${path}`,
        {
          method: command.confirm ? 'POST' : 'PATCH',
          key: commandKey,
          body: {
            commandKey,
            expectedVersion: job.stateVersion,
            planRevision: job.planRevision,
            ...(command.reviewHold === undefined ? {} : { reviewHold: command.reviewHold }),
            ...(command.outlines ? { outlines: command.outlines } : {}),
          },
        },
      );
      if (sessionRef.current?.generationJobId !== requestedJobId) return;
      if (command.outlines && outlineDraftRef.current === command.outlines)
        outlineDraftRef.current = null;
      job = { ...job, ...updated };
      applyBackgroundSnapshot(job);
    };
    const pending = backgroundCommandRef.current.then(execute);
    // A rejected command never gets an automatic new idempotency key or a local fallback.
    backgroundCommandRef.current = pending.catch((failure) => {
      setError(failure instanceof Error ? failure.message : t('generation.sceneGenerateFailed'));
    });
    return backgroundCommandRef.current;
  };

  const continueInBackgroundAndReturn = () => {
    generationRuntimeRef.current?.stop();
    backgroundObservationEpoch.current += 1;
    setShowExitDialog(false);
    router.push('/');
  };

  const goBackToHome = () => {
    if (sessionRef.current?.generationBackend === 'server-job') {
      const status = backgroundJobRef.current?.status;
      if (status && ['succeeded', 'failed', 'needs_attention', 'cancelled'].includes(status)) {
        continueInBackgroundAndReturn();
      } else {
        setExitCancelError(null);
        setShowExitDialog(true);
      }
      return;
    }
    generationRuntimeRef.current?.cancel();
    clearOutlineReviewTimer();
    outlineReviewIntentRef.current = false;
    void deleteStoredImages(session?.imageStorageIds ?? []).catch((cleanupError) => {
      log.warn('[GenerationPreview] Failed to discard abandoned image records:', cleanupError);
    });
    sessionStorage.removeItem('generationSession');
    router.push('/');
  };

  const cancelBackgroundAndReturn = async () => {
    const requestedJobId = sessionRef.current?.generationJobId;
    if (!requestedJobId) {
      setExitCancelError(new Error('GENERATION_JOB_SUBMISSION_PENDING'));
      return;
    }
    setExitCancelError(null);
    try {
      const settled = await backgroundObservation.cancel();
      if (
        sessionRef.current?.generationJobId !== requestedJobId ||
        settled?.jobId !== requestedJobId
      ) {
        return;
      }
      if (!['succeeded', 'failed', 'cancelled'].includes(settled.status)) {
        setExitCancelError(new Error('GENERATION_CANCELLATION_NOT_CONFIRMED'));
        return;
      }
      continueInBackgroundAndReturn();
    } catch (failure) {
      setExitCancelError(
        failure instanceof Error ? failure : new Error('GENERATION_CANCELLATION_FAILED'),
      );
    }
  };

  const handleGoBackAndRetry = () => {
    const current = sessionRef.current;
    if (current?.generationBackend !== 'server-job') {
      goBackToHome();
      return;
    }
    if (backgroundRetryRef.current) return;
    const job = backgroundJobRef.current;
    const pending = (async () => {
      try {
        if (!current.generationJobId) {
          // A lost submission response retries the same frozen input and create key.
          setError(null);
          await startGeneration(current);
          return;
        }
        if (!job || job.jobId !== current.generationJobId) return;
        if (!['failed', 'needs_attention'].includes(job.status)) {
          goBackToHome();
          return;
        }
        const updated = await retryGenerationJob(job);
        if (!updated || sessionRef.current?.generationJobId !== updated.jobId) return;
        backgroundJobRef.current = updated;
        setError(null);
        router.push('/');
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : t('generation.sceneGenerateFailed'));
      }
    })().finally(() => {
      backgroundRetryRef.current = null;
    });
    backgroundRetryRef.current = pending;
  };

  // Triggered when the user clicks the streaming outline card mid-stream.
  // SSE keeps running; only the surface morph + intent flag change.
  const handleExpandStreamingOutline = () => {
    if (sessionRef.current?.generationBackend === 'server-job') {
      void queueBackgroundOutlineCommand({ reviewHold: true });
      return;
    }
    if (!generationRuntimeRef.current?.canAcceptIntent) return;
    if (!session) return;
    clearOutlineReviewTimer();
    setStatusMessage('');
    outlineReviewIntentRef.current = true;
    persistSession({
      ...session,
      previewPhase: 'review',
    });
  };

  // Inverse of expand. Mid-stream: shrink back to the streaming preview card so
  // the user can keep watching while SSE fills in the rest. Post-stream: shrink
  // back to the small card too, then re-arm the 2.5s auto-continue timer — same
  // pacing as the no-review path so the user has a beat to see the card before
  // the page advances. Jumping straight to content gen feels too abrupt.
  const handleCollapseEditor = () => {
    if (sessionRef.current?.generationBackend === 'server-job') {
      void queueBackgroundOutlineCommand({ reviewHold: false });
      return;
    }
    if (!generationRuntimeRef.current?.canAcceptIntent) return;
    if (!session) return;
    if (isOutlineStreaming) {
      // Intentionally drop the review-intent flag: collapsing mid-stream is the
      // user saying "actually, never mind". When SSE finishes, the no-early-open
      // path runs and the standard `reviewOutlineEnabled` / auto-continue rules
      // decide what happens next. There is no parked promise to settle yet —
      // the promise is created only after SSE completes (see line 583).
      outlineReviewIntentRef.current = false;
      persistSession({ ...session, previewPhase: 'preparing' });
      setStatusMessage('');
      return;
    }
    const collapsedOutlines = session.sceneOutlines ?? streamingOutlines;
    if (!collapsedOutlines || collapsedOutlines.length === 0) return;
    outlineReviewIntentRef.current = false;
    persistSession({
      ...session,
      sceneOutlines: collapsedOutlines,
      previewPhase: 'outline-ready',
    });
    setStatusMessage(t('generation.reviewOutlineAutoContinue'));

    // Re-arm the auto-continue timer. The SSE-completion flow is parked inside
    // `waitForOutlineReviewChoice` (because `shouldReview` was true when the
    // user opened the editor) — fire its resolve via a fresh timeout to match
    // the no-review path's pacing.
    clearOutlineReviewTimer();
    outlineReviewTimerRef.current = setTimeout(() => {
      outlineReviewTimerRef.current = null;
      if (!generationRuntimeRef.current?.canAcceptIntent) return;
      const resolve = outlineReviewResolveRef.current;
      outlineReviewResolveRef.current = null;
      if (resolve) {
        resolve(collapsedOutlines);
        return;
      }
      // No parked promise (e.g. session was restored from a refresh into
      // 'review' state). Drive the transition ourselves.
      const confirmedSession: GenerationSessionState = {
        ...session,
        sceneOutlines: collapsedOutlines,
        previewPhase: 'generating-content',
      };
      persistSession(confirmedSession);
      hasStartedRef.current = true;
      void startGeneration(confirmedSession);
    }, OUTLINE_REVIEW_AUTO_CONTINUE_MS);
  };

  const handleOutlinesChange = (outlines: SceneOutline[]) => {
    if (sessionRef.current?.generationBackend === 'server-job') {
      outlineDraftRef.current = outlines;
      persistSession({ ...sessionRef.current, sceneOutlines: outlines, previewPhase: 'review' });
      void queueBackgroundOutlineCommand({ reviewHold: true, outlines });
      return;
    }
    if (!generationRuntimeRef.current?.canAcceptIntent) return;
    if (!session) return;
    // Streaming SSE owns `streamingOutlines` while it's running; ignore editor
    // changes until the stream completes (the editor is read-only in that state
    // anyway, but guard defensively against any racy event).
    if (isOutlineStreaming) return;
    persistSession({
      ...session,
      sceneOutlines: outlines,
      previewPhase: 'review',
    });
  };

  const handleConfirmOutlines = () => {
    if (sessionRef.current?.generationBackend === 'server-job') {
      setIsConfirmingOutlines(true);
      void queueBackgroundOutlineCommand({ confirm: true }).finally(() =>
        setIsConfirmingOutlines(false),
      );
      return;
    }
    if (!generationRuntimeRef.current?.canAcceptIntent) return;
    const finalOutlines = session?.sceneOutlines ?? streamingOutlines;
    if (!finalOutlines || finalOutlines.length === 0) return;
    setIsConfirmingOutlines(true);
    clearOutlineReviewTimer();
    outlineReviewIntentRef.current = false;

    if (outlineReviewResolveRef.current) {
      const resolve = outlineReviewResolveRef.current;
      outlineReviewResolveRef.current = null;
      resolve(finalOutlines);
      return;
    }

    // Fallback: no parked promise (session restored mid-review). The button's
    // loading state was set above to give the click immediate feedback, but the
    // editor is about to unmount anyway as we drive the next phase ourselves.
    // Reset the flag so the state doesn't linger if `startGeneration` later
    // re-renders the editor for any reason.
    setIsConfirmingOutlines(false);
    const confirmedSession: GenerationSessionState = {
      ...(session as GenerationSessionState),
      sceneOutlines: finalOutlines,
      previewPhase: 'generating-content',
    };
    persistSession(confirmedSession);
    hasStartedRef.current = true;
    void startGeneration(confirmedSession);
  };

  // Still loading session from sessionStorage
  if (!sessionLoaded) {
    return (
      <div className="flex min-h-[100dvh] w-full items-center justify-center bg-background p-4">
        <div className="text-center text-muted-foreground" role="status">
          <ZhiyuLockup className="mb-6" />
          <div className="mx-auto size-8 animate-spin rounded-full border-2 border-[color:var(--zhiyu-ai)] border-t-transparent motion-reduce:animate-none" />
          <p className="mt-4 text-sm">{t('generation.aiWorking')}</p>
        </div>
      </div>
    );
  }

  // No session found
  if (!session) {
    return (
      <div className="flex min-h-[100dvh] w-full items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md rounded-[22px] border-border/70 p-8 shadow-[0_16px_44px_rgba(30,48,39,0.08)]">
          <div className="text-center space-y-4">
            <ZhiyuLockup className="mb-7 justify-center" />
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted/60">
              <AlertCircle className="size-7 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-semibold">{t('generation.sessionNotFound')}</h2>
            <p className="text-sm text-muted-foreground">{t('generation.sessionNotFoundDesc')}</p>
            <Button onClick={() => router.push('/')} className="w-full">
              <ArrowLeft className="size-4 mr-2" />
              {t('generation.backToHome')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const activeStep =
    activeSteps.length > 0
      ? activeSteps[Math.min(currentStepIndex, activeSteps.length - 1)]
      : ALL_STEPS[0];
  const activeStepText = getGenerationStepText(activeStep, session);
  const observedBackgroundJob =
    backgroundObservation.job?.jobId === session.generationJobId
      ? backgroundObservation.job
      : backgroundJobRef.current?.jobId === session.generationJobId
        ? backgroundJobRef.current
        : null;
  const jobPresentation =
    session.generationBackend === 'server-job'
      ? projectGenerationJobPresentation({
          job: observedBackgroundJob,
          observationError: backgroundObservation.error,
          cancelling: backgroundObservation.cancelling,
          cancelError: exitCancelError ?? backgroundObservation.cancelError,
        })
      : null;
  const jobStatusTitle = jobPresentation ? t(jobPresentation.titleKey) : null;
  const jobStatusDetail = jobPresentation
    ? t(jobPresentation.detailKey, jobPresentation.detailValues)
    : null;
  const requiresNewSubmission = ['QUEUE_WAIT_EXPIRED', 'OUTLINE_REVIEW_EXPIRED'].includes(
    observedBackgroundJob?.lastErrorCode ?? '',
  );
  const exitDialog = (
    <GenerationExitDialog
      open={showExitDialog}
      cancelling={backgroundObservation.cancelling}
      cancelError={exitCancelError ?? backgroundObservation.cancelError}
      onContinueInBackground={continueInBackgroundAndReturn}
      onCancelAndReturn={() => void cancelBackgroundAndReturn()}
      onStay={() => {
        setShowExitDialog(false);
        setExitCancelError(null);
      }}
    />
  );

  if (isReviewingOutlines) {
    const outlineStepIndex = Math.max(
      0,
      activeSteps.findIndex((step) => step.id === 'outline'),
    );
    // Editor source-of-truth: prefer the persisted final list; fall back to the
    // live streaming buffer so the editor can render mid-stream after expansion.
    const editorOutlines = session.sceneOutlines ?? streamingOutlines ?? [];

    return (
      <>
        <div className="min-h-[100dvh] w-full bg-background">
          <header className="border-b border-border/70 bg-background/92 px-4 backdrop-blur md:px-7">
            <div className="mx-auto flex min-h-16 w-full max-w-5xl items-center justify-between gap-4">
              <ZhiyuLockup size="sm" />
              <Button
                variant="ghost"
                size="sm"
                onClick={goBackToHome}
                disabled={isConfirmingOutlines}
              >
                <ArrowLeft className="mr-2 size-4" />
                {t('generation.backToHome')}
              </Button>
            </div>
          </header>

          <div className="mx-auto w-full max-w-5xl px-4 pb-8 pt-8 md:px-7">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <div className="flex justify-center gap-2">
                {activeSteps.map((step, idx) => (
                  <div
                    key={step.id}
                    className={cn(
                      'h-1.5 rounded-full transition-all duration-500',
                      idx < outlineStepIndex
                        ? 'w-1.5 bg-blue-500/30'
                        : idx === outlineStepIndex
                          ? 'w-8 bg-blue-500'
                          : 'w-1.5 bg-muted/50',
                    )}
                  />
                ))}
              </div>

              <div className="max-w-2xl space-y-2 text-center mx-auto">
                {jobStatusTitle ? (
                  <p className="text-sm font-medium text-[color:var(--zhiyu-ai)]" role="status">
                    {jobStatusTitle}
                  </p>
                ) : null}
                <h2 className="text-2xl font-bold tracking-tight">
                  {t('generation.reviewOutlineTitle')}
                </h2>
                <p className="text-muted-foreground text-sm md:text-base">
                  {isOutlineStreaming
                    ? t('generation.reviewOutlineStreamingDesc')
                    : t('generation.reviewOutlineDesc')}
                </p>
              </div>

              {error && (
                <div className="mx-auto max-w-2xl rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-300">
                  {error}
                </div>
              )}

              <OutlinesEditor
                outlines={editorOutlines}
                onChange={handleOutlinesChange}
                onConfirm={handleConfirmOutlines}
                onBack={goBackToHome}
                alwaysReview={reviewOutlineEnabled}
                onAlwaysReviewChange={setReviewOutlineEnabled}
                isLoading={isConfirmingOutlines}
                isStreaming={isOutlineStreaming}
                onCollapse={handleCollapseEditor}
              />
            </motion.div>
          </div>
        </div>
        {exitDialog}
      </>
    );
  }

  const outlineReady = (session.sceneOutlines ?? streamingOutlines ?? []).length > 0;
  const agentStepIndex = activeSteps.findIndex((step) => step.id === 'agent-generation');
  const agentsReady =
    outlineReady &&
    (agentStepIndex < 0 || currentStepIndex > agentStepIndex || generatedAgents.length > 0);
  const errorStage = error
    ? activeStep.id === 'agent-generation'
      ? 'agents'
      : activeStep.id === 'slide-content'
        ? 'scenes'
        : activeStep.id === 'actions'
          ? 'media'
          : 'outline'
    : null;
  const contentStepIndex = activeSteps.findIndex((step) => step.id === 'slide-content');
  const currentGenerationSceneCount =
    observedBackgroundJob?.displayProgress?.content.completed ??
    (contentStepIndex >= 0 && currentStepIndex >= contentStepIndex ? generatedSceneCount : 0);
  const currentGeneratedScene =
    contentStepIndex >= 0 && currentStepIndex >= contentStepIndex ? generatedScene : undefined;
  const previewOutlines = session.sceneOutlines ?? streamingOutlines ?? [];
  const scenesStarted =
    canonicalPhase === 'scene-generation' ||
    canonicalPhase === 'media-actions' ||
    canonicalPhase === 'completed';
  const zhiyuSteps = projectZhiyuGenerationSteps({
    phase: canonicalPhase,
    outlineReady,
    agentsReady,
    generatedSceneCount: currentGenerationSceneCount,
    totalSceneCount: session.sceneOutlines?.length ?? streamingOutlines?.length ?? 0,
    scenesStarted,
    mediaPending: canonicalPhase === 'scene-generation' || canonicalPhase === 'media-actions',
    errorStage,
    displayProgress: observedBackgroundJob?.displayProgress,
    jobStatus: observedBackgroundJob?.status,
  });
  const courseTitle =
    session.courseTitle || extractTopicFromRequirement(session.requirements.requirement);

  return (
    <>
      <ZhiyuGenerationShell
        title={`${t(activeStepText.title, activeStepText.titleValues)} · ${courseTitle}`}
        steps={zhiyuSteps}
        statusTitle={jobStatusTitle ?? undefined}
        statusDetail={jobStatusDetail ?? undefined}
        terminal={jobPresentation?.terminal}
        actions={
          <Button variant="ghost" size="sm" onClick={goBackToHome}>
            <ArrowLeft className="mr-2 size-4" />
            {t('generation.backToHome')}
          </Button>
        }
        preview={
          <div className="flex min-h-[480px] flex-col">
            <div className="flex items-center justify-between gap-4 border-b border-border/70 px-5 py-4 md:px-7">
              <div className="min-w-0">
                {!jobPresentation?.terminal ? (
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {t('generation.aiWorking')}
                  </p>
                ) : null}
                <h2 className="mt-1 truncate text-lg font-semibold">
                  {jobStatusTitle ??
                    (error
                      ? t('generation.generationFailed')
                      : t(activeStepText.title, activeStepText.titleValues))}
                </h2>
              </div>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center bg-muted/25 px-5 py-8 md:px-8">
              <div className="flex min-h-64 w-full max-w-2xl items-center justify-center rounded-[18px] border border-border/70 bg-background p-6 shadow-[0_12px_36px_rgba(30,48,39,0.07)]">
                <AnimatePresence mode="popLayout">
                  {error ? (
                    <motion.div
                      key="error"
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="flex size-28 items-center justify-center rounded-full bg-[color:var(--zhiyu-coral-soft)]"
                    >
                      <AlertCircle className="size-14 text-[color:var(--zhiyu-coral)]" />
                    </motion.div>
                  ) : currentGeneratedScene?.type === 'slide' &&
                    currentGeneratedScene.content.type === 'slide' ? (
                    <motion.div
                      key={currentGeneratedScene.id}
                      initial={{ scale: 0.96, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="aspect-video w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-sm"
                    >
                      <SlideThumbnail
                        slide={currentGeneratedScene.content.canvas}
                        sceneId={currentGeneratedScene.id}
                        viewportRatio={currentGeneratedScene.content.canvas.viewportRatio ?? 0.5625}
                      />
                    </motion.div>
                  ) : currentGeneratedScene ? (
                    <motion.div
                      key={currentGeneratedScene.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="w-full max-w-xl rounded-2xl border border-border/70 bg-card p-6"
                    >
                      <h3 className="text-xl font-semibold">{currentGeneratedScene.title}</h3>
                    </motion.div>
                  ) : previewOutlines.length > 0 ? (
                    <ZhiyuGenerationTopicCards
                      key="outline-preview"
                      outlines={previewOutlines}
                      rotating={
                        canonicalPhase === 'agent-generation' ||
                        canonicalPhase === 'scene-generation' ||
                        canonicalPhase === 'media-actions'
                      }
                      onExpand={
                        activeStep.id === 'outline' ? handleExpandStreamingOutline : undefined
                      }
                    />
                  ) : (
                    <motion.div
                      key="preparing"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="w-full max-w-md"
                    >
                      <ZhiyuLearningVisual className="mx-auto max-w-[320px]" />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="mt-6 w-full max-w-2xl rounded-2xl border border-border/70 bg-card px-5 py-4">
                <p className="text-sm leading-6 text-muted-foreground">
                  {jobStatusDetail ??
                    (error ? error : statusMessage || t(activeStepText.description))}
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {truncationWarnings.length > 0 && !error ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex min-h-9 items-center gap-2 rounded-full border border-[color:var(--zhiyu-learning)]/25 bg-[color:var(--zhiyu-learning-soft)] px-3 text-xs font-medium text-[color:var(--zhiyu-learning)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <AlertTriangle className="size-3.5" />
                          {truncationWarnings.length}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={6}>
                        <div className="space-y-1 py-0.5">
                          {truncationWarnings.map((warning, index) => (
                            <p key={index} className="text-xs leading-relaxed">
                              {warning}
                            </p>
                          ))}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  ) : null}

                  {generatedAgents.length > 0 && !showAgentReveal ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setShowAgentReveal(true)}
                      className="rounded-full border-[color:var(--zhiyu-lavender)]/25 bg-[color:var(--zhiyu-lavender-soft)] text-[color:var(--zhiyu-lavender)] hover:bg-[color:var(--zhiyu-lavender-soft)]"
                    >
                      <Bot className="mr-2 size-3.5" />
                      {t('generation.viewAgents')}
                    </Button>
                  ) : null}

                  {error ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={
                        requiresNewSubmission ? continueInBackgroundAndReturn : handleGoBackAndRetry
                      }
                    >
                      {t(
                        requiresNewSubmission
                          ? 'generation.backToHome'
                          : 'generation.goBackAndRetry',
                      )}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        }
      />

      <AgentRevealModal
        agents={generatedAgents}
        open={showAgentReveal}
        onClose={() => setShowAgentReveal(false)}
        onAllRevealed={() => {
          agentRevealResolveRef.current?.();
          agentRevealResolveRef.current = null;
        }}
      />
      {exitDialog}
    </>
  );
}

export function GenerationSessionController() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[100dvh] w-full items-center justify-center bg-background">
          <div className="animate-pulse space-y-4 text-center">
            <ZhiyuLockup />
            <div className="mx-auto h-2 w-40 rounded-full bg-muted" />
          </div>
        </div>
      }
    >
      <GenerationPreviewContent />
    </Suspense>
  );
}

export default GenerationSessionController;
