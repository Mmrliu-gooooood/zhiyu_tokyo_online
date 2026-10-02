'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  nextChatUpdatedAt,
  withChatSegmentReveal,
  withChatSessionStatus,
  type ChatSession,
  type SessionType,
  type SessionStatus,
  type ChatMessageMetadata,
  type DirectorState,
  type PiSessionBoundaryContext,
  type StatelessEvent,
  type SlideElementReference,
} from '@/lib/types/chat';
import type { InteractionMode } from '@/lib/chat/interaction-mode';
import type {
  GuidedInteractionMode,
  GuidedLearningContext,
  GuidedLearningOutcome,
} from '@/lib/learning/guided-contracts';
import type { DiscussionRequest } from '@/components/roundtable';
import type { Action, SpotlightAction, DiscussionAction } from '@/lib/types/action';
import type { UIMessage } from 'ai';
import type { ThinkingConfig } from '@/lib/types/provider';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore, type SettingsState } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig, modelRequestBodyFields } from '@/lib/utils/model-config';
import { USER_AVATAR } from '@/lib/types/roundtable';
import { StreamBuffer } from '@/lib/buffer/stream-buffer';
import type { AgentStartItem, ActionItem } from '@/lib/buffer/stream-buffer';
import { runAgentLoop, type AgentLoopStoreState } from '@/lib/chat/agent-loop';
import { runGuidedSingleRequest } from '@/lib/chat/guided-request';
import { appendLearningDialogueFact } from '@/lib/learning/guided-runtime';
import { isGuidedLearningContextCurrent } from '@/lib/learning/guided-current';
import { ActionEngine } from '@/lib/action/engine';
import {
  buildQuizResultsForStoreState,
  didActiveSceneRemainUnchanged,
} from '@/lib/chat/quiz-results-for-store-state';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';
import { isPiChatEnabled } from '@/lib/config/feature-flags';
import { isGuidedLearningEnabled, isTeachBackEnabled } from '@/lib/learning/feature-flags';
import {
  TeachBackSession,
  isTeachBackFollowUpRequest,
  shouldRouteToTeachBack,
  shouldSkipAgentLoopForTeachBack,
  type TeachBackHost,
  type TeachBackView,
} from '@/lib/chat/teach-back-session';
import type {
  TeachBackErrorCode,
  TeachBackPeer,
  TeachBackSource,
} from '@/lib/learning/teach-back/contracts';
import { buildTeachBackSource } from '@/lib/learning/teach-back/source';
import type { TeachBackProjectedActivity } from '@/lib/learning/teach-back/activity';
import type { CleanupSource } from '@/lib/playback/auto-resume';
import { nanoid } from 'nanoid';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';
import { getPersistenceRequestHeaders } from '@/lib/persistence/bootstrap';
import { refreshWhiteboardRuntimeProjection } from '@/lib/whiteboard/runtime/browser-projection';

const log = createLogger('ChatSessions');
const SOFT_CLOSE_TIMEOUT_MS = 15_000;

export interface SoftCloseRegistration {
  token: string;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  endReason?: string;
  directorState?: DirectorState;
}

export function takeSoftCloseRegistration(
  registrations: Map<string, SoftCloseRegistration>,
  sessionId: string,
  expectedToken?: string,
): SoftCloseRegistration | undefined {
  const registration = registrations.get(sessionId);
  if (!registration || (expectedToken && registration.token !== expectedToken)) return undefined;
  registrations.delete(sessionId);
  clearTimeout(registration.timer);
  return registration;
}

/** Context used by playback cleanup and optional lecture auto-resume. */
export interface SessionCleanupPayload {
  sessionId: string;
  endReason?: string;
  source: CleanupSource;
}

export interface EndSessionOptions {
  source?: CleanupSource;
}

export const MANUAL_STOP_END_OPTIONS: EndSessionOptions = { source: 'manual_stop' };

export interface PreviousLiveSessionContext {
  endSource?: CleanupSource;
  sceneId?: string;
}

export function createPreviousLiveSessionContext(
  session: Pick<ChatSession, 'sceneId'>,
  currentSceneId: string | null | undefined,
  endSource?: CleanupSource,
): PreviousLiveSessionContext {
  return {
    endSource,
    sceneId: session.sceneId ?? currentSceneId ?? undefined,
  };
}

export function createPiSessionBoundaryContext(
  previous: PreviousLiveSessionContext | undefined,
  currentSceneId: string | null | undefined,
): PiSessionBoundaryContext {
  return {
    isFirstRequestInLiveSession: true,
    previousEndSource: previous?.endSource,
    sameSceneAsPrevious:
      previous?.sceneId && currentSceneId ? previous.sceneId === currentSceneId : undefined,
  };
}

export function getPiSessionBoundaryContext(
  contexts: Map<string, PiSessionBoundaryContext>,
  sessionId: string,
): PiSessionBoundaryContext | undefined {
  return contexts.get(sessionId);
}

export function consumePiSessionBoundaryContext(
  contexts: Map<string, PiSessionBoundaryContext>,
  sessionId: string,
  expected: PiSessionBoundaryContext,
): boolean {
  if (contexts.get(sessionId) !== expected) return false;
  return contexts.delete(sessionId);
}

interface UseChatSessionsOptions {
  onLiveSpeech?: (
    text: string | null,
    agentId: string | null | undefined,
    producerSessionId: string,
  ) => void;
  onSpeechProgress?: (ratio: number | null, producerSessionId: string) => void;
  onThinking?: (
    state: { stage: string; agentId?: string } | null,
    producerSessionId: string,
  ) => void;
  onCueUser?: (
    fromAgentId: string | undefined,
    prompt: string | undefined,
    producerSessionId: string,
  ) => void;
  onActiveBubble?: (messageId: string | null, producerSessionId: string) => void;
  onLiveSessionError?: (producerSessionId: string) => void;
  /** Called immediately when the server semantically closes a QA/Discussion session. */
  onSoftCloseSession?: (payload: SessionCleanupPayload) => void;
  /** Called when a QA/Discussion session completes naturally (director end). */
  onStopSession?: (payload: SessionCleanupPayload) => void;
  onSegmentSealed?: (
    messageId: string,
    partId: string,
    fullText: string,
    agentId: string | null,
    producerSessionId: string,
  ) => void;
  /** When provided and returns true, StreamBuffer holds on the current text item after reveal. */
  shouldHoldAfterReveal?: () => { holding: boolean; segmentDone: number } | boolean;
  onEnterLiveConversation?: () => void;
  classroomVisible?: boolean;
}

export type ChatRequestTemplate = {
  messages: UIMessage<ChatMessageMetadata>[];
  config: {
    agentIds: string[];
    sessionType?: string;
    agentConfigs?: Record<string, unknown>[];
    piEnableWhiteboardTools?: boolean;
    [key: string]: unknown;
  };
  userProfile?: { nickname?: string; bio?: string };
  apiKey: string;
  baseUrl?: string;
  model?: string;
  providerType?: string;
  modelSource?: 'platform' | 'user' | 'legacy-managed';
  platformDefaultId?: string;
  api?: string;
  endpointProfile?: string;
  endpointParams?: Record<string, string>;
  credentialId?: string;
  thinkingConfig?: ThinkingConfig;
  directorState?: DirectorState;
  piSessionBoundary?: PiSessionBoundaryContext;
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  webSearchBaseUrl?: string;
  webSearchModelId?: string;
  baiduSubSources?: BaiduSubSources;
  elementReference?: SlideElementReference;
  learningContext?: GuidedLearningContext;
};

export interface ChatMessageSendOptions {
  elementReference?: SlideElementReference;
  onResponseAccepted?: (response: Response) => void;
  interactionMode?: InteractionMode;
  learningContext?: GuidedLearningContext;
}

export function resolveInteractionModeForTurn(
  session: Pick<ChatSession, 'config'> | undefined,
  requested: InteractionMode | undefined,
): { interactionMode: InteractionMode; startNewSession: boolean } {
  const current = session?.config.interactionMode ?? 'standard';
  const interactionMode = requested ?? current;
  return {
    interactionMode,
    startNewSession: Boolean(session && requested && requested !== current),
  };
}

/**
 * Bind every guided retry/follow-up to the real input that triggered it.
 * Transport failures leave the previous context on the session, so reusing it
 * would also reuse its request id and make the runtime de-duplicate a new
 * student input as though it were the old one.
 */
export function createGuidedContextForTurn(
  base: GuidedLearningContext | undefined,
  outcome: GuidedLearningOutcome | undefined,
  studentInput: string,
  chatSessionId: string,
  mintRequestId: () => string = nanoid,
): GuidedLearningContext | undefined {
  if (!base) return undefined;
  const requestId = mintRequestId();
  if (outcome?.phase === 'wait_student') {
    return {
      ...base,
      requestId,
      chatSessionId,
      phase: 'feedback',
      studentAnswer: studentInput,
      priorOutcome: outcome,
    };
  }
  if (base.phase === 'feedback' && base.priorOutcome?.phase === 'wait_student') {
    return {
      ...base,
      requestId,
      chatSessionId,
      studentAnswer: studentInput,
      priorOutcome: base.priorOutcome,
    };
  }
  const {
    studentAnswer: _previousStudentAnswer,
    priorOutcome: _previousOutcome,
    ...explainContext
  } = base;
  return {
    ...explainContext,
    requestId,
    chatSessionId,
    phase: 'explain',
  };
}

export interface GuidedRequestProducer {
  stageId: string;
  source: GuidedLearningContext['source'];
  sourceScene?: unknown;
  viewSceneId?: string | null;
  viewScene?: unknown;
}

/** Fast request-owner check used before accepting each guided stream event. */
export function isGuidedProducerCurrent(
  producer: GuidedRequestProducer,
  current: {
    stageId: string | undefined;
    currentSceneId: string | null;
    scenes: readonly unknown[];
  },
): boolean {
  if (current.stageId !== producer.stageId) return false;
  if (producer.viewSceneId !== undefined) {
    if (current.currentSceneId !== producer.viewSceneId) return false;
    if (
      producer.viewSceneId !== null &&
      !current.scenes.some((scene) => scene === producer.viewScene)
    ) {
      return false;
    }
  }
  if (producer.source.kind !== 'scene') return true;
  const sourceSceneId = producer.source.sceneId;
  if (current.currentSceneId !== sourceSceneId) return false;
  return current.scenes.some(
    (scene) =>
      typeof scene === 'object' &&
      scene !== null &&
      'id' in scene &&
      scene.id === sourceSceneId &&
      scene === producer.sourceScene,
  );
}

/**
 * One fresh store-state snapshot for an outgoing chat request. Quiz results
 * come from the async RuntimeStore read; the before/after scene compare drops
 * them when a scene transition raced the read (a stale scene's results must
 * not leak into the next scene's request).
 */
async function buildFreshAgentLoopStoreState(): Promise<AgentLoopStoreState> {
  const stateBeforeQuizRead = useStageStore.getState();
  const quizResults = await buildQuizResultsForStoreState(
    stateBeforeQuizRead.scenes,
    stateBeforeQuizRead.currentSceneId,
  );
  const freshState = useStageStore.getState();
  return {
    stage: freshState.stage,
    scenes: freshState.scenes,
    outlines: freshState.outlines,
    currentSceneId: freshState.currentSceneId,
    mode: freshState.mode,
    whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
    whiteboardManualVisibilityRevision:
      useCanvasStore.getState().whiteboardManualVisibilityRevision,
    quizResults: didActiveSceneRemainUnchanged(
      stateBeforeQuizRead.scenes,
      stateBeforeQuizRead.currentSceneId,
      freshState.scenes,
      freshState.currentSceneId,
    )
      ? quizResults
      : undefined,
  };
}

export function withPiInclassWhiteboardTools<T extends ChatRequestTemplate>(requestTemplate: T): T {
  return {
    ...requestTemplate,
    config: {
      ...requestTemplate.config,
      piEnableWhiteboardTools: true,
    },
  };
}

type PiWebSearchSettings = Pick<
  SettingsState,
  'webSearchProviderId' | 'webSearchProvidersConfig' | 'baiduSubSources'
>;

/** Snapshot only the selected provider fields accepted by the classroom resolver. */
export function withPiWebSearchSettings<T extends ChatRequestTemplate>(
  requestTemplate: T,
  settings: PiWebSearchSettings,
): T {
  const providerId = settings.webSearchProviderId;
  const providerConfig = settings.webSearchProvidersConfig[providerId];
  const request = { ...requestTemplate };
  delete request.webSearchProviderId;
  delete request.webSearchApiKey;
  delete request.webSearchBaseUrl;
  delete request.webSearchModelId;
  delete request.baiduSubSources;
  return {
    ...request,
    webSearchProviderId: providerId,
    ...(providerConfig?.apiKey ? { webSearchApiKey: providerConfig.apiKey } : {}),
    ...(providerConfig?.baseUrl && !providerConfig.isServerConfigured && providerId !== 'searxng'
      ? { webSearchBaseUrl: providerConfig.baseUrl }
      : {}),
    ...(providerId === 'claude' && providerConfig?.modelId
      ? { webSearchModelId: providerConfig.modelId }
      : {}),
    ...(providerId === 'baidu' ? { baiduSubSources: { ...settings.baiduSubSources } } : {}),
  } as T;
}

export function shouldAwaitPresentationAction(actionName: string): boolean {
  return actionName.startsWith('wb_');
}

export async function retireLiveRequestResources<
  T extends { shutdown(): void; waitForCurrentAction?(): Promise<void> },
>(
  controller: AbortController | null,
  sessionId: string | null,
  buffers: Map<string, T>,
): Promise<void> {
  controller?.abort();
  if (!sessionId) return;
  const buffer = buffers.get(sessionId);
  buffer?.shutdown();
  buffers.delete(sessionId);
  await buffer?.waitForCurrentAction?.();
}

type StatelessStreamConsumerFactory = (
  sessionId: string,
  controller: AbortController,
  sessionType: SessionType,
) => {
  onEvent: (event: StatelessEvent) => void;
  onIterationEnd: () => Promise<{
    directorState: DirectorState | undefined;
    totalAgents: number;
    agentHadContent: boolean;
    cueUserReceived?: boolean;
    sessionClosed?: boolean;
    endReason?: string;
  } | null>;
};

export function normalizeStoredSessionsForRestore(sessions: ChatSession[]): ChatSession[] {
  return sessions.map((session) => {
    if (session.status === 'active') {
      return {
        ...withChatSessionStatus(session, 'interrupted'),
        softCloseDeadline: undefined,
      };
    }
    if (session.status === 'soft-closing') {
      return {
        ...withChatSessionStatus(session, 'completed'),
        softCloseDeadline: undefined,
      };
    }
    return session.softCloseDeadline ? { ...session, softCloseDeadline: undefined } : session;
  });
}

function isLiveSessionType(session: Pick<ChatSession, 'type'>): boolean {
  return session.type === 'qa' || session.type === 'discussion';
}

export function isOpenLiveSession(session: Pick<ChatSession, 'type' | 'status'>): boolean {
  return (
    isLiveSessionType(session) && (session.status === 'active' || session.status === 'soft-closing')
  );
}

export function resumeSoftClosingSessionForFollowUp(
  session: ChatSession,
  userMessage: UIMessage<ChatMessageMetadata>,
  now: number,
): ChatSession {
  return {
    ...session,
    messages: [...session.messages, userMessage],
    status: 'active' as SessionStatus,
    endReason: undefined,
    softCloseDeadline: undefined,
    updatedAt: nextChatUpdatedAt(session, now),
  };
}

export function resumeSoftClosingSessionWithoutMessage(
  session: ChatSession,
  now: number,
): ChatSession | undefined {
  if (session.status !== 'soft-closing') return undefined;
  return {
    ...session,
    status: 'active',
    endReason: undefined,
    softCloseDeadline: undefined,
    updatedAt: nextChatUpdatedAt(session, now),
  };
}

export type PiSingleRequestOutcome =
  | { type: 'error'; messageKey: 'chat.error.streamInterrupted' }
  | { type: 'soft_closing'; endReason?: string; directorState?: DirectorState }
  | { type: 'cue_user'; directorState?: DirectorState }
  | { type: 'completed'; directorState?: DirectorState };

export function getPiSingleRequestOutcome(
  doneData: Awaited<ReturnType<ReturnType<StatelessStreamConsumerFactory>['onIterationEnd']>>,
): PiSingleRequestOutcome {
  if (!doneData) {
    return { type: 'error', messageKey: 'chat.error.streamInterrupted' };
  }
  if (doneData.sessionClosed) {
    return {
      type: 'soft_closing',
      endReason: doneData.endReason,
      directorState: doneData.directorState,
    };
  }
  if (doneData.totalAgents === 0 || doneData.agentHadContent === false) {
    return { type: 'error', messageKey: 'chat.error.streamInterrupted' };
  }
  if (doneData.cueUserReceived) {
    return { type: 'cue_user', directorState: doneData.directorState };
  }
  return { type: 'completed', directorState: doneData.directorState };
}

export async function runPiSingleRequest(
  sessionId: string,
  requestTemplate: ChatRequestTemplate & { storeState: AgentLoopStoreState },
  controller: AbortController,
  sessionType: SessionType,
  createConsumer: StatelessStreamConsumerFactory,
  clearLiveSessionAfterError: (sessionId: string, message: string) => void,
  enterSoftClosing: (
    sessionId: string,
    data: { endReason?: string; directorState?: DirectorState },
  ) => void,
  markSessionCompleted: (
    sessionId: string,
    data?: { endReason?: string; directorState?: DirectorState; source?: CleanupSource },
  ) => void,
  storeDirectorState: (sessionId: string, directorState?: DirectorState) => void,
  onStopSessionRef: { current?: ((payload: SessionCleanupPayload) => void) | undefined },
  t: (key: string) => string,
  onResponseAccepted?: (response: Response) => void,
): Promise<void> {
  const consumer = createConsumer(sessionId, controller, sessionType);
  const persistenceHeaders = await getPersistenceRequestHeaders();
  const response = await fetch('/api/chat/pi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...persistenceHeaders },
    body: JSON.stringify(requestTemplate),
    signal: controller.signal,
  });

  if (!response.ok) {
    throw new Error(`Pi chat request failed: ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Pi chat response body is empty');
  }
  onResponseAccepted?.(response);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let sawDoneEvent = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const parts = sseBuffer.split('\n\n');
    sseBuffer = parts.pop() || '';

    for (const part of parts) {
      if (!part.trim() || part.startsWith(':')) continue;
      const dataLine = part.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(6)) as StatelessEvent;
      if (event.type === 'done') sawDoneEvent = true;
      consumer.onEvent(event);
    }
  }

  const doneData = sawDoneEvent ? await consumer.onIterationEnd() : null;

  if (controller.signal.aborted) return;

  const outcome = getPiSingleRequestOutcome(doneData);
  if (outcome.type === 'error') {
    clearLiveSessionAfterError(sessionId, t(outcome.messageKey));
    onStopSessionRef.current?.({ sessionId, source: 'error' });
    return;
  }

  if (outcome.type === 'soft_closing') {
    enterSoftClosing(sessionId, {
      endReason: outcome.endReason,
      directorState: outcome.directorState,
    });
    return;
  }

  if (outcome.type === 'cue_user') {
    storeDirectorState(sessionId, outcome.directorState);
    return;
  }

  // The Pi endpoint owns the whole server-side loop; one successful done closes
  // this classroom turn instead of asking the frontend to POST another turn.
  markSessionCompleted(sessionId, {
    directorState: outcome.directorState,
    source: 'turn_complete',
  });
  onStopSessionRef.current?.({ sessionId, source: 'turn_complete' });
}

export async function respondToWhiteboardVisibilityQuery(
  data: Extract<StatelessEvent, { type: 'whiteboard' }>['data'] & {
    kind: 'visibility_query';
  },
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || useStageStore.getState().stage?.id !== data.stageId) return;
  const headers = await getPersistenceRequestHeaders();
  if (signal.aborted || useStageStore.getState().stage?.id !== data.stageId) return;
  const visibility = useCanvasStore.getState().whiteboardOpen ? 'open' : 'closed';
  const response = await fetch('/api/chat/pi/whiteboard-visibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      queryId: data.queryId,
      stageId: data.stageId,
      visibility,
    }),
    signal,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Whiteboard visibility response failed: ${response.status}`);
  }
}

export function consumePiWhiteboardEvent(
  data: Extract<StatelessEvent, { type: 'whiteboard' }>['data'],
  signal: AbortSignal,
): void {
  if (signal.aborted || useStageStore.getState().stage?.id !== data.stageId) return;
  if (data.kind === 'visibility_query') {
    void respondToWhiteboardVisibilityQuery(data, signal).catch((error) => {
      if (!signal.aborted) log.warn('Whiteboard visibility response failed', error);
    });
    return;
  }
  if (data.kind === 'projection') {
    void refreshWhiteboardRuntimeProjection(data.stageId, data.lastSeq);
    return;
  }
  const canvas = useCanvasStore.getState();
  if (canvas.whiteboardManualVisibilityRevision !== data.manualVisibilityRevision) return;
  canvas.setWhiteboardOpen(data.kind === 'open');
}

export function useChatSessions(options: UseChatSessionsOptions = {}) {
  const onLiveSpeechRef = useRef(options.onLiveSpeech);
  const onSpeechProgressRef = useRef(options.onSpeechProgress);
  const onThinkingRef = useRef(options.onThinking);
  const onCueUserRef = useRef(options.onCueUser);
  const onActiveBubbleRef = useRef(options.onActiveBubble);
  const onLiveSessionErrorRef = useRef(options.onLiveSessionError);
  const onSoftCloseSessionRef = useRef(options.onSoftCloseSession);
  const onStopSessionRef = useRef(options.onStopSession);
  const onSegmentSealedRef = useRef(options.onSegmentSealed);
  const shouldHoldAfterRevealRef = useRef(options.shouldHoldAfterReveal);
  const onEnterLiveConversationRef = useRef(options.onEnterLiveConversation);
  const classroomVisibleRef = useRef(options.classroomVisible ?? true);
  useEffect(() => {
    onLiveSpeechRef.current = options.onLiveSpeech;
    onSpeechProgressRef.current = options.onSpeechProgress;
    onThinkingRef.current = options.onThinking;
    onCueUserRef.current = options.onCueUser;
    onActiveBubbleRef.current = options.onActiveBubble;
    onLiveSessionErrorRef.current = options.onLiveSessionError;
    onSoftCloseSessionRef.current = options.onSoftCloseSession;
    onStopSessionRef.current = options.onStopSession;
    onSegmentSealedRef.current = options.onSegmentSealed;
    shouldHoldAfterRevealRef.current = options.shouldHoldAfterReveal;
    onEnterLiveConversationRef.current = options.onEnterLiveConversation;
    classroomVisibleRef.current = options.classroomVisible ?? true;
  }, [
    options.onLiveSpeech,
    options.onSpeechProgress,
    options.onThinking,
    options.onCueUser,
    options.onActiveBubble,
    options.onLiveSessionError,
    options.onSoftCloseSession,
    options.onStopSession,
    options.onSegmentSealed,
    options.shouldHoldAfterReveal,
    options.onEnterLiveConversation,
    options.classroomVisible,
  ]);
  const { t, locale } = useI18n();

  // Track current stageId for data isolation
  const stageId = useStageStore((s) => s.stage?.id);
  const stageScenes = useStageStore((s) => s.scenes);
  const stageIdRef = useRef(stageId);
  const currentSceneId = useStageStore((s) => s.currentSceneId);
  const currentSceneIdRef = useRef(currentSceneId);

  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    // Restore sessions from store (loaded from IndexedDB)
    const stored = useStageStore.getState().chats;
    return normalizeStoredSessionsForRestore(stored);
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(new Set());
  const [isStreaming, setIsStreaming] = useState(false);
  const [teachBackView, setTeachBackView] = useState<TeachBackView>({ activity: null, ui: 'idle' });
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingSessionIdRef = useRef<string | null>(null);
  const activeGuidedProducerRef = useRef<
    | {
        controller: AbortController;
        sessionId: string;
        producer: GuidedRequestProducer;
      }
    | undefined
  >(undefined);
  const softCloseRegistrationsRef = useRef<Map<string, SoftCloseRegistration>>(new Map());
  const softCloseLifecycleRef = useRef<Map<string, 'soft-closing' | 'active' | 'completed'>>(
    new Map(),
  );
  const sessionsRef = useRef<ChatSession[]>(sessions);
  const previousLiveSessionRef = useRef<PreviousLiveSessionContext | undefined>(undefined);
  const piSessionBoundariesRef = useRef<Map<string, PiSessionBoundaryContext>>(new Map());
  const teachBackHostRef = useRef<TeachBackHost>({} as TeachBackHost);
  const teachBackRef = useRef<TeachBackSession | null>(null);
  const teachBackViewEpochRef = useRef(0);
  const continueTeachBackRoundRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Per-loop-iteration state — tracks done event data and cue_user for the agent loop
  const loopDoneDataRef = useRef<{
    directorState?: DirectorState;
    totalAgents: number;
    agentHadContent?: boolean;
    cueUserReceived: boolean;
    sessionClosed?: boolean;
    endReason?: string;
  } | null>(null);

  const registerFirstPiRequest = useCallback((sessionId: string) => {
    piSessionBoundariesRef.current.set(
      sessionId,
      createPiSessionBoundaryContext(previousLiveSessionRef.current, currentSceneIdRef.current),
    );
  }, []);

  const getFirstPiRequestContext = useCallback((sessionId: string) => {
    return getPiSessionBoundaryContext(piSessionBoundariesRef.current, sessionId);
  }, []);

  // Sync sessions back to store for persistence (debounced via store's debouncedSave)
  // Guard: only write to the currently active stage
  useEffect(() => {
    if (stageIdRef.current && stageIdRef.current === useStageStore.getState().stage?.id) {
      useStageStore.getState().setChats(sessions);
    }
  }, [sessions]);

  // StreamBuffer instances per session (SSE + lecture share the same buffer model)
  const buffersRef = useRef<Map<string, StreamBuffer>>(new Map());
  const pendingRetirementRef = useRef<Promise<void>>(Promise.resolve());

  const retireActiveLiveRequest = useCallback(
    (fallbackSessionId?: string | null): string | null => {
      const interruptedSessionId = streamingSessionIdRef.current ?? fallbackSessionId ?? null;
      const previousRetirement = pendingRetirementRef.current;
      const retirement = retireLiveRequestResources(
        abortControllerRef.current,
        interruptedSessionId,
        buffersRef.current,
      );
      pendingRetirementRef.current = Promise.all([previousRetirement, retirement]).then(
        () => undefined,
      );
      abortControllerRef.current = null;
      streamingSessionIdRef.current = null;
      setIsStreaming(false);
      return interruptedSessionId;
    },
    [],
  );

  const retireActiveGuidedRequest = useCallback(() => {
    const active = activeGuidedProducerRef.current;
    if (!active) return;
    activeGuidedProducerRef.current = undefined;
    retireActiveLiveRequest(active.sessionId);
  }, [retireActiveLiveRequest]);

  // Reload sessions when stage changes (course switch). A guided producer is
  // retired before the new stage's chat projection can become visible.
  useEffect(() => {
    if (stageId === stageIdRef.current) return;
    retireActiveGuidedRequest();
    stageIdRef.current = stageId;
    softCloseRegistrationsRef.current.forEach(({ timer }) => clearTimeout(timer));
    softCloseRegistrationsRef.current.clear();
    softCloseLifecycleRef.current.clear();
    const stored = useStageStore.getState().chats;
    setSessions(normalizeStoredSessionsForRestore(stored));
    setActiveSessionId(null);
    setExpandedSessionIds(new Set());
    previousLiveSessionRef.current = undefined;
    piSessionBoundariesRef.current.clear();
  }, [retireActiveGuidedRequest, stageId]);

  useEffect(() => {
    currentSceneIdRef.current = currentSceneId;
    const active = activeGuidedProducerRef.current;
    if (
      active &&
      !isGuidedProducerCurrent(active.producer, {
        stageId,
        currentSceneId,
        scenes: stageScenes,
      })
    ) {
      retireActiveGuidedRequest();
    }
  }, [currentSceneId, retireActiveGuidedRequest, stageId, stageScenes]);

  useEffect(() => {
    teachBackViewEpochRef.current += 1;
    const producer = teachBackRef.current?.getProducer();
    if (producer && (producer.sceneId !== currentSceneId || producer.stageId !== stageId)) {
      void teachBackRef.current?.suspend('scene_switch');
    }
  }, [currentSceneId, stageId]);

  useEffect(() => {
    if (options.classroomVisible === false) {
      teachBackRef.current?.abortActiveRequest();
      void teachBackRef.current?.suspend('hidden');
    }
  }, [options.classroomVisible]);

  // Abort active stream and destroy buffers on unmount
  useEffect(() => {
    const buffers = buffersRef.current;
    const softCloseRegistrations = softCloseRegistrationsRef.current;
    const softCloseLifecycle = softCloseLifecycleRef.current;
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      softCloseRegistrations.forEach(({ timer }) => clearTimeout(timer));
      softCloseRegistrations.clear();
      softCloseLifecycle.clear();
      buffers.forEach((buf) => buf.shutdown());
      buffers.clear();
    };
  }, []);

  const claimSoftCloseRegistration = useCallback(
    (sessionId: string, expectedToken?: string): SoftCloseRegistration | undefined => {
      return takeSoftCloseRegistration(softCloseRegistrationsRef.current, sessionId, expectedToken);
    },
    [],
  );

  const clearSoftCloseRegistration = useCallback(
    (sessionId: string): boolean => {
      return Boolean(claimSoftCloseRegistration(sessionId));
    },
    [claimSoftCloseRegistration],
  );

  const markSessionCompleted = useCallback(
    (
      sessionId: string,
      data?: { endReason?: string; directorState?: DirectorState; source?: CleanupSource },
    ) => {
      const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
      if (session && isLiveSessionType(session)) {
        previousLiveSessionRef.current = createPreviousLiveSessionContext(
          session,
          currentSceneIdRef.current,
          data?.source,
        );
      }
      piSessionBoundariesRef.current.delete(sessionId);
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'completed' as SessionStatus,
                updatedAt: Date.now(),
                endReason: data?.endReason ?? s.endReason,
                softCloseDeadline: undefined,
                directorState: data?.directorState ?? s.directorState,
              }
            : s,
        ),
      );
    },
    [],
  );

  const finishSoftCloseTimeout = useCallback(
    (sessionId: string, expectedToken?: string): boolean => {
      const registration = claimSoftCloseRegistration(sessionId, expectedToken);
      if (!registration || softCloseLifecycleRef.current.get(sessionId) !== 'soft-closing') {
        return false;
      }
      softCloseLifecycleRef.current.set(sessionId, 'completed');

      const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
      pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
        () => undefined,
      );
      markSessionCompleted(sessionId, {
        endReason: registration.endReason,
        directorState: registration.directorState,
        source: 'soft_close_timeout',
      });
      onStopSessionRef.current?.({
        sessionId,
        endReason: registration.endReason,
        source: 'soft_close_timeout',
      });
      return true;
    },
    [claimSoftCloseRegistration, markSessionCompleted],
  );

  const storeDirectorState = useCallback((sessionId: string, directorState?: DirectorState) => {
    if (!directorState) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              directorState,
              updatedAt: nextChatUpdatedAt(s),
            }
          : s,
      ),
    );
  }, []);

  const enterSoftClosing = useCallback(
    (sessionId: string, data: { endReason?: string; directorState?: DirectorState }) => {
      clearSoftCloseRegistration(sessionId);
      const token = nanoid();
      const deadline = Date.now() + SOFT_CLOSE_TIMEOUT_MS;
      softCloseLifecycleRef.current.set(sessionId, 'soft-closing');
      // Entering the soft-closing window is NOT the timeout — only the 15s timer
      // firing below counts as soft_close_timeout (the auto-resume trigger).
      onSoftCloseSessionRef.current?.({
        sessionId,
        endReason: data.endReason,
        source: 'soft_close_enter',
      });
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'soft-closing' as SessionStatus,
                updatedAt: Date.now(),
                endReason: data.endReason ?? s.endReason,
                softCloseDeadline: deadline,
                directorState: data.directorState ?? s.directorState,
              }
            : s,
        ),
      );

      const timer = setTimeout(() => {
        finishSoftCloseTimeout(sessionId, token);
      }, SOFT_CLOSE_TIMEOUT_MS);

      softCloseRegistrationsRef.current.set(sessionId, {
        token,
        deadline,
        timer,
        endReason: data.endReason,
        directorState: data.directorState,
      });
    },
    [clearSoftCloseRegistration, finishSoftCloseTimeout],
  );

  useEffect(() => {
    const reconcileExpiredSoftClose = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      for (const [sessionId, registration] of softCloseRegistrationsRef.current) {
        if (now >= registration.deadline) {
          finishSoftCloseTimeout(sessionId, registration.token);
        }
      }
    };
    document.addEventListener('visibilitychange', reconcileExpiredSoftClose);
    return () => document.removeEventListener('visibilitychange', reconcileExpiredSoftClose);
  }, [finishSoftCloseTimeout]);

  // Session-scoped "paused intent" — survives buffer recreation across turns.
  // When true, newly created discussion/QA buffers are immediately paused.
  const livePausedRef = useRef(false);

  const clearLiveSessionAfterError = useCallback(
    (sessionId: string, message: string) => {
      const now = Date.now();
      const errorMessageId = `error-${now}`;
      const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
      if (session && isLiveSessionType(session)) {
        previousLiveSessionRef.current = createPreviousLiveSessionContext(
          session,
          currentSceneIdRef.current,
          'error',
        );
      }

      if (streamingSessionIdRef.current === sessionId) {
        retireActiveLiveRequest(sessionId);
      } else {
        const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
        pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
          () => undefined,
        );
      }

      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: 'error' as SessionStatus,
                softCloseDeadline: undefined,
                updatedAt: nextChatUpdatedAt(s, now),
                messages: [
                  ...s.messages,
                  {
                    id: errorMessageId,
                    role: 'assistant' as const,
                    parts: [{ type: 'text', text: message }],
                    metadata: {
                      senderName: 'System',
                      originalRole: 'agent' as const,
                      createdAt: now,
                    },
                  },
                ],
              }
            : s,
        ),
      );

      onActiveBubbleRef.current?.(null, sessionId);
      if (onLiveSessionErrorRef.current) {
        onLiveSessionErrorRef.current(sessionId);
      } else {
        onSpeechProgressRef.current?.(null, sessionId);
        onThinkingRef.current?.(null, sessionId);
        onLiveSpeechRef.current?.(null, null, sessionId);
      }
    },
    [retireActiveLiveRequest],
  );

  // Tracks the single message ID per lecture session
  const lectureMessageIds = useRef<Map<string, string>>(new Map());

  // Tracks last action index per lecture session (avoids stale closure reads)
  const lectureLastActionIndexRef = useRef<Map<string, number>>(new Map());

  const toggleSessionExpand = useCallback((sessionId: string) => {
    setExpandedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  /**
   * Create a StreamBuffer for a session and wire its callbacks to React state.
   * Returns the buffer instance (also stored in buffersRef).
   */
  const createBufferForSession = useCallback(
    (sessionId: string, type?: SessionType): StreamBuffer => {
      // Dispose previous buffer if any
      // Shutdown (not dispose) — avoids stale onLiveSpeech(null,null) callback
      const prev = buffersRef.current.get(sessionId);
      if (prev) prev.shutdown();

      // For discussion/QA sessions, add pacing delays so fast models don't
      // rush through text and actions. Lecture pacing is handled by PlaybackEngine.
      const pacingOptions = type === 'lecture' ? {} : { postTextDelayMs: 1200, actionDelayMs: 800 };

      const buffer = new StreamBuffer(
        {
          onAgentStart(data: AgentStartItem) {
            const now = Date.now();
            const agentConfig = useAgentRegistry.getState().getAgent(data.agentId);
            const newMsg: UIMessage<ChatMessageMetadata> = {
              id: data.messageId,
              role: 'assistant',
              parts: [],
              metadata: {
                senderName: agentConfig?.name || data.agentName,
                senderAvatar: data.avatar || agentConfig?.avatar,
                originalRole: 'agent',
                agentId: data.agentId,
                createdAt: now,
              },
            };
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      messages: [...s.messages, newMsg],
                      updatedAt: nextChatUpdatedAt(s, now),
                    }
                  : s,
              ),
            );
            onActiveBubbleRef.current?.(data.messageId, sessionId);
          },

          onAgentEnd() {
            // Remove empty assistant messages (agent started but produced no content)
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                const msgs = s.messages.filter(
                  (m) => !(m.role === 'assistant' && m.parts.length === 0),
                );
                return msgs.length !== s.messages.length
                  ? { ...s, messages: msgs, updatedAt: nextChatUpdatedAt(s) }
                  : s;
              }),
            );
          },

          onTextReveal(
            messageId: string,
            partId: string,
            revealedText: string,
            isComplete: boolean,
          ) {
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                const revealed = {
                  ...s,
                  messages: s.messages.map((m) => {
                    if (m.id !== messageId) return m;
                    const parts = [...m.parts];
                    // Match by _partId (supports multiple text parts per message, e.g. lecture)
                    const existingIdx = parts.findIndex(
                      (p) => (p as unknown as Record<string, unknown>)._partId === partId,
                    );
                    if (existingIdx >= 0) {
                      parts[existingIdx] = {
                        type: 'text',
                        text: revealedText,
                        _partId: partId,
                      } as UIMessage<ChatMessageMetadata>['parts'][number];
                    } else {
                      parts.push({
                        type: 'text',
                        text: revealedText,
                        _partId: partId,
                      } as UIMessage<ChatMessageMetadata>['parts'][number]);
                    }
                    return { ...m, parts };
                  }),
                  // Don't update updatedAt on every tick — avoids thrashing persistence sync
                };
                return withChatSegmentReveal(revealed, isComplete);
              }),
            );
          },

          async onActionReady(messageId: string, data: ActionItem, signal: AbortSignal) {
            const actionPart = {
              type: `action-${data.actionName}`,
              actionId: data.actionId,
              actionName: data.actionName,
              input: data.params,
              state: 'result',
              output: { success: true },
            } as unknown as UIMessage<ChatMessageMetadata>['parts'][number];
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                return {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === messageId ? { ...m, parts: [...m.parts, actionPart] } : m,
                  ),
                  updatedAt: nextChatUpdatedAt(s),
                };
              }),
            );

            // Whiteboard effects mutate shared stage state after animation delays,
            // so keep them ordered. Long-running media playback stays interruptible.
            try {
              const actionEngine = new ActionEngine(useStageStore);
              const action = {
                id: data.actionId,
                type: data.actionName,
                ...data.params,
              } as Action;
              const execution = actionEngine.execute(action, { signal });
              if (shouldAwaitPresentationAction(data.actionName)) {
                await execution;
              } else {
                void execution.catch((err) => log.warn('[Buffer] Action execution error:', err));
              }
            } catch (err) {
              log.warn('[Buffer] Action execution error:', err);
            }
          },

          onLiveSpeech(text: string | null, agentId: string | null) {
            // Lecture sessions: roundtable text is managed by PlaybackEngine → setLectureSpeech
            // in stage.tsx. Buffer only drives chat area pacing for lectures.
            if (type === 'lecture') return;
            onLiveSpeechRef.current?.(text, agentId, sessionId);
          },

          onSpeechProgress(ratio: number | null) {
            onSpeechProgressRef.current?.(ratio, sessionId);
          },

          onThinking(data: { stage: string; agentId?: string } | null) {
            onThinkingRef.current?.(data, sessionId);
          },

          onCueUser(fromAgentId?: string, prompt?: string) {
            // Track cue_user for agent loop
            if (loopDoneDataRef.current) {
              loopDoneDataRef.current.cueUserReceived = true;
            } else {
              loopDoneDataRef.current = {
                totalAgents: 0,
                cueUserReceived: true,
              };
            }
            onCueUserRef.current?.(fromAgentId, prompt, sessionId);
          },

          onDone(data: {
            totalActions: number;
            totalAgents: number;
            agentHadContent?: boolean;
            cueUserReceived?: boolean;
            sessionClosed?: boolean;
            endReason?: string;
            directorState?: DirectorState;
          }) {
            // Store done data for agent loop consumption
            loopDoneDataRef.current = {
              directorState: data.directorState,
              totalAgents: data.totalAgents,
              agentHadContent: data.agentHadContent ?? true,
              cueUserReceived:
                data.cueUserReceived ?? loopDoneDataRef.current?.cueUserReceived ?? false,
              sessionClosed: data.sessionClosed,
              endReason: data.endReason,
            };
            // Session completion is handled by runAgentLoopFn, not here
            // (Lectures don't use the agent loop and complete via endSession)
          },

          onError(message: string) {
            log.error('[Buffer] Stream error:', message);
          },

          onSegmentSealed(
            messageId: string,
            partId: string,
            fullText: string,
            agentId: string | null,
          ) {
            onSegmentSealedRef.current?.(messageId, partId, fullText, agentId, sessionId);
          },

          shouldHoldAfterReveal() {
            return shouldHoldAfterRevealRef.current?.() ?? (false as const);
          },
        },
        pacingOptions,
      );

      buffersRef.current.set(sessionId, buffer);
      buffer.start();

      // Inherit paused intent for discussion/QA sessions so new-turn buffers
      // don't start revealing text while the user has paused reading.
      if (type !== 'lecture' && livePausedRef.current) {
        buffer.pause();
      }

      return buffer;
    },
    [],
  );

  const createStatelessStreamConsumer = useCallback(
    (sessionId: string, controller: AbortController, sessionType: SessionType) => {
      let currentBuffer: StreamBuffer | null = null;
      let currentMessageId: string | null = null;

      const onEvent = (event: StatelessEvent) => {
        if (event.type === 'whiteboard') {
          consumePiWhiteboardEvent(event.data, controller.signal);
          return;
        }
        if (!currentBuffer) {
          currentBuffer = createBufferForSession(sessionId, sessionType);
        }

        switch (event.type) {
          case 'agent_start': {
            const { messageId, agentId, agentName, agentAvatar, agentColor } = event.data;
            currentMessageId = messageId;
            currentBuffer.pushAgentStart({
              messageId,
              agentId,
              agentName,
              avatar: agentAvatar,
              color: agentColor,
            });
            break;
          }
          case 'agent_end': {
            currentBuffer.pushAgentEnd({
              messageId: event.data.messageId,
              agentId: event.data.agentId,
            });
            break;
          }
          case 'text_delta': {
            const targetId = event.data.messageId ?? currentMessageId;
            if (!targetId) break;
            currentBuffer.pushText(targetId, event.data.content);
            break;
          }
          case 'action': {
            const targetId = event.data.messageId ?? currentMessageId;
            if (!targetId) break;
            if (controller.signal.aborted) break;
            currentBuffer.pushAction({
              actionId: event.data.actionId,
              actionName: event.data.actionName,
              params: event.data.params,
              messageId: targetId,
              agentId: event.data.agentId,
            });
            break;
          }
          case 'thinking':
            currentBuffer.pushThinking(event.data);
            break;
          case 'cue_user':
            currentBuffer.pushCueUser(event.data);
            break;
          case 'done':
            currentBuffer.pushDone(event.data);
            break;
          case 'error':
            currentBuffer.pushError(event.data.message);
            throw new Error(event.data.message);
        }
      };

      const onIterationEnd = async () => {
        if (!currentBuffer) return null;

        try {
          await currentBuffer.waitUntilDrained();
        } catch {
          currentBuffer = null;
          return null;
        }

        currentBuffer = null;

        const doneData = loopDoneDataRef.current;
        loopDoneDataRef.current = null;

        if (!doneData) return null;
        return {
          directorState: doneData.directorState,
          totalAgents: doneData.totalAgents,
          agentHadContent: doneData.agentHadContent ?? true,
          cueUserReceived: doneData.cueUserReceived,
          sessionClosed: doneData.sessionClosed,
          endReason: doneData.endReason,
        };
      };

      return { onEvent, onIterationEnd };
    },
    [createBufferForSession],
  );

  if (!teachBackRef.current) {
    teachBackRef.current = new TeachBackSession(teachBackHostRef.current);
  }
  teachBackHostRef.current.isCurrent = (producer) => {
    if (!isTeachBackEnabled()) return false;
    if (!classroomVisibleRef.current) return false;
    const current = useStageStore.getState();
    return (
      current.stage?.id === producer.stageId &&
      current.currentSceneId === producer.sceneId &&
      producer.viewEpoch === teachBackViewEpochRef.current
    );
  };
  teachBackHostRef.current.enterLiveConversation = () => onEnterLiveConversationRef.current?.();
  teachBackHostRef.current.retireRequestsAndAudio = async () => {
    retireActiveLiveRequest();
    await pendingRetirementRef.current;
  };
  teachBackHostRef.current.presentEvents = async (events, signal) => {
    const sessionId =
      streamingSessionIdRef.current ??
      teachBackRef.current?.getProducer()?.sessionId ??
      sessionsRef.current.find(
        (session) => session.config.interactionMode === 'teach_back' && session.status === 'active',
      )?.id;
    if (!sessionId) return;
    const existing = abortControllerRef.current;
    const controller = existing && !existing.signal.aborted ? existing : new AbortController();
    abortControllerRef.current = controller;
    streamingSessionIdRef.current = sessionId;
    setIsStreaming(true);
    const consumer = createStatelessStreamConsumer(sessionId, controller, 'qa');
    try {
      for (const event of events) {
        if (signal.aborted || controller.signal.aborted) return;
        consumer.onEvent(event);
      }
      await consumer.onIterationEnd();
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        streamingSessionIdRef.current = null;
        setIsStreaming(false);
      }
    }
  };
  teachBackHostRef.current.readCurrentSource = async () => {
    const current = useStageStore.getState();
    const scene = current.scenes.find((item) => item.id === current.currentSceneId);
    if (!current.stage || !scene) return { ok: false as const, code: 'invalid_request' as const };
    return buildTeachBackSource({
      stageId: current.stage.id,
      courseTitle: current.stage.name,
      scene,
    });
  };
  teachBackHostRef.current.fetchTeachBack = (body, signal) =>
    fetch('/api/learning/teach-back', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  teachBackHostRef.current.getModelConfig = () => {
    const model = getCurrentModelConfig();
    return { ...modelRequestBodyFields(model), thinkingConfig: model.thinkingConfig };
  };
  teachBackHostRef.current.getLocale = () => locale;
  teachBackHostRef.current.now = () => new Date().toISOString();
  teachBackHostRef.current.mintId = () => nanoid();
  teachBackHostRef.current.onView = (view) => setTeachBackView(view);

  /**
   * Frontend-driven agent loop. Delegates to the shared runAgentLoop
   * from lib/chat/agent-loop.ts, wiring StreamBuffer for UI pacing.
   *
   * Each iteration: POST /api/chat → process SSE → wait for buffer drain → check outcome.
   */
  const runAgentLoopFn = useCallback(
    async (
      sessionId: string,
      requestTemplate: ChatRequestTemplate,
      controller: AbortController,
      sessionType: SessionType,
      onElementReferenceResponseAccepted?: (response: Response) => void,
    ): Promise<void> => {
      if (requestTemplate.config.interactionMode === 'guided') {
        if (!isGuidedLearningEnabled()) {
          throw new Error('Guided learning is not enabled');
        }
        const learningContext = requestTemplate.learningContext;
        if (!learningContext || learningContext.chatSessionId !== sessionId) {
          throw new Error('Guided learning requires context for the current session');
        }
        const storeState = await buildFreshAgentLoopStoreState();
        const requestStartState = useStageStore.getState();
        const sourceSceneId =
          learningContext.source.kind === 'scene' ? learningContext.source.sceneId : undefined;
        const producer: GuidedRequestProducer = {
          stageId: learningContext.stageId,
          source: learningContext.source,
          viewSceneId: requestStartState.currentSceneId,
          viewScene: requestStartState.scenes.find(
            (scene) => scene.id === requestStartState.currentSceneId,
          ),
          ...(sourceSceneId
            ? {
                sourceScene: requestStartState.scenes.find((scene) => scene.id === sourceSceneId),
              }
            : {}),
        };
        const isCurrentProducer = () => {
          const current = useStageStore.getState();
          return isGuidedProducerCurrent(producer, {
            stageId: current.stage?.id,
            currentSceneId: current.currentSceneId,
            scenes: current.scenes,
          });
        };
        const abortAsStale = (): never => {
          const error = new DOMException('The guided request is no longer current.', 'AbortError');
          controller.abort(error);
          throw error;
        };
        if (
          !isCurrentProducer() ||
          !(await isGuidedLearningContextCurrent(learningContext, requestStartState))
        ) {
          abortAsStale();
        }
        activeGuidedProducerRef.current = { controller, sessionId, producer };
        const lastMessage = requestTemplate.messages.at(-1);
        const studentInput =
          learningContext.phase === 'feedback'
            ? learningContext.studentAnswer
            : lastMessage?.parts
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n')
                .trim();
        if (!studentInput) throw new Error('Guided learning requires real student input');
        const identity = {
          requestId: learningContext.requestId,
          chatSessionId: sessionId,
          stageId: learningContext.stageId,
          contentRevision: learningContext.contentRevision,
          scopedRevision: learningContext.scopedRevision,
          source: learningContext.source,
          evidenceRefs: learningContext.evidence.map(({ ref }) => ref),
        };

        try {
          // The student's input is the prerequisite fact for feedback. If this
          // CAS append fails, do not ask the model; the visible chat input stays
          // available for an explicit retry.
          await appendLearningDialogueFact({
            payloadVersion: 1,
            identity,
            event: {
              kind: 'student_input',
              input: studentInput,
              createdAt: new Date().toISOString(),
            },
          });

          const outcome = await runGuidedSingleRequest(
            {
              ...requestTemplate,
              sessionId,
              storeState,
              learningContext,
            },
            controller,
            () => createStatelessStreamConsumer(sessionId, controller, sessionType),
            fetch,
            onElementReferenceResponseAccepted,
            isCurrentProducer,
          );
          if (
            controller.signal.aborted ||
            !isCurrentProducer() ||
            !(await isGuidedLearningContextCurrent(learningContext, useStageStore.getState()))
          ) {
            abortAsStale();
          }

          setSessions((prev) =>
            prev.map((session) =>
              session.id === sessionId
                ? {
                    ...session,
                    status:
                      outcome.phase === 'feedback' && outcome.budget.stopReason === 'completed'
                        ? ('completed' as const)
                        : session.status,
                    config: { ...session.config, learningContext, learningOutcome: outcome },
                    updatedAt: nextChatUpdatedAt(session),
                  }
                : session,
            ),
          );
          if (
            !isCurrentProducer() ||
            !(await isGuidedLearningContextCurrent(learningContext, useStageStore.getState()))
          ) {
            abortAsStale();
          }
          try {
            await appendLearningDialogueFact({
              payloadVersion: 1,
              identity,
              event: {
                kind: 'published_outcome',
                outcome,
                createdAt: new Date().toISOString(),
              },
            });
          } catch (error) {
            // Runtime persistence is a sidecar. The checked response has already
            // been published and must remain usable even if this append fails.
            log.warn('[GuidedLearning] Failed to persist published outcome:', error);
          }
        } finally {
          if (activeGuidedProducerRef.current?.controller === controller) {
            activeGuidedProducerRef.current = undefined;
          }
        }
        return;
      }

      // Attach full configs for generated (non-default) agents so the server can use them.
      // The server-side registry only has default agents; generated agents exist only client-side.
      const generatedConfigs = requestTemplate.config.agentIds
        .filter((id: string) => !id.startsWith('default-'))
        .map((id: string) => useAgentRegistry.getState().getAgent(id))
        .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
        .map(({ createdAt: _c, updatedAt: _u, isDefault: _d, ...rest }) => rest);
      if (generatedConfigs.length > 0) {
        requestTemplate.config.agentConfigs = generatedConfigs;
      }

      if (isPiChatEnabled()) {
        // Pi bypasses runAgentLoop's per-iteration getStoreState, so its single
        // request needs the snapshot built here — /api/chat/pi rejects bodies
        // without storeState.
        const storeState = await buildFreshAgentLoopStoreState();
        const firstRequestContext = getFirstPiRequestContext(sessionId);
        const piRequestTemplate = firstRequestContext
          ? { ...requestTemplate, storeState, piSessionBoundary: firstRequestContext }
          : { ...requestTemplate, storeState };
        const piRequestWithWebSearch = withPiWebSearchSettings(
          piRequestTemplate,
          useSettingsStore.getState(),
        );
        await runPiSingleRequest(
          sessionId,
          withPiInclassWhiteboardTools(piRequestWithWebSearch),
          controller,
          sessionType,
          createStatelessStreamConsumer,
          clearLiveSessionAfterError,
          enterSoftClosing,
          markSessionCompleted,
          storeDirectorState,
          onStopSessionRef,
          t,
          firstRequestContext || onElementReferenceResponseAccepted
            ? (response) => {
                if (firstRequestContext) {
                  consumePiSessionBoundaryContext(
                    piSessionBoundariesRef.current,
                    sessionId,
                    firstRequestContext,
                  );
                }
                onElementReferenceResponseAccepted?.(response);
              }
            : undefined,
        );
        return;
      }

      const streamConsumer = createStatelessStreamConsumer(sessionId, controller, sessionType);

      const outcome = await runAgentLoop(
        {
          messages: requestTemplate.messages,
          config: requestTemplate.config,
          userProfile: requestTemplate.userProfile,
          apiKey: requestTemplate.apiKey,
          baseUrl: requestTemplate.baseUrl,
          model: requestTemplate.model,
          providerType: requestTemplate.providerType,
          modelSource: requestTemplate.modelSource,
          platformDefaultId: requestTemplate.platformDefaultId,
          api: requestTemplate.api,
          endpointProfile: requestTemplate.endpointProfile,
          endpointParams: requestTemplate.endpointParams,
          credentialId: requestTemplate.credentialId,
          thinkingConfig: requestTemplate.thinkingConfig,
        },
        {
          getStoreState: buildFreshAgentLoopStoreState,

          getMessages: () => {
            const currentSession = sessionsRef.current.find((s) => s.id === sessionId);
            return currentSession?.messages ?? requestTemplate.messages;
          },

          fetchChat: (body, signal) =>
            fetch('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal,
            }),

          onEvent: streamConsumer.onEvent,
          onIterationEnd: streamConsumer.onIterationEnd,
        },
        controller.signal,
      );

      // Handle loop completion (UI-specific). Map each outcome.reason to a
      // distinct session state — don't conflate error paths with completion.
      if (!controller.signal.aborted) {
        switch (outcome.reason) {
          case 'turn_limit':
            // The last reply has drained. Hand control to the learner without
            // inventing another agent message or resuming the lecture.
            onCueUserRef.current?.(undefined, undefined, sessionId);
            break;
          case 'cue_user':
            // Session stays active; UI waits for the next user message.
            break;
          case 'end':
            setSessions((prev) =>
              prev.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      status: 'completed' as SessionStatus,
                      updatedAt: nextChatUpdatedAt(s),
                    }
                  : s,
              ),
            );
            onStopSessionRef.current?.({ sessionId, source: 'turn_complete' });
            break;
          case 'empty_turns':
            clearLiveSessionAfterError(sessionId, t('chat.error.emptyAgentResponses'));
            onStopSessionRef.current?.({ sessionId, source: 'error' });
            break;
          case 'no_done':
            clearLiveSessionAfterError(sessionId, t('chat.error.streamInterrupted'));
            onStopSessionRef.current?.({ sessionId, source: 'error' });
            break;
          case 'aborted':
            // Already handled elsewhere via abort signal.
            break;
        }
      }
    },
    [
      clearLiveSessionAfterError,
      createStatelessStreamConsumer,
      enterSoftClosing,
      markSessionCompleted,
      storeDirectorState,
      t,
      getFirstPiRequestContext,
    ],
  );

  /**
   * Create a new chat session
   */
  const createSession = useCallback(
    async (
      type: SessionType,
      title: string,
      options: { skipPiBoundary?: boolean; config?: ChatSession['config'] } = {},
    ): Promise<string> => {
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();

      if ((type === 'qa' || type === 'discussion') && !options.skipPiBoundary) {
        registerFirstPiRequest(sessionId);
      }
      const newSession: ChatSession = {
        id: sessionId,
        type,
        title,
        status: 'active',
        messages: [],
        config: {
          agentIds: options.config?.agentIds ?? ['default-1'],
          defaultAgentId:
            options.config?.defaultAgentId ?? options.config?.agentIds?.[0] ?? 'default-1',
          ...options.config,
        },
        toolCalls: [],
        pendingToolCalls: [],
        sceneId: currentSceneIdRef.current ?? undefined,
        createdAt: now,
        updatedAt: now,
      };

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(sessionId);
      setExpandedSessionIds((prev) => new Set([...prev, sessionId]));

      log.info(`[ChatArea] Created session: ${sessionId} (${type})`);
      return sessionId;
    },
    [registerFirstPiRequest],
  );

  /**
   * End a chat session.
   * For QA/Discussion sessions with active streaming, appends "..." + interrupted marker.
   */
  const endSession = useCallback(
    async (sessionId: string, options: EndSessionOptions = {}): Promise<void> => {
      log.info(`[ChatArea] Ending session: ${sessionId}`);
      clearSoftCloseRegistration(sessionId);
      softCloseLifecycleRef.current.set(sessionId, 'completed');
      livePausedRef.current = false;

      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (session?.config.interactionMode === 'teach_back') {
        teachBackRef.current?.abortActiveRequest();
      }
      const isLiveSession = session && (session.type === 'qa' || session.type === 'discussion');
      const wasStreaming = !!(
        abortControllerRef.current && streamingSessionIdRef.current === sessionId
      );

      // Retire presentation work before callers start another session. An action
      // already inside ActionEngine cannot be cancelled, so wait for it to settle.
      if (wasStreaming) {
        retireActiveLiveRequest(sessionId);
      } else {
        const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
        pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
          () => undefined,
        );
      }
      await pendingRetirementRef.current;
      if (session?.config.interactionMode === 'teach_back') {
        if (options.source === 'scene_switch') {
          await teachBackRef.current?.suspend('scene_switch');
        } else if (options.source === 'manual_stop' || options.source === undefined) {
          await teachBackRef.current?.finish('manual_stop');
        }
      }
      piSessionBoundariesRef.current.delete(sessionId);
      if (isLiveSession && session) {
        previousLiveSessionRef.current = createPreviousLiveSessionContext(
          session,
          currentSceneIdRef.current,
          options.source,
        );
      }
      lectureMessageIds.current.delete(sessionId);
      lectureLastActionIndexRef.current.delete(sessionId);

      if (isLiveSession && wasStreaming) {
        // Append "..." + interrupted marker to last assistant message
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const messages = [...s.messages];
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === 'assistant') {
                const parts = [...messages[i].parts];
                let appended = false;
                for (let j = parts.length - 1; j >= 0; j--) {
                  if (parts[j].type === 'text') {
                    const textPart = parts[j] as { type: 'text'; text: string };
                    parts[j] = {
                      type: 'text',
                      text: (textPart.text || '') + '...',
                    } as UIMessage<ChatMessageMetadata>['parts'][number];
                    appended = true;
                    break;
                  }
                }
                if (!appended) {
                  parts.push({
                    type: 'text',
                    text: '...',
                  } as UIMessage<ChatMessageMetadata>['parts'][number]);
                }
                messages[i] = {
                  ...messages[i],
                  parts,
                  metadata: { ...messages[i].metadata, interrupted: true },
                };
                break;
              }
            }
            return {
              ...withChatSessionStatus(s, 'completed'),
              messages,
              softCloseDeadline: undefined,
            };
          }),
        );
        // Clear roundtable state via callbacks
        onLiveSpeechRef.current?.(null, null, sessionId);
        onThinkingRef.current?.(null, sessionId);
      } else {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? {
                  ...withChatSessionStatus(s, 'completed'),
                  softCloseDeadline: undefined,
                }
              : s,
          ),
        );
      }

      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    },
    [activeSessionId, clearSoftCloseRegistration, retireActiveLiveRequest],
  );

  const continueSoftClosingSession = useCallback(
    (sessionId: string): boolean => {
      if (
        softCloseLifecycleRef.current.get(sessionId) !== 'soft-closing' ||
        !claimSoftCloseRegistration(sessionId)
      ) {
        return false;
      }
      softCloseLifecycleRef.current.set(sessionId, 'active');
      const now = Date.now();
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? (resumeSoftClosingSessionWithoutMessage(session, now) ?? session)
            : session,
        ),
      );
      return true;
    },
    [claimSoftCloseRegistration],
  );

  const confirmSoftClosingSession = useCallback(
    async (sessionId: string): Promise<SessionCleanupPayload | undefined> => {
      const registration = claimSoftCloseRegistration(sessionId);
      if (!registration || softCloseLifecycleRef.current.get(sessionId) !== 'soft-closing') {
        return undefined;
      }
      softCloseLifecycleRef.current.set(sessionId, 'completed');
      const payload: SessionCleanupPayload = {
        sessionId,
        endReason: registration.endReason,
        source: 'soft_close_confirmed',
      };
      await endSession(sessionId, { source: 'soft_close_confirmed' });
      return payload;
    },
    [claimSoftCloseRegistration, endSession],
  );

  /**
   * End the currently active QA/Discussion session (if any).
   */
  const endActiveSession = useCallback(
    async (options: EndSessionOptions = {}): Promise<void> => {
      const active = sessionsRef.current.find(isOpenLiveSession);
      if (active) {
        await endSession(active.id, options);
      }
    },
    [endSession],
  );

  /**
   * Soft-pause the active QA/Discussion session.
   * Aborts SSE and appends "..." + interrupted marker, but keeps session 'active'
   * so the user can continue speaking in the same topic.
   */
  const softPauseSession = useCallback(
    async (sessionId: string): Promise<void> => {
      livePausedRef.current = false;
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const isLiveSession = session.type === 'qa' || session.type === 'discussion';
      if (!isLiveSession || session.status !== 'active') return;

      const wasStreaming = !!(
        abortControllerRef.current && streamingSessionIdRef.current === sessionId
      );

      if (wasStreaming) {
        retireActiveLiveRequest(sessionId);
      } else {
        const retirement = retireLiveRequestResources(null, sessionId, buffersRef.current);
        pendingRetirementRef.current = Promise.all([pendingRetirementRef.current, retirement]).then(
          () => undefined,
        );
      }
      await pendingRetirementRef.current;

      if (wasStreaming) {
        // Append "..." + interrupted marker to last assistant message, keep status 'active'
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const messages = [...s.messages];
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === 'assistant') {
                const parts = [...messages[i].parts];
                let appended = false;
                for (let j = parts.length - 1; j >= 0; j--) {
                  if (parts[j].type === 'text') {
                    const textPart = parts[j] as { type: 'text'; text: string };
                    parts[j] = {
                      type: 'text',
                      text: (textPart.text || '') + '...',
                    } as UIMessage<ChatMessageMetadata>['parts'][number];
                    appended = true;
                    break;
                  }
                }
                if (!appended) {
                  parts.push({
                    type: 'text',
                    text: '...',
                  } as UIMessage<ChatMessageMetadata>['parts'][number]);
                }
                messages[i] = {
                  ...messages[i],
                  parts,
                  metadata: { ...messages[i].metadata, interrupted: true },
                };
                break;
              }
            }
            // Keep status 'active' — session continues when user speaks
            return { ...s, messages, updatedAt: nextChatUpdatedAt(s) };
          }),
        );
        // Note: Do NOT call onLiveSpeech/onThinking here.
        // Caller (doSoftPause) manages roundtable state to keep the interrupted bubble visible.
      }

      log.info(`[ChatArea] Soft-paused session: ${sessionId}`);
    },
    [retireActiveLiveRequest],
  );

  /**
   * Soft-pause the currently active QA/Discussion session (if any).
   */
  const softPauseActiveSession = useCallback(async (): Promise<void> => {
    const active = sessionsRef.current.find(isOpenLiveSession);
    if (active) {
      await softPauseSession(active.id);
    }
  }, [softPauseSession]);

  /**
   * Resume a soft-paused session by re-calling /chat with existing messages.
   * The director will pick the next agent to continue the topic.
   */
  const resumeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session || session.status !== 'active') return;

      await pendingRetirementRef.current;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      try {
        log.info(`[ChatArea] Resuming session: ${sessionId}`);

        const userProfileState = useUserProfileStore.getState();
        const mc = getCurrentModelConfig();

        const agentIds =
          useSettingsStore.getState().selectedAgentIds?.length > 0
            ? useSettingsStore.getState().selectedAgentIds
            : session.config.agentIds;

        await runAgentLoopFn(
          sessionId,
          {
            messages: session.messages,
            config: {
              agentIds,
              sessionType: session.type,
              ...(session.config.interactionMode === 'guided'
                ? { interactionMode: 'guided' as const }
                : {}),
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
            ...modelRequestBodyFields(mc),
            thinkingConfig: mc.thinkingConfig,
            directorState: session.directorState,
            ...(session.config.learningContext
              ? { learningContext: session.config.learningContext }
              : {}),
          },
          controller,
          session.type,
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Resume aborted');
          return;
        }
        log.error('[ChatArea] Resume error:', error);
        clearLiveSessionAfterError(
          sessionId,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    [clearLiveSessionAfterError, runAgentLoopFn],
  );

  /**
   * Resume the currently active soft-paused session (if any).
   */
  const resumeActiveSession = useCallback(async (): Promise<void> => {
    const active = sessionsRef.current.find(isOpenLiveSession);
    if (active) {
      if (shouldSkipAgentLoopForTeachBack(active.config.interactionMode)) {
        return;
      }
      await resumeSession(active.id);
    }
  }, [resumeSession]);

  /**
   * Send a message to the active session
   */
  const sendMessage = useCallback(
    async (content: string, options: ChatMessageSendOptions = {}): Promise<void> => {
      let sessionId = activeSessionId;

      // Interrupt active generation: abort stream and append "..." to the last agent message
      if (abortControllerRef.current) {
        const interruptedSessionId = retireActiveLiveRequest(sessionId);
        const interruptedMessageSessionId = interruptedSessionId ?? sessionId;

        if (interruptedMessageSessionId) {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== interruptedMessageSessionId) return s;
              const messages = [...s.messages];
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'assistant') {
                  const parts = [...messages[i].parts];
                  for (let j = parts.length - 1; j >= 0; j--) {
                    if (parts[j].type === 'text') {
                      const textPart = parts[j] as {
                        type: 'text';
                        text: string;
                      };
                      parts[j] = {
                        type: 'text',
                        text: (textPart.text || '') + '...',
                      } as UIMessage<ChatMessageMetadata>['parts'][number];
                      messages[i] = { ...messages[i], parts };
                      return { ...s, messages, updatedAt: nextChatUpdatedAt(s) };
                    }
                  }
                  break;
                }
              }
              return s;
            }),
          );
        }
      }

      // An interrupted action may still be finishing a delayed state mutation.
      // Capture the next request only after that mutation has settled.
      await pendingRetirementRef.current;

      // Validate model configuration before sending
      const modelConfig = getCurrentModelConfig();
      if (!modelConfig.modelId) {
        toast.error(t('settings.modelNotConfigured'));
        return;
      }
      if (modelConfig.requiresApiKey && !modelConfig.apiKey && !modelConfig.isServerConfigured) {
        toast.error(t('settings.setupNeeded'), {
          description: t('settings.apiKeyDesc'),
        });
        return;
      }

      // Create a new session when there's no active QA session to append to.
      // A completed session should NOT be reused — start a fresh one instead.
      const activeSession = sessionsRef.current.find((s) => s.id === sessionId);
      const interaction = resolveInteractionModeForTurn(activeSession, options.interactionMode);
      if (
        isTeachBackEnabled() &&
        shouldRouteToTeachBack(interaction.interactionMode, activeSession?.config.interactionMode)
      ) {
        const producer = teachBackRef.current?.getProducer();
        const view = teachBackRef.current?.getView();
        const phase = view?.activity?.logicalPhase;
        if (
          view?.ui === 'preparing' ||
          view?.ui === 'submitting' ||
          view?.ui === 'saving' ||
          view?.ui === 'retrying' ||
          phase === 'finished' ||
          view?.ui === 'paused'
        ) {
          return;
        }
        if (phase === 'summary_ready') {
          // Keep post-round acknowledgements and learner-authored questions visible.
          // Only an explicit request opens another round; every other message stays
          // in the completed conversation without triggering another companion ask.
          if (sessionId) {
            const now = Date.now();
            const userMessage: UIMessage<ChatMessageMetadata> = {
              id: `user-${now}`,
              role: 'user',
              parts: [{ type: 'text', text: content }],
              metadata: {
                senderName: t('common.you'),
                senderAvatar: USER_AVATAR,
                originalRole: 'user',
                createdAt: now,
              },
            };
            setSessions((prev) =>
              prev.map((session) =>
                session.id === sessionId
                  ? {
                      ...session,
                      messages: [...session.messages, userMessage],
                      updatedAt: nextChatUpdatedAt(session, now),
                    }
                  : session,
              ),
            );
          }
          if (isTeachBackFollowUpRequest(content)) {
            await continueTeachBackRoundRef.current?.();
          }
          return;
        }
        if (!producer || !sessionId) {
          return;
        }
        const now = Date.now();
        const userMessage: UIMessage<ChatMessageMetadata> = {
          id: `user-${now}`,
          role: 'user',
          parts: [{ type: 'text', text: content }],
          metadata: {
            senderName: t('common.you'),
            senderAvatar: USER_AVATAR,
            originalRole: 'user',
            createdAt: now,
          },
        };
        setSessions((prev) =>
          prev.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  messages: [...session.messages, userMessage],
                  status: 'active',
                  updatedAt: nextChatUpdatedAt(session, now),
                }
              : session,
          ),
        );
        const controller = new AbortController();
        abortControllerRef.current = controller;
        streamingSessionIdRef.current = sessionId;
        setIsStreaming(true);
        try {
          await teachBackRef.current?.submitExplanation({ text: content, producer });
        } finally {
          if (abortControllerRef.current === controller) {
            abortControllerRef.current = null;
            streamingSessionIdRef.current = null;
            setIsStreaming(false);
          }
        }
        return;
      }
      const needNewSession =
        !sessionId ||
        activeSession?.type === 'lecture' ||
        activeSession?.status === 'completed' ||
        interaction.startNewSession;

      if (needNewSession) {
        // End all active QA/Discussion sessions before creating new one
        const activeQAOrDiscussion = sessionsRef.current.filter(isOpenLiveSession);
        for (const session of activeQAOrDiscussion) {
          await endSession(session.id);
        }
        sessionId = await createSession('qa', 'Q&A');
      } else if (sessionId && activeSession?.status === 'soft-closing') {
        if (claimSoftCloseRegistration(sessionId)) {
          softCloseLifecycleRef.current.set(sessionId, 'active');
        } else {
          const lifecycle = softCloseLifecycleRef.current.get(sessionId);
          if (lifecycle === 'completed') {
            sessionId = await createSession('qa', 'Q&A');
          } else if (lifecycle !== 'active') {
            return;
          }
        }
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      const now = Date.now();
      const userMessageId = `user-${now}`;

      // Read all selected agent IDs from settings store
      const settingsState = useSettingsStore.getState();
      const agentIds: string[] =
        settingsState.selectedAgentIds?.length > 0 ? settingsState.selectedAgentIds : ['default-1'];

      const userMessage: UIMessage<ChatMessageMetadata> = {
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: content }],
        metadata: {
          senderName: t('common.you'),
          senderAvatar: USER_AVATAR,
          originalRole: 'user',
          createdAt: now,
        },
      };

      // Read current session data from ref (avoids stale closure AND keeps updater pure)
      const existingSession = sessionsRef.current.find((s) => s.id === sessionId);
      const baseLearningContext =
        options.learningContext ?? existingSession?.config.learningContext;
      const learningContext: GuidedLearningContext | undefined =
        interaction.interactionMode === 'guided' && baseLearningContext
          ? options.learningContext
            ? { ...options.learningContext, chatSessionId: sessionId! }
            : createGuidedContextForTurn(
                baseLearningContext,
                existingSession?.config.learningOutcome,
                content,
                sessionId!,
              )
          : undefined;
      const sessionMessages: UIMessage<ChatMessageMetadata>[] = existingSession
        ? [...existingSession.messages, userMessage]
        : [userMessage];
      const sessionType: SessionType = existingSession?.type || 'qa';

      // Pure updater — no side effects
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === sessionId);
        if (exists) {
          return prev.map((s) => {
            if (s.id !== sessionId) return s;
            const resumed = resumeSoftClosingSessionForFollowUp(s, userMessage, now);
            return {
              ...resumed,
              config: {
                ...resumed.config,
                ...(interaction.interactionMode === 'guided'
                  ? { interactionMode: 'guided' as const, learningContext }
                  : {}),
              },
            };
          });
        } else {
          const newSession: ChatSession = {
            id: sessionId!,
            type: 'qa',
            title: 'Q&A',
            status: 'active',
            messages: [userMessage],
            config: {
              agentIds,
              defaultAgentId: agentIds[0],
              ...(interaction.interactionMode === 'guided'
                ? { interactionMode: 'guided' as const, learningContext }
                : {}),
            },
            toolCalls: [],
            pendingToolCalls: [],
            sceneId: currentSceneIdRef.current ?? undefined,
            createdAt: now,
            updatedAt: now,
          };
          return [...prev, newSession];
        }
      });

      try {
        log.info(
          `[ChatArea] Sending message: "${content.slice(0, 50)}..." agents: ${agentIds.join(', ')}`,
        );

        const userProfileState = useUserProfileStore.getState();
        const mc = getCurrentModelConfig();

        await runAgentLoopFn(
          sessionId!,
          {
            messages: sessionMessages,
            config: {
              agentIds,
              sessionType,
              ...(interaction.interactionMode === 'guided'
                ? { interactionMode: 'guided' as const }
                : {}),
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
            ...modelRequestBodyFields(mc),
            thinkingConfig: mc.thinkingConfig,
            directorState: existingSession?.directorState,
            ...(learningContext ? { learningContext } : {}),
            ...(options.elementReference ? { elementReference: options.elementReference } : {}),
          },
          controller,
          sessionType,
          options.onResponseAccepted,
        );
      } catch (error) {
        // Ignore AbortError — it's intentional (user interrupted)
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Request aborted by user');
          return;
        }

        log.error('[ChatArea] Error:', error);
        clearLiveSessionAfterError(
          sessionId!,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // Only clean up if this is still the active controller (avoid race with interrupt)
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    [
      activeSessionId,
      clearLiveSessionAfterError,
      createSession,
      endSession,
      claimSoftCloseRegistration,
      retireActiveLiveRequest,
      runAgentLoopFn,
      t,
    ],
  );

  /**
   * Start a discussion with agent speaking first
   */
  const startDiscussion = useCallback(
    async (request: DiscussionRequest): Promise<void> => {
      log.info(`[ChatArea] Starting discussion: "${request.topic}"`);
      // Explicitly clear buffer-pause intent (also cleared transitively via endSession,
      // but being explicit guards against future refactors)
      livePausedRef.current = false;

      // Validate model configuration before starting discussion
      const modelConfig = getCurrentModelConfig();
      if (!modelConfig.modelId) {
        toast.error(t('settings.modelNotConfigured'));
        return;
      }
      if (modelConfig.requiresApiKey && !modelConfig.apiKey && !modelConfig.isServerConfigured) {
        toast.error(t('settings.setupNeeded'), {
          description: t('settings.apiKeyDesc'),
        });
        return;
      }

      // Auto-end previous active QA/Discussion sessions to ensure only one is active
      const activeQAOrDiscussion = sessionsRef.current.filter(isOpenLiveSession);
      for (const session of activeQAOrDiscussion) {
        await endSession(session.id);
      }

      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      const agentId = request.agentId || 'default-1';
      registerFirstPiRequest(sessionId);

      // Read all selected agent IDs from settings store
      const settingsState = useSettingsStore.getState();
      const agentIds: string[] =
        settingsState.selectedAgentIds?.length > 0
          ? [...settingsState.selectedAgentIds]
          : [agentId];
      // Ensure the trigger agent is included
      if (!agentIds.includes(agentId)) {
        agentIds.unshift(agentId);
      }

      // No pre-created assistant message — agent_start events create them dynamically
      const newSession: ChatSession = {
        id: sessionId,
        type: 'discussion',
        title: request.topic,
        status: 'active',
        messages: [],
        config: {
          agentIds,
          triggerAgentId: agentId,
        },
        toolCalls: [],
        pendingToolCalls: [],
        sceneId: currentSceneIdRef.current ?? undefined,
        createdAt: now,
        updatedAt: now,
      };

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(sessionId);
      setExpandedSessionIds((prev) => new Set([...prev, sessionId]));

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionIdRef.current = sessionId;
      setIsStreaming(true);

      try {
        const userProfileState = useUserProfileStore.getState();
        const mc = getCurrentModelConfig();

        await runAgentLoopFn(
          sessionId,
          {
            messages: [],
            config: {
              agentIds,
              sessionType: 'discussion',
              discussionTopic: request.topic,
              discussionPrompt: request.prompt,
              triggerAgentId: agentId,
            },
            userProfile: {
              nickname: userProfileState.nickname || undefined,
              bio: userProfileState.bio || undefined,
            },
            ...modelRequestBodyFields(mc),
            thinkingConfig: mc.thinkingConfig,
          },
          controller,
          'discussion',
        );
      } catch (error) {
        // Ignore AbortError — it's intentional (user interrupted)
        if (error instanceof DOMException && error.name === 'AbortError') {
          log.info('[ChatArea] Discussion aborted by user');
          return;
        }

        log.error('[ChatArea] Discussion error:', error);
        clearLiveSessionAfterError(
          sessionId,
          `Error starting discussion: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // Only clean up if this is still the active controller (avoid race with interrupt)
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          streamingSessionIdRef.current = null;
          setIsStreaming(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable from i18n context
    [clearLiveSessionAfterError, endSession, registerFirstPiRequest, runAgentLoopFn],
  );

  /**
   * Handle interruption
   */
  const handleInterrupt = useCallback(() => {
    if (!abortControllerRef.current) return;

    log.info('[ChatArea] Interrupting active request');
    retireActiveLiveRequest(activeSessionId);
  }, [activeSessionId, retireActiveLiveRequest]);

  /**
   * Start a lecture session for a scene.
   * Creates a single assistant message that all actions will be appended to.
   * Deduplicates: returns existing active lecture session for the same sceneId if found.
   */
  const startLecture = useCallback(
    async (sceneId: string): Promise<string> => {
      // Check for existing lecture session with same sceneId (active or completed)
      const existing = sessions.find(
        (s) =>
          s.type === 'lecture' &&
          s.sceneId === sceneId &&
          (s.status === 'active' || s.status === 'completed'),
      );
      if (existing) {
        // Reactivate a completed session so the chat panel shows it as active again.
        // Actions won't be re-appended because lastActionIndex already covers them.
        if (existing.status === 'completed') {
          setSessions((prev) =>
            prev.map((s) => (s.id === existing.id ? withChatSessionStatus(s, 'active') : s)),
          );
          // Restore lecture tracking refs (cleared by endSession)
          const messageId = existing.messages[0]?.id;
          if (messageId) {
            lectureMessageIds.current.set(existing.id, messageId);
          }
          if (existing.lastActionIndex !== undefined) {
            lectureLastActionIndexRef.current.set(existing.id, existing.lastActionIndex);
          }
        }
        setActiveSessionId(existing.id);
        setExpandedSessionIds((prev) => new Set([...prev, existing.id]));
        return existing.id;
      }

      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      const messageId = `lecture-msg-${now}`;

      const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
      const title = scene?.title || t('chat.lecture');

      const agentConfig = useAgentRegistry.getState().getAgent('default-1');

      // Create session with a single assistant message (all actions append parts here)
      const lectureMessage: UIMessage<ChatMessageMetadata> = {
        id: messageId,
        role: 'assistant',
        parts: [],
        metadata: {
          senderName: agentConfig?.name || t('settings.agentNames.default-1'),
          senderAvatar: agentConfig?.avatar,
          originalRole: 'teacher',
          agentId: 'default-1',
          createdAt: now,
        },
      };

      const newSession: ChatSession = {
        id: sessionId,
        type: 'lecture',
        title,
        status: 'active',
        messages: [lectureMessage],
        config: {
          agentIds: ['default-1'],
        },
        toolCalls: [],
        pendingToolCalls: [],
        sceneId,
        lastActionIndex: -1,
        createdAt: now,
        updatedAt: now,
      };

      lectureMessageIds.current.set(sessionId, messageId);

      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(sessionId);
      setExpandedSessionIds((prev) => new Set([...prev, sessionId]));

      log.info(`[ChatArea] Created lecture session: ${sessionId} for scene ${sceneId}`);
      return sessionId;
    },
    [sessions, t],
  );

  /**
   * Add a lecture action to the single message bubble via StreamBuffer.
   * Speech → pushText + sealText (buffer handles pacing).
   * Spotlight/laser/discussion → pushAction (badge appears after preceding text is revealed).
   */
  const addLectureMessage = useCallback(
    (sessionId: string, action: Action, actionIndex: number) => {
      const messageId = lectureMessageIds.current.get(sessionId);
      if (!messageId) return;

      // Skip if this action was already appended in a previous run
      const lastIndex = lectureLastActionIndexRef.current.get(sessionId) ?? -1;
      if (actionIndex <= lastIndex) return;
      lectureLastActionIndexRef.current.set(sessionId, actionIndex);

      // Update lastActionIndex in session
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, lastActionIndex: actionIndex, updatedAt: nextChatUpdatedAt(s) }
            : s,
        ),
      );

      // Get or create buffer for this lecture session
      let buffer = buffersRef.current.get(sessionId);
      if (!buffer || buffer.disposed) {
        buffer = createBufferForSession(sessionId, 'lecture');
      }

      if (action.type === 'speech') {
        buffer.pushText(messageId, action.text, 'default-1');
        buffer.sealText(messageId);
      } else if (
        action.type === 'spotlight' ||
        action.type === 'laser' ||
        action.type === 'discussion'
      ) {
        const now = Date.now();
        buffer.pushAction({
          messageId,
          actionId: `${action.type}-${now}`,
          actionName: action.type,
          params:
            action.type === 'spotlight'
              ? {
                  elementId: action.elementId,
                  dimOpacity: (action as SpotlightAction).dimOpacity,
                }
              : action.type === 'laser'
                ? { elementId: action.elementId }
                : {
                    topic: (action as DiscussionAction).topic,
                    prompt: (action as DiscussionAction).prompt,
                  },
          agentId: 'default-1',
        });
      }
    },
    [createBufferForSession],
  );

  // Derive active session type for external consumers
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSessionType = activeSession?.type ?? null;

  const getLectureMessageId = useCallback((sessionId: string): string | null => {
    return lectureMessageIds.current.get(sessionId) ?? null;
  }, []);

  /** Pause the buffer for a session (lecture pause support). */
  const pauseBuffer = useCallback((sessionId: string) => {
    const buf = buffersRef.current.get(sessionId);
    if (buf) buf.pause();
  }, []);

  /** Resume the buffer for a session. */
  const resumeBuffer = useCallback((sessionId: string) => {
    const buf = buffersRef.current.get(sessionId);
    if (buf) buf.resume();
  }, []);

  /** Pause the active live (QA/Discussion) buffer and set sticky intent. Returns true if paused. */
  const pauseActiveLiveBuffer = useCallback((): boolean => {
    const active = sessionsRef.current.find(isOpenLiveSession);
    if (!active) return false;
    const buf = buffersRef.current.get(active.id);
    if (!buf || buf.disposed) return false;
    livePausedRef.current = true;
    buf.pause();
    log.info('[ChatArea] Buffer-paused discussion:', active.id);
    return true;
  }, []);

  /** Resume the active live (QA/Discussion) buffer and clear sticky intent. */
  const resumeActiveLiveBuffer = useCallback(() => {
    const active = sessionsRef.current.find(isOpenLiveSession);
    if (!active) return;
    livePausedRef.current = false;
    const buf = buffersRef.current.get(active.id);
    if (buf) buf.resume();
    log.info('[ChatArea] Buffer-resumed discussion:', active.id);
  }, []);

  const startTeachBack = useCallback(
    async (input: {
      source: TeachBackSource;
      topic: string;
      peer: TeachBackPeer;
      replaceOpenQa: boolean;
    }) => {
      if (!isTeachBackEnabled()) return;
      const open = sessionsRef.current.filter(isOpenLiveSession);
      for (const session of open) {
        await endSession(
          session.id,
          session.config.interactionMode === 'teach_back' ? { source: 'manual_stop' } : {},
        );
      }
      const activityId = `tb-${nanoid()}`;
      const sessionId = await createSession('qa', input.topic || 'Teach-back', {
        skipPiBoundary: true,
        config: {
          agentIds: [input.peer.id],
          defaultAgentId: input.peer.id,
          interactionMode: 'teach_back',
          teachBackActivityId: activityId,
        },
      });
      setIsStreaming(true);
      try {
        await teachBackRef.current?.start({
          activityId,
          sessionId,
          source: input.source,
          topic: input.topic,
          peer: input.peer,
          viewEpoch: teachBackViewEpochRef.current,
          replaceOpenQa: input.replaceOpenQa,
        });
      } finally {
        if (!abortControllerRef.current) setIsStreaming(false);
      }
    },
    [createSession, endSession],
  );

  const continueTeachBackRound = useCallback(async () => {
    if (!isTeachBackEnabled()) return;
    const activity = teachBackRef.current?.getView().activity;
    if (!activity?.source || !activity.plan) return;
    if (activity.logicalPhase !== 'summary_ready') return;
    await startTeachBack({
      source: activity.source,
      topic: activity.topic || activity.plan.topic,
      peer: activity.plan.peer,
      replaceOpenQa: false,
    });
  }, [startTeachBack]);
  continueTeachBackRoundRef.current = continueTeachBackRound;

  const restoreTeachBack = useCallback(async () => {
    const producer = teachBackRef.current?.getProducer();
    const activity = teachBackRef.current?.getView().activity;
    if (!producer || !activity?.source) return;
    let sessionId = sessionsRef.current.find(
      (session) => session.config.teachBackActivityId === producer.activityId,
    )?.id;
    if (!sessionId) {
      sessionId = await createSession('qa', activity.topic || 'Teach-back', {
        skipPiBoundary: true,
        config: {
          agentIds: activity.plan ? [activity.plan.peer.id] : ['default-1'],
          defaultAgentId: activity.plan?.peer.id,
          interactionMode: 'teach_back',
          teachBackActivityId: producer.activityId,
        },
      });
    }
    const nextProducer = { ...producer, sessionId, viewEpoch: teachBackViewEpochRef.current };
    onEnterLiveConversationRef.current?.();
    if (activity.logicalPhase === 'evaluation_pending' && activity.pendingTurnId) {
      await teachBackRef.current?.retryEvaluation(nextProducer, activity.pendingTurnId);
      return;
    }
    await teachBackRef.current?.restore(nextProducer, true);
  }, [createSession]);

  const retryTeachBack = useCallback(async () => {
    const producer = teachBackRef.current?.getProducer();
    const activity = teachBackRef.current?.getView().activity;
    if (!producer) return;
    if (teachBackRef.current?.getView().errorCode === 'save_failed') {
      await teachBackRef.current.retrySave(producer);
      return;
    }
    if (activity?.pendingTurnId) {
      await teachBackRef.current?.retryEvaluation(producer, activity.pendingTurnId);
    }
  }, []);

  const attachTeachBackActivity = useCallback((activity: TeachBackProjectedActivity) => {
    if (!activity.source) return;
    const sessionId =
      sessionsRef.current.find(
        (session) => session.config.teachBackActivityId === activity.activityId,
      )?.id ?? '';
    teachBackRef.current?.attach(
      {
        activityId: activity.activityId,
        sessionId,
        stageId: activity.source.stageId,
        sceneId: activity.source.sceneId,
        sourceRevision: activity.source.sourceRevision,
        viewEpoch: teachBackViewEpochRef.current,
      },
      activity,
    );
  }, []);

  const surfaceTeachBackError = useCallback((code: TeachBackErrorCode) => {
    teachBackRef.current?.surfaceError(code);
  }, []);

  return {
    sessions,
    activeSessionId,
    activeSessionType,
    expandedSessionIds,
    isStreaming,
    teachBackView,
    createSession,
    endSession,
    endActiveSession,
    continueSoftClosingSession,
    confirmSoftClosingSession,
    softPauseActiveSession,
    resumeActiveSession,
    sendMessage,
    startDiscussion,
    startLecture,
    addLectureMessage,
    toggleSessionExpand,
    handleInterrupt,
    getLectureMessageId,
    pauseBuffer,
    resumeBuffer,
    pauseActiveLiveBuffer,
    resumeActiveLiveBuffer,
    startTeachBack,
    continueTeachBackRound,
    restoreTeachBack,
    retryTeachBack,
    attachTeachBackActivity,
    surfaceTeachBackError,
  };
}
