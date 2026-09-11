'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useStageStore } from '@/lib/store';
import { usePlaybackChromeStageProjection } from '@/lib/classroom/playback-chrome-stage-projection';
import {
  createClassroomLiveRuntime,
  createInitialClassroomRuntimeState,
  reduceClassroomRuntime,
  type ClassroomLiveRuntimeState,
  type ClassroomThinkingState,
} from '@/lib/classroom/classroom-runtime';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { PLAYBACK_SPEEDS, useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { SceneSidebar } from '@/components/stage/scene-sidebar';
import { Header } from '@/components/header';
import { CanvasArea } from '@/components/canvas/canvas-area';
import { PlaybackEngine, computePlaybackView, shouldAutoResumeLecture } from '@/lib/playback';
import type { EngineMode, TriggerEvent, Effect } from '@/lib/playback';
import {
  canJumpWithinReconstructablePrefix,
  isUnsafePlaybackNavigationAction,
} from '@/lib/playback/action-navigation';
import {
  getActionResumeRestoreCursor,
  clearActionResumePosition,
  createActionResumePosition,
  getActionResumeStorageKey,
  readActionResumeState,
  saveActionResumePosition,
} from '@/lib/playback/action-resume';
import { loadCursor, saveCursor, type PlaybackCursor } from '@/lib/playback/cursor';
import { ActionEngine } from '@/lib/action/engine';
import { createAudioPlayer } from '@/lib/utils/audio-player';
import { useDiscussionTTS } from '@/lib/hooks/use-discussion-tts';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
import type { Action, DiscussionAction, SpeechAction } from '@/lib/types/action';
import { cn } from '@/lib/utils';
import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';
import type { SessionCleanupPayload } from '@/components/chat/use-chat-sessions';
import { agentsToParticipants, useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { AlertTriangle } from 'lucide-react';
import { VisuallyHidden } from 'radix-ui';
import type { PPTElement } from '@openmaic/dsl';
import type { SlideElementReference } from '@/lib/types/chat';
import { isPiChatEnabled } from '@/lib/config/feature-flags';
import {
  getSlideElementPresentation,
  getSlideElementTypeLabel,
} from '@/components/canvas/slide-element-pick-overlay';
import { shouldClearDraftElementReference } from '@/components/chat/element-reference-receipt';
import { ZhiyuClassroomShell } from '@/components/classroom/ZhiyuClassroomShell';
import {
  ClassroomInteractionIsland,
  ClassroomRoundtableIsland,
} from '@/components/classroom/ClassroomRuntimeIslands';
import { ZhiyuPlaybackBar } from '@/components/classroom/ZhiyuPlaybackBar';
import {
  projectZhiyuClassroomControls,
  projectZhiyuClassroomLiveStatus,
} from '@/components/classroom/zhiyu-classroom-layout';

type DraftSlideElementReference = {
  reference: SlideElementReference;
  selectionVersion: number;
  sceneOrder?: number;
  elementType: PPTElement['type'];
  displaySummary: string;
};

type ElementReferenceSendSnapshot = Pick<
  DraftSlideElementReference,
  'reference' | 'selectionVersion'
>;

/**
 * Imperative handle exposed via `ref` so the parent (`Stage`) can tear
 * down playback state synchronously before flipping mode to `'edit'`.
 * Unmount cleanup would run anyway, but the toggle needs to `await`
 * `endActiveSession()` (which aborts SSE) before we trust the engine /
 * chat to be quiescent — fire-and-forget on unmount loses that guarantee.
 */
export interface PlaybackChromeRootHandle {
  /** Ends any active SSE session, stops the engine, cleans up TTS audio. */
  teardown: () => Promise<void>;
}

interface PlaybackChromeRootProps {
  readonly onRetryOutline?: (outlineId: string) => Promise<void>;
  readonly generationJobDisplay?:
    | import('@/lib/generation/job-display').GenerationJobDisplayProjection
    | null;
  /** Whether the Pro Switch in Header should be enabled. */
  readonly canEnterProMode?: boolean;
  /** Pro Switch click handler — parent coordinates teardown + mode flip. */
  readonly onEnterProMode?: () => void;
  readonly proModeActive?: boolean;
  readonly headerBackControl?: ReactNode;
  readonly hideHeaderBackControl?: boolean;
  readonly hideHeader?: boolean;
  readonly hideHeaderGlobalControls?: boolean;
  readonly hideHeaderCourseActions?: boolean;
}

/**
 * PlaybackChromeRoot — owns the entire playback/autonomous chrome and
 * its state. Mounted whenever `mode !== 'edit'`. The Pro Switch in
 * `Header` calls `onEnterProMode`; the parent `Stage` is responsible
 * for calling `ref.teardown()` before unmounting this root so SSE and
 * the engine wind down cleanly.
 */
export const PlaybackChromeRoot = forwardRef<PlaybackChromeRootHandle, PlaybackChromeRootProps>(
  function PlaybackChromeRoot(
    {
      onRetryOutline,
      generationJobDisplay,
      canEnterProMode,
      onEnterProMode,
      proModeActive,
      headerBackControl,
      hideHeaderBackControl,
      hideHeader,
      hideHeaderGlobalControls,
      hideHeaderCourseActions,
    },
    ref,
  ) {
    const { t } = useI18n();
    const {
      mode,
      stage,
      scenes,
      currentSceneId,
      currentScene,
      setCurrentSceneId,
      generatingOutlines,
      outlines,
      failedOutlines,
      generationComplete,
    } = usePlaybackChromeStageProjection();
    const piChatEnabled = isPiChatEnabled();
    const [classroomLiveRuntime] = useState(createClassroomLiveRuntime);
    const setLiveSpeech = classroomLiveRuntime.setLiveSpeech;
    const setSpeechProgress = classroomLiveRuntime.setSpeechProgress;
    const setThinkingState = classroomLiveRuntime.setThinkingState;
    const [elementPickActive, setElementPickActive] = useState(false);
    const [draftElementReference, setDraftElementReferenceState] =
      useState<DraftSlideElementReference | null>(null);
    const draftElementReferenceRef = useRef<DraftSlideElementReference | null>(null);
    const elementReferenceSceneIdRef = useRef(currentSceneId);
    const selectionVersionRef = useRef(0);
    const pendingInterruptElementReferenceRef = useRef<ElementReferenceSendSnapshot | undefined>(
      undefined,
    );

    const setDraftElementReference = useCallback((next: DraftSlideElementReference | null) => {
      draftElementReferenceRef.current = next;
      setDraftElementReferenceState(next);
    }, []);

    // Layout state from settings store (persisted via localStorage)
    const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
    const setSidebarCollapsed = useSettingsStore((s) => s.setSidebarCollapsed);
    const chatAreaWidth = useSettingsStore((s) => s.chatAreaWidth);
    const setChatAreaWidth = useSettingsStore((s) => s.setChatAreaWidth);
    const chatAreaCollapsed = useSettingsStore((s) => s.chatAreaCollapsed);
    const setChatAreaCollapsed = useSettingsStore((s) => s.setChatAreaCollapsed);
    const setTTSMuted = useSettingsStore((s) => s.setTTSMuted);
    const setTTSVolume = useSettingsStore((s) => s.setTTSVolume);
    const [classroomRuntime, dispatchClassroomRuntime] = useReducer(
      reduceClassroomRuntime,
      undefined,
      createInitialClassroomRuntimeState,
    );
    const {
      compactViewport,
      narrowViewport,
      compactInteractionOpen,
      narrowSceneRailOpen,
      isPresenting,
      isDiscussionPaused,
    } = classroomRuntime;

    useEffect(() => {
      if (typeof window.matchMedia !== 'function') return;
      const compactQuery = window.matchMedia('(max-width: 1279px)');
      const narrowQuery = window.matchMedia('(max-width: 899px)');
      const updateViewport = () => {
        dispatchClassroomRuntime({
          type: 'viewport.changed',
          compact: compactQuery.matches,
          narrow: narrowQuery.matches,
        });
      };
      updateViewport();
      compactQuery.addEventListener('change', updateViewport);
      narrowQuery.addEventListener('change', updateViewport);
      return () => {
        compactQuery.removeEventListener('change', updateViewport);
        narrowQuery.removeEventListener('change', updateViewport);
      };
    }, []);

    const presentedSidebarCollapsed = narrowViewport ? !narrowSceneRailOpen : sidebarCollapsed;
    const presentedChatCollapsed = compactViewport ? !compactInteractionOpen : chatAreaCollapsed;

    const handleSceneRailPresentationChange = useCallback(
      (collapsed: boolean) => {
        if (narrowViewport) {
          dispatchClassroomRuntime({
            type: 'sceneRail.presentationChanged',
            collapsed,
          });
          return;
        }
        setSidebarCollapsed(collapsed);
      },
      [narrowViewport, setSidebarCollapsed],
    );

    const handleInteractionPresentationChange = useCallback(
      (collapsed: boolean) => {
        if (compactViewport) {
          dispatchClassroomRuntime({
            type: 'interaction.presentationChanged',
            collapsed,
          });
          return;
        }
        setChatAreaCollapsed(collapsed);
      },
      [compactViewport, setChatAreaCollapsed],
    );

    const toggleSceneRailPresentation = useCallback(() => {
      handleSceneRailPresentationChange(!presentedSidebarCollapsed);
    }, [handleSceneRailPresentationChange, presentedSidebarCollapsed]);

    const toggleInteractionPresentation = useCallback(() => {
      handleInteractionPresentationChange(!presentedChatCollapsed);
    }, [handleInteractionPresentationChange, presentedChatCollapsed]);

    // PlaybackEngine state
    const [engineMode, setEngineMode] = useState<EngineMode>('idle');
    const [playbackCompleted, setPlaybackCompleted] = useState(false); // Distinguishes "never played" idle from "finished" idle
    const [lectureSpeech, setLectureSpeech] = useState<string | null>(null); // From PlaybackEngine (lecture)
    const [currentPlaybackActionIndex, setCurrentPlaybackActionIndex] = useState<number | null>(0);
    const [discussionTrigger, setDiscussionTrigger] = useState<TriggerEvent | null>(null);

    // Speaking agent tracking (Issue 2)
    const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);

    // Thinking state (Issue 5)
    // Cue user state (Issue 7)
    const [isCueUser, setIsCueUser] = useState(false);

    // End flash state (Issue 3)
    const [showEndFlash, setShowEndFlash] = useState(false);
    const [endFlashSessionType, setEndFlashSessionType] = useState<'qa' | 'discussion'>(
      'discussion',
    );

    // Streaming state for stop button (Issue 1)
    const [chatIsStreaming, setChatIsStreaming] = useState(false);
    const [chatIsSoftClosing, setChatIsSoftClosing] = useState(false);
    const [softCloseDeadline, setSoftCloseDeadline] = useState<number | undefined>();
    const [chatSessionType, setChatSessionType] = useState<string | null>(null);

    // Topic pending state: session is soft-paused, bubble stays visible, waiting for user input
    const [isTopicPending, setIsTopicPending] = useState(false);

    // Active bubble ID for playback highlight in chat area (Issue 8)
    const [activeBubbleId, setActiveBubbleId] = useState<string | null>(null);

    // Scene switch confirmation dialog state
    const [pendingSceneId, setPendingSceneId] = useState<string | null>(null);
    const sceneSwitchRequestRef = useRef(0);
    const sceneSwitchConfirmingRef = useRef(false);
    const [controlsVisible, setControlsVisible] = useState(true);
    const [isPresentationInteractionActive, setIsPresentationInteractionActive] = useState(false);

    // Whiteboard state (from canvas store so AI tools can open it)
    const whiteboardOpen = useCanvasStore.use.whiteboardOpen();
    const setWhiteboardOpenManually = useCanvasStore.use.setWhiteboardOpenManually();

    // Selected agents from settings store (Zustand)
    const selectedAgentIds = useSettingsStore((s) => s.selectedAgentIds);
    const ttsMuted = useSettingsStore((s) => s.ttsMuted);
    const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);

    // Generate participants from selected agents
    const participants = useMemo(
      () => agentsToParticipants(selectedAgentIds, t),
      [selectedAgentIds, t],
    );

    // Resolved AgentConfig array for hooks that need full agent objects
    // Subscribe to the agents record so voiceConfig changes trigger re-resolution
    const agentsRecord = useAgentRegistry((s) => s.agents);
    const selectedAgents = useMemo(
      () =>
        selectedAgentIds.map((id) => agentsRecord[id]).filter((a): a is AgentConfig => a != null),
      [agentsRecord, selectedAgentIds],
    );

    // Discussion TTS: audio indicator state
    const [audioIndicatorState, setAudioIndicatorState] = useState<AudioIndicatorState>('idle');
    const [audioAgentId, setAudioAgentId] = useState<string | null>(null);

    const discussionTTS = useDiscussionTTS({
      enabled: ttsEnabled && !ttsMuted,
      agents: selectedAgents,
      onAudioStateChange: (agentId, state) => {
        setAudioAgentId(agentId);
        setAudioIndicatorState(state);
      },
    });

    // Pick a student agent for discussion trigger (prioritize student > non-teacher > fallback)
    const pickStudentAgent = useCallback((): string => {
      const registry = useAgentRegistry.getState();
      const agents = selectedAgentIds
        .map((id) => registry.getAgent(id))
        .filter((a): a is AgentConfig => a != null);
      const students = agents.filter((a) => a.role === 'student');
      if (students.length > 0) {
        return students[Math.floor(Math.random() * students.length)].id;
      }
      const nonTeachers = agents.filter((a) => a.role !== 'teacher');
      if (nonTeachers.length > 0) {
        return nonTeachers[Math.floor(Math.random() * nonTeachers.length)].id;
      }
      return agents[0]?.id || 'default-1';
    }, [selectedAgentIds]);

    const engineRef = useRef<PlaybackEngine | null>(null);
    const audioPlayerRef = useRef(createAudioPlayer());
    const chatAreaRef = useRef<ChatAreaRef>(null);
    const isCurrentChatProducer = useCallback((producerSessionId: string) => {
      return chatAreaRef.current?.getActiveSessionId() === producerSessionId;
    }, []);
    const lectureSessionIdRef = useRef<string | null>(null);
    const lectureActionCounterRef = useRef(0);
    const pendingPlaySceneIdRef = useRef<string | null>(null);
    const readyPlaybackSceneIdRef = useRef<string | null>(null);
    const playbackInitializationEpochRef = useRef(0);
    const currentPlaybackActionIndexRef = useRef<number | null>(currentPlaybackActionIndex);
    const activeSceneIdRef = useRef<string | null>(currentSceneId);
    const discussionAbortRef = useRef<AbortController | null>(null);
    const presentationIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const endFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cursorSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingCursorRef = useRef<{ stageId: string; cursor: PlaybackCursor } | null>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    // Guard to prevent double flash when manual stop triggers onDiscussionEnd
    const manualStopRef = useRef(false);

    const sendMessageWithElementReference = useCallback(
      (text: string, snapshot?: ElementReferenceSendSnapshot) => {
        return chatAreaRef.current?.sendMessage(
          text,
          snapshot
            ? {
                elementReference: snapshot.reference,
                onResponseAccepted: (response) => {
                  const current = draftElementReferenceRef.current;
                  if (
                    !shouldClearDraftElementReference(
                      response,
                      snapshot.selectionVersion,
                      current?.selectionVersion,
                    )
                  ) {
                    return;
                  }
                  setDraftElementReference(null);
                },
              }
            : undefined,
        );
      },
      [setDraftElementReference],
    );

    const updateCurrentPlaybackActionIndex = useCallback((actionIndex: number | null) => {
      currentPlaybackActionIndexRef.current = actionIndex;
      setCurrentPlaybackActionIndex(actionIndex);
    }, []);

    const persistCursorSafely = useCallback(
      ({ stageId, cursor }: { stageId: string; cursor: PlaybackCursor }) => {
        void saveCursor(stageId, cursor).catch((error) => {
          console.warn(`Failed to save playback cursor for stage ${stageId}:`, error);
        });
      },
      [],
    );

    const scheduleCursorSave = useCallback(
      (stageId: string, cursor: PlaybackCursor) => {
        pendingCursorRef.current = { stageId, cursor };
        if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current);
        cursorSaveTimerRef.current = setTimeout(() => {
          cursorSaveTimerRef.current = null;
          const pending = pendingCursorRef.current;
          pendingCursorRef.current = null;
          if (pending) persistCursorSafely(pending);
        }, 1000);
      },
      [persistCursorSafely],
    );

    const actionResumeStorageKey = useMemo(
      () => getActionResumeStorageKey(stage?.id ?? currentScene?.stageId),
      [currentScene?.stageId, stage?.id],
    );

    const saveSceneResumePosition = useCallback(
      (sceneId: string | null | undefined, actionIndex: number | null | undefined) => {
        if (!sceneId || typeof window === 'undefined') return;
        const scene = scenes.find((s) => s.id === sceneId);
        const actions = scene?.actions ?? [];
        if (!scene || actions.length === 0) return;

        if (Number.isInteger(actionIndex) && actionIndex! >= actions.length) {
          clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          return;
        }

        const action = Number.isInteger(actionIndex) ? actions[actionIndex!] : null;
        if (action && action.type !== 'speech') {
          const crossedUnsafe = actions
            .slice(0, actionIndex! + 1)
            .some(isUnsafePlaybackNavigationAction);
          if (crossedUnsafe) {
            clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          }
          return;
        }

        const position = createActionResumePosition(actions, actionIndex);
        if (!position) return;
        if (!canJumpWithinReconstructablePrefix(actions, 0, position.actionIndex)) {
          clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          return;
        }
        saveActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId, position);
      },
      [actionResumeStorageKey, scenes],
    );

    const clearSceneResumePosition = useCallback(
      (sceneId: string | null | undefined) => {
        if (!sceneId || typeof window === 'undefined') return;
        clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
      },
      [actionResumeStorageKey],
    );
    // When true, the next engine init will auto-start playback (for auto-play scene advance)
    const autoStartRef = useRef(false);
    // Discussion buffer-level pause state (distinct from soft-pause which aborts SSE)

    /**
     * Resume a soft-paused topic: re-call /chat with existing session messages.
     * The director picks the next agent to continue.
     */
    const doResumeTopic = useCallback(async () => {
      // Clear old bubble immediately — no lingering on interrupted text
      setIsTopicPending(false);
      setLiveSpeech(null);
      setSpeakingAgentId(null);
      setThinkingState({ stage: 'director' });
      setChatIsStreaming(true);
      // Transition engine back to live — onInputActivate paused it when soft-pausing,
      // so we must explicitly resume to keep engine mode in sync with the chat loop.
      engineRef.current?.resume();
      // Fire new chat round — SSE events will drive thinking → agent_start → speech
      await chatAreaRef.current?.resumeActiveSession();
    }, [setLiveSpeech, setThinkingState]);

    /** Reset all live/discussion state (shared by doSessionCleanup & onDiscussionEnd) */
    const resetLiveState = useCallback(() => {
      classroomLiveRuntime.reset();
      setSpeakingAgentId(null);
      setIsCueUser(false);
      setIsTopicPending(false);
      setChatIsStreaming(false);
      setChatIsSoftClosing(false);
      setChatSessionType(null);
      dispatchClassroomRuntime({
        type: 'discussion.pauseChanged',
        paused: false,
      });
    }, [classroomLiveRuntime]);

    const showSessionEndFlash = useCallback((sessionType: 'qa' | 'discussion') => {
      setEndFlashSessionType(sessionType);
      setShowEndFlash(true);
      if (endFlashTimerRef.current) clearTimeout(endFlashTimerRef.current);
      endFlashTimerRef.current = setTimeout(() => {
        endFlashTimerRef.current = null;
        setShowEndFlash(false);
      }, 1800);
    }, []);

    const cancelAutoAdvanceTimer = useCallback(() => {
      if (autoAdvanceTimerRef.current) clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }, []);

    /** Full scene reset (scene switch) — resetLiveState + lecture/visual state */
    const resetSceneState = useCallback(
      (initial?: { actionIndex?: number | null; lectureSpeech?: string | null }) => {
        resetLiveState();
        dispatchClassroomRuntime({ type: 'scene.switched' });
        setPlaybackCompleted(false);
        setLectureSpeech(initial?.lectureSpeech ?? null);
        updateCurrentPlaybackActionIndex(initial?.actionIndex ?? 0);
        setSpeechProgress(null);
        setShowEndFlash(false);
        setActiveBubbleId(null);
        setDiscussionTrigger(null);
      },
      [resetLiveState, setSpeechProgress, updateCurrentPlaybackActionIndex],
    );

    /** Request failure should exit live discussion UI without hard-closing the session. */
    const handleLiveSessionError = useCallback(
      (producerSessionId: string) => {
        if (!isCurrentChatProducer(producerSessionId)) return;
        classroomLiveRuntime.advanceSession();
        engineRef.current?.handleDiscussionError();
        resetLiveState();
        setActiveBubbleId(null);
      },
      [classroomLiveRuntime, isCurrentChatProducer, resetLiveState],
    );

    /**
     * Unified session cleanup — called by both roundtable stop button and chat area end button.
     * Handles: engine transition, flash, roundtable state clearing.
     */
    const doSessionCleanup = useCallback(() => {
      const activeType = chatSessionType;
      classroomLiveRuntime.advanceSession();

      // Engine cleanup — guard to avoid double flash from onDiscussionEnd
      manualStopRef.current = true;
      engineRef.current?.handleEndDiscussion();
      manualStopRef.current = false;

      // Show end flash with correct session type
      if (activeType === 'qa' || activeType === 'discussion') {
        showSessionEndFlash(activeType);
      }

      // Stop any in-flight discussion TTS audio
      discussionTTS.cleanup();

      resetLiveState();
    }, [chatSessionType, classroomLiveRuntime, resetLiveState, discussionTTS, showSessionEndFlash]);

    // Shared stop-discussion handler (used by both Roundtable and Canvas toolbar)
    const handleStopDiscussion = useCallback(async () => {
      await chatAreaRef.current?.stopActiveSession();
    }, []);

    const handleContinueDiscussion = useCallback(() => {
      if (chatAreaRef.current?.continueActiveSoftClosingSession()) {
        setChatIsSoftClosing(false);
        setSoftCloseDeadline(undefined);
      }
    }, []);

    /**
     * Session-stop callback from the chat layer. Runs the normal cleanup, then —
     * only when a confirmed or timed-out soft close ended a Q&A that had
     * interrupted an active lecture — auto-resumes from the saved position.
     *
     * hadLectureInterruption MUST be read before doSessionCleanup(), because
     * handleEndDiscussion() restores and clears the saved lecture position.
     */
    const handleSessionStop = useCallback(
      async (payload: SessionCleanupPayload) => {
        if (!isCurrentChatProducer(payload.sessionId)) return;
        const engine = engineRef.current;
        const hadLectureInterruption = engine?.hasLectureInterruption() ?? false;

        doSessionCleanup();

        if (!engine) return;
        const eligible = shouldAutoResumeLecture({
          source: payload.source,
          endReason: payload.endReason,
          hadLectureInterruption,
          engineMode: engine.getMode(),
          isExhausted: engine.isExhausted(),
          playbackCompleted,
        });
        if (!eligible) return;

        // Use the restored engine position, not the stale React currentScene.
        const sceneId = engine.getCurrentSceneId();
        if (!sceneId || !chatAreaRef.current) return;

        // startLecture is async — re-check the engine is still idle AND still
        // the installed engine afterwards. A scene switch during the await
        // stops the captured engine (leaving it idle, so the mode check alone
        // passes) and installs a new one; resuming the orphan would emit
        // progress snapshots for the old scene over the new scene's cursor.
        const sessionId = await chatAreaRef.current.startLecture(sceneId);
        if (engineRef.current !== engine) {
          await chatAreaRef.current.endSession(sessionId);
          return;
        }
        if (engine.getMode() !== 'idle') {
          // The engine left idle during the async startLecture (e.g. a new live
          // session began) — tear down the lecture session we just
          // created/reactivated so it doesn't linger without playing.
          await chatAreaRef.current.endSession(sessionId);
          return;
        }
        lectureSessionIdRef.current = sessionId;
        engine.continuePlayback();
      },
      [doSessionCleanup, isCurrentChatProducer, playbackCompleted],
    );

    // Imperative teardown so the parent can `await` SSE / engine / TTS
    // shutdown before flipping mode to 'edit'. Mirrors what the old in-
    // component `handleToggleEditMode` did, but exposed through ref so
    // the toggle lives one layer up.
    useImperativeHandle(
      ref,
      () => ({
        teardown: async () => {
          classroomLiveRuntime.advanceSession();
          cancelAutoAdvanceTimer();
          await chatAreaRef.current?.endActiveSession();
          if (discussionAbortRef.current) {
            discussionAbortRef.current.abort();
            discussionAbortRef.current = null;
          }
          engineRef.current?.stop();
          discussionTTS.cleanup();
          resetSceneState();
          dispatchClassroomRuntime({ type: 'session.cleaned' });
        },
      }),
      [cancelAutoAdvanceTimer, classroomLiveRuntime, discussionTTS, resetSceneState],
    );

    const clearPresentationIdleTimer = useCallback(() => {
      if (presentationIdleTimerRef.current) {
        clearTimeout(presentationIdleTimerRef.current);
        presentationIdleTimerRef.current = null;
      }
    }, []);

    const resetPresentationIdleTimer = useCallback(() => {
      setControlsVisible(true);
      clearPresentationIdleTimer();
      if (isPresenting && !isPresentationInteractionActive) {
        presentationIdleTimerRef.current = setTimeout(() => {
          setControlsVisible(false);
        }, 3000);
      }
    }, [clearPresentationIdleTimer, isPresenting, isPresentationInteractionActive]);

    const togglePresentation = useCallback(async () => {
      const stageElement = stageRef.current;
      if (!stageElement) return;

      try {
        if (document.fullscreenElement === stageElement) {
          // Unlock Escape key before exiting fullscreen
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigator as any).keyboard?.unlock?.();
          await document.exitFullscreen();
          return;
        }

        setControlsVisible(true);
        await stageElement.requestFullscreen();
        // Lock Escape key so it doesn't auto-exit fullscreen (#255)
        // Escape is handled manually in our keydown handler instead
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (navigator as any).keyboard?.lock?.(['Escape']).catch(() => {});
        setSidebarCollapsed(true);
        setChatAreaCollapsed(true);
      } catch {
        // Firefox may deny fullscreen from certain keyboard events (e.g. F11)
        console.warn('[Presentation] Fullscreen request denied — browser policy');
      }
    }, [setChatAreaCollapsed, setSidebarCollapsed]);

    useEffect(() => {
      const onFullscreenChange = () => {
        const active = document.fullscreenElement === stageRef.current;
        dispatchClassroomRuntime({ type: 'presentation.changed', active });

        if (!active) {
          // Ensure keyboard unlock on any fullscreen exit
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigator as any).keyboard?.unlock?.();
          setControlsVisible(true);
          clearPresentationIdleTimer();
        }
      };

      document.addEventListener('fullscreenchange', onFullscreenChange);
      return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
    }, [clearPresentationIdleTimer]);

    useEffect(() => {
      if (!isPresenting) {
        setControlsVisible(true);
        clearPresentationIdleTimer();
        return;
      }

      const handleActivity = () => {
        resetPresentationIdleTimer();
      };

      window.addEventListener('mousemove', handleActivity);
      window.addEventListener('mousedown', handleActivity);
      window.addEventListener('touchstart', handleActivity);
      if (isPresentationInteractionActive) {
        setControlsVisible(true);
        clearPresentationIdleTimer();
      } else {
        resetPresentationIdleTimer();
      }

      return () => {
        window.removeEventListener('mousemove', handleActivity);
        window.removeEventListener('mousedown', handleActivity);
        window.removeEventListener('touchstart', handleActivity);
        clearPresentationIdleTimer();
      };
    }, [
      clearPresentationIdleTimer,
      isPresenting,
      isPresentationInteractionActive,
      resetPresentationIdleTimer,
    ]);

    // Initialize playback engine when scene changes
    useEffect(() => {
      let cancelled = false;
      const initializationEpoch = ++playbackInitializationEpochRef.current;
      readyPlaybackSceneIdRef.current = null;
      const initializeScene = async () => {
        const previousSceneId = activeSceneIdRef.current;
        if (previousSceneId && previousSceneId !== currentScene?.id) {
          saveSceneResumePosition(previousSceneId, currentPlaybackActionIndexRef.current);
        }

        // Invalidate both scene- and session-scoped live callbacks before async teardown.
        classroomLiveRuntime.advanceScene();

        // Wait for an in-flight presentation action before initializing the next
        // scene against shared whiteboard state.
        await chatAreaRef.current?.endActiveSession({ source: 'scene_switch' });
        if (cancelled || playbackInitializationEpochRef.current !== initializationEpoch) {
          return;
        }

        // Also abort the engine-level discussion controller
        if (discussionAbortRef.current) {
          discussionAbortRef.current.abort();
          discussionAbortRef.current = null;
        }

        // Stop any in-flight discussion TTS audio on scene switch
        discussionTTS.cleanup();

        const sessionResumeCursor =
          currentScene && typeof window !== 'undefined'
            ? getActionResumeRestoreCursor(
                readActionResumeState(window.sessionStorage, actionResumeStorageKey),
                currentScene.id,
                currentScene.actions ?? [],
              )
            : { actionIndex: 0, position: null };
        let savedResumeActionIndex = sessionResumeCursor.actionIndex;
        const playbackStageId = stage?.id ?? currentScene?.stageId;
        if (currentScene && playbackStageId && !sessionResumeCursor.position) {
          try {
            const cursor = await loadCursor(playbackStageId);
            if (
              cursor?.sceneId === currentScene.id &&
              currentScene.actions?.[cursor.actionIndex] &&
              canJumpWithinReconstructablePrefix(currentScene.actions, 0, cursor.actionIndex)
            ) {
              savedResumeActionIndex = cursor.actionIndex;
            }
          } catch (error) {
            console.warn(`Failed to load playback cursor for stage ${playbackStageId}:`, error);
          }
        }

        if (cancelled || playbackInitializationEpochRef.current !== initializationEpoch) {
          return;
        }

        const savedResumeAction = currentScene?.actions?.[savedResumeActionIndex];

        // Reset all roundtable/live state so scenes are fully isolated. Use the
        // saved action cursor immediately so mount/refresh cannot persist the
        // default first-speech cursor before the async engine jump finishes.
        resetSceneState({
          actionIndex: savedResumeActionIndex,
          lectureSpeech:
            savedResumeAction?.type === 'speech' ? (savedResumeAction as SpeechAction).text : null,
        });

        // A slide scene with no actions is still playable: the engine dwells on it
        // (see resolvePlaybackCursor) so a freshly inserted / emptied blank slide
        // shows for a beat and auto-play advances past it. Non-slide scenes
        // (quiz / interactive / pbl) without timeline actions get no lecture engine
        // as before. Don't touch `autoStartRef` here: in the PENDING_SCENE_ID
        // handoff `currentScene` is null while a pending auto-start legitimately
        // waits for the next generated scene to materialize.
        const hasPlayableActions =
          !!currentScene?.actions &&
          (currentScene.actions.length > 0 || currentScene.type === 'slide');
        if (!currentScene || !hasPlayableActions) {
          engineRef.current?.stop();
          engineRef.current = null;
          setEngineMode('idle');
          activeSceneIdRef.current = currentSceneId;

          return;
        }

        // Stop previous engine
        if (engineRef.current) {
          engineRef.current.stop();
        }

        // Widget iframe messaging callback for interactive scenes, resolved lazily
        // at send time (keyed by sceneId). The interactive iframe now lives in the
        // keep-alive host (#619), which registers its postMessage callback a commit
        // after this engine is built — so resolving eagerly here would capture null
        // on a scene's first visit and silently drop every widget action. Looking it
        // up per-send always sees the live registration.
        const sceneIdForWidget = currentScene.id;
        const widgetSendMessage = (type: string, payload: Record<string, unknown>) =>
          useWidgetIframeStore.getState().getSendMessage(sceneIdForWidget)?.(type, payload);

        // Create ActionEngine for playback (with audioPlayer for TTS and widget messaging)
        const actionEngine = new ActionEngine(
          useStageStore,
          audioPlayerRef.current,
          widgetSendMessage,
        );

        // Create new PlaybackEngine
        const engine = new PlaybackEngine([currentScene], actionEngine, audioPlayerRef.current, {
          onModeChange: (mode) => {
            setEngineMode(mode);
          },
          onProgress: (snapshot) => {
            // Identity guard: a superseded engine (scene switch during an
            // async resume) must not publish its old scene's position over
            // the installed engine's cursor.
            if (engineRef.current !== null && engineRef.current !== engine) return;
            updateCurrentPlaybackActionIndex(snapshot.actionIndex);
            saveSceneResumePosition(snapshot.sceneId, snapshot.actionIndex);
            if (playbackStageId && snapshot.sceneId) {
              scheduleCursorSave(playbackStageId, {
                sceneId: snapshot.sceneId,
                actionIndex: snapshot.actionIndex,
                updatedAt: new Date().toISOString(),
              });
            }
          },
          onSceneChange: (_sceneId) => {
            // Scene change handled by engine
          },
          onSpeechStart: (text) => {
            setLectureSpeech(text);
            // Add to lecture session with incrementing index for dedup
            // Chat area pacing is handled by the StreamBuffer (onTextReveal)
            if (lectureSessionIdRef.current) {
              const idx = lectureActionCounterRef.current++;
              const speechId = `speech-${Date.now()}`;
              chatAreaRef.current?.addLectureMessage(
                lectureSessionIdRef.current,
                { id: speechId, type: 'speech', text } as Action,
                idx,
              );
              // Track active bubble for highlight (Issue 8)
              const msgId = chatAreaRef.current?.getLectureMessageId(lectureSessionIdRef.current!);
              if (msgId) setActiveBubbleId(msgId);
            }
          },
          onSpeechEnd: () => {
            // Don't clear lectureSpeech — let it persist until the next
            // onSpeechStart replaces it or the scene transitions.
            // Clearing here causes fallback to idleText (first sentence).
            setActiveBubbleId(null);
          },
          onEffectFire: (effect: Effect) => {
            // Add to lecture session with incrementing index
            if (
              lectureSessionIdRef.current &&
              (effect.kind === 'spotlight' || effect.kind === 'laser')
            ) {
              const idx = lectureActionCounterRef.current++;
              chatAreaRef.current?.addLectureMessage(
                lectureSessionIdRef.current,
                {
                  id: `${effect.kind}-${Date.now()}`,
                  type: effect.kind,
                  elementId: effect.targetId,
                } as Action,
                idx,
              );
            }
          },
          onProactiveShow: (trigger) => {
            if (!trigger.agentId) {
              // Mutate in-place so engine.currentTrigger also gets the agentId
              // (confirmDiscussion reads agentId from the same object reference)
              trigger.agentId = pickStudentAgent();
            }
            setDiscussionTrigger(trigger);
          },
          onProactiveHide: () => {
            setDiscussionTrigger(null);
          },
          onDiscussionConfirmed: (topic, prompt, agentId) => {
            // Start SSE discussion via ChatArea
            handleDiscussionSSE(topic, prompt, agentId);
          },
          onDiscussionEnd: () => {
            classroomLiveRuntime.advanceSession();
            // Abort any active SSE
            if (discussionAbortRef.current) {
              discussionAbortRef.current.abort();
              discussionAbortRef.current = null;
            }
            setDiscussionTrigger(null);
            // Stop any in-flight discussion TTS audio
            discussionTTS.cleanup();
            // Clear roundtable state (idempotent — may already be cleared by doSessionCleanup)
            resetLiveState();
            // Only show flash for engine-initiated ends (not manual stop — that's handled by doSessionCleanup)
            if (!manualStopRef.current) {
              showSessionEndFlash('discussion');
            }
            // If all actions are exhausted (discussion was the last action), mark
            // playback as completed so the bubble shows reset instead of play.
            if (engineRef.current?.isExhausted()) {
              setPlaybackCompleted(true);
            }
          },
          onUserInterrupt: (text) => {
            // User interrupted → start a discussion via chat
            const snapshot = pendingInterruptElementReferenceRef.current;
            pendingInterruptElementReferenceRef.current = undefined;
            void sendMessageWithElementReference(text, snapshot);
          },
          isAgentSelected: (agentId) => {
            const ids = useSettingsStore.getState().selectedAgentIds;
            return ids.includes(agentId);
          },
          getPlaybackSpeed: () => useSettingsStore.getState().playbackSpeed || 1,
          onComplete: () => {
            // lectureSpeech intentionally NOT cleared — last sentence stays visible
            // until scene transition (auto-play) or user restarts. Scene change
            // effect handles the reset.
            updateCurrentPlaybackActionIndex(currentScene.actions?.length ?? 0);
            clearSceneResumePosition(currentScene.id);
            setPlaybackCompleted(true);

            // End lecture session on playback complete
            if (lectureSessionIdRef.current) {
              chatAreaRef.current?.endSession(lectureSessionIdRef.current);
              lectureSessionIdRef.current = null;
            }
            // Auto-play: advance to next scene after a short pause
            const { autoPlayLecture } = useSettingsStore.getState();
            if (autoPlayLecture) {
              cancelAutoAdvanceTimer();
              const scheduledSceneId = currentScene.id;
              autoAdvanceTimerRef.current = setTimeout(() => {
                autoAdvanceTimerRef.current = null;
                const stageState = useStageStore.getState();
                if (stageState.currentSceneId !== scheduledSceneId) return;
                if (!useSettingsStore.getState().autoPlayLecture) return;
                const allScenes = stageState.scenes;
                const curId = stageState.currentSceneId;
                const idx = allScenes.findIndex((s) => s.id === curId);
                if (idx >= 0 && idx < allScenes.length - 1) {
                  const currentScene = allScenes[idx];
                  if (
                    currentScene.type === 'quiz' ||
                    currentScene.type === 'interactive' ||
                    currentScene.type === 'pbl'
                  ) {
                    return;
                  }
                  autoStartRef.current = true;
                  stageState.setCurrentSceneId(allScenes[idx + 1].id);
                } else if (
                  idx === allScenes.length - 1 &&
                  stageState.generatingOutlines.length > 0
                ) {
                  // Last scene exhausted but next is still generating — go to pending page
                  const currentScene = allScenes[idx];
                  if (
                    currentScene.type === 'quiz' ||
                    currentScene.type === 'interactive' ||
                    currentScene.type === 'pbl'
                  ) {
                    return;
                  }
                  autoStartRef.current = true;
                  stageState.setCurrentSceneId(PENDING_SCENE_ID);
                }
              }, 1500);
            }
          },
        });

        engineRef.current = engine;
        activeSceneIdRef.current = currentScene.id;
        const initializationIsCurrent = () =>
          !cancelled &&
          playbackInitializationEpochRef.current === initializationEpoch &&
          engineRef.current === engine &&
          useStageStore.getState().currentSceneId === currentScene.id;

        // Auto-start if triggered by auto-play scene advance
        if (autoStartRef.current) {
          autoStartRef.current = false;
          (async () => {
            if (currentScene && chatAreaRef.current) {
              const sessionId = await chatAreaRef.current.startLecture(currentScene.id);
              if (!initializationIsCurrent()) return;
              lectureSessionIdRef.current = sessionId;
              lectureActionCounterRef.current = 0;
            }
            if (!initializationIsCurrent()) return;
            pendingPlaySceneIdRef.current = null;
            readyPlaybackSceneIdRef.current = currentScene.id;
            engine.start();
          })();
        } else {
          void (async () => {
            // Load saved playback state and restore position before consuming
            // an early Play click, so the click resumes the saved action rather
            // than racing a later jump back to it.
            if (savedResumeActionIndex > 0 && engine.canJumpToAction(savedResumeActionIndex)) {
              const restored = await engine.jumpToAction(savedResumeActionIndex, {
                autoplay: false,
              });
              if (!initializationIsCurrent()) return;
              if (restored) {
                updateCurrentPlaybackActionIndex(savedResumeActionIndex);
                const action = currentScene.actions?.[savedResumeActionIndex];
                if (action?.type === 'speech') {
                  setLectureSpeech(action.text);
                }
              }
            }

            if (!initializationIsCurrent()) return;
            const consumePendingPlay = pendingPlaySceneIdRef.current === currentScene.id;
            if (consumePendingPlay && chatAreaRef.current) {
              const sessionId = await chatAreaRef.current.startLecture(currentScene.id);
              if (!initializationIsCurrent()) return;
              lectureSessionIdRef.current = sessionId;
            }
            if (!initializationIsCurrent()) return;
            if (pendingPlaySceneIdRef.current !== null) {
              pendingPlaySceneIdRef.current = null;
            }
            readyPlaybackSceneIdRef.current = currentScene.id;
            if (consumePendingPlay) {
              engine.continuePlayback();
            }
          })();
        }
      };

      void initializeScene();
      return () => {
        cancelled = true;
        cancelAutoAdvanceTimer();
        if (playbackInitializationEpochRef.current === initializationEpoch) {
          playbackInitializationEpochRef.current += 1;
          readyPlaybackSceneIdRef.current = null;
        }
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Only re-run when scene changes, functions are stable refs
    }, [currentScene]);

    // Cleanup on unmount
    useEffect(() => {
      const audioPlayer = audioPlayerRef.current;
      const chatArea = chatAreaRef.current;
      classroomLiveRuntime.activate();
      return () => {
        classroomLiveRuntime.deactivate();
        cancelAutoAdvanceTimer();
        if (endFlashTimerRef.current) clearTimeout(endFlashTimerRef.current);
        endFlashTimerRef.current = null;
        if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current);
        pendingPlaySceneIdRef.current = null;
        readyPlaybackSceneIdRef.current = null;
        playbackInitializationEpochRef.current += 1;
        cursorSaveTimerRef.current = null;
        const pendingCursor = pendingCursorRef.current;
        pendingCursorRef.current = null;
        if (pendingCursor) persistCursorSafely(pendingCursor);
        saveSceneResumePosition(activeSceneIdRef.current, currentPlaybackActionIndexRef.current);
        if (engineRef.current) {
          engineRef.current.stop();
        }
        audioPlayer.destroy();
        if (discussionAbortRef.current) {
          discussionAbortRef.current.abort();
        }
        discussionTTS.cleanup();
        chatArea?.endActiveSession();
        clearPresentationIdleTimer();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup, clearPresentationIdleTimer is stable
    }, []);

    // Sync mute state from settings store to audioPlayer
    useEffect(() => {
      audioPlayerRef.current.setMuted(ttsMuted);
    }, [ttsMuted]);

    // Sync volume from settings store to audioPlayer
    const ttsVolume = useSettingsStore((s) => s.ttsVolume);
    useEffect(() => {
      if (!ttsMuted) {
        audioPlayerRef.current.setVolume(ttsVolume);
      }
    }, [ttsVolume, ttsMuted]);

    // Sync playback speed to audio player (for live-updating current audio)
    const playbackSpeed = useSettingsStore((s) => s.playbackSpeed);
    const setPlaybackSpeed = useSettingsStore((s) => s.setPlaybackSpeed);
    const autoPlayLecture = useSettingsStore((s) => s.autoPlayLecture);
    const setAutoPlayLecture = useSettingsStore((s) => s.setAutoPlayLecture);
    useEffect(() => {
      audioPlayerRef.current.setPlaybackRate(playbackSpeed);
    }, [playbackSpeed]);

    /**
     * Handle discussion SSE — POST /api/chat and push events to engine
     */
    const handleDiscussionSSE = useCallback(
      async (topic: string, prompt?: string, agentId?: string) => {
        // Start discussion display in ChatArea (lecture speech is preserved independently)
        chatAreaRef.current?.startDiscussion({
          topic,
          prompt,
          agentId: agentId || 'default-1',
        });
        // Auto-switch to chat tab when discussion starts
        chatAreaRef.current?.switchToTab('chat');
        // Immediately mark streaming for synchronized stop button
        setChatIsStreaming(true);
        setChatSessionType('discussion');
        // Optimistic thinking: show thinking dots immediately (same as onMessageSend)
        setThinkingState({ stage: 'director' });
      },
      [setThinkingState],
    );

    // First speech text for idle display (extracted here for playbackView)
    const firstSpeechText = useMemo(
      () =>
        currentScene?.actions?.find((a): a is SpeechAction => a.type === 'speech')?.text ?? null,
      [currentScene],
    );

    // Whether the speaking agent is a student (for bubble role derivation)
    const speakingStudentFlag = useMemo(() => {
      if (!speakingAgentId) return false;
      const agent = useAgentRegistry.getState().getAgent(speakingAgentId);
      return agent?.role !== 'teacher';
    }, [speakingAgentId]);

    // Stage island projection reads the route-scoped live runtime directly.
    const projectPlaybackView = useCallback(
      (live: ClassroomLiveRuntimeState) =>
        computePlaybackView({
          engineMode,
          lectureSpeech,
          liveSpeech: live.liveSpeech,
          speakingAgentId,
          thinkingState: live.thinkingState,
          isCueUser,
          isTopicPending,
          chatIsStreaming,
          discussionTrigger,
          playbackCompleted,
          idleText: firstSpeechText,
          speakingStudent: speakingStudentFlag,
          sessionType: chatSessionType,
        }),
      [
        engineMode,
        lectureSpeech,
        speakingAgentId,
        isCueUser,
        isTopicPending,
        chatIsStreaming,
        discussionTrigger,
        playbackCompleted,
        firstSpeechText,
        speakingStudentFlag,
        chatSessionType,
      ],
    );
    const projectPlaybackViewRef = useRef(projectPlaybackView);
    const projectedCurrentSceneIdRef = useRef(currentSceneId);
    useLayoutEffect(() => {
      projectPlaybackViewRef.current = projectPlaybackView;
      projectedCurrentSceneIdRef.current = currentSceneId;
    }, [currentSceneId, projectPlaybackView]);

    /**
     * Gated scene switch — if a topic is active, show AlertDialog before switching.
     * Returns true if the switch was immediate, false if gated (dialog shown).
     */
    const gatedSceneSwitch = useCallback(
      async (targetSceneId: string): Promise<boolean> => {
        const requestId = ++sceneSwitchRequestRef.current;
        if (targetSceneId === projectedCurrentSceneIdRef.current) {
          setPendingSceneId(null);
          return false;
        }
        cancelAutoAdvanceTimer();
        if (projectPlaybackViewRef.current(classroomLiveRuntime.getState()).isTopicActive) {
          setPendingSceneId(targetSceneId);
          return false;
        }
        await chatAreaRef.current?.endActiveSession({ source: 'scene_switch' });
        if (requestId !== sceneSwitchRequestRef.current) return false;
        setCurrentSceneId(targetSceneId);
        return true;
      },
      [cancelAutoAdvanceTimer, classroomLiveRuntime, setCurrentSceneId],
    );

    /** User confirmed scene switch via AlertDialog */
    const confirmSceneSwitch = useCallback(async () => {
      if (!pendingSceneId) return;
      const targetSceneId = pendingSceneId;
      const requestId = ++sceneSwitchRequestRef.current;
      sceneSwitchConfirmingRef.current = true;
      setPendingSceneId(null);
      try {
        await chatAreaRef.current?.endActiveSession({ source: 'scene_switch' });
        if (requestId !== sceneSwitchRequestRef.current) return;
        doSessionCleanup();
        setCurrentSceneId(targetSceneId);
      } finally {
        sceneSwitchConfirmingRef.current = false;
      }
    }, [pendingSceneId, setCurrentSceneId, doSessionCleanup]);

    /** User cancelled scene switch via AlertDialog */
    const cancelSceneSwitch = useCallback(() => {
      sceneSwitchRequestRef.current += 1;
      setPendingSceneId(null);
    }, []);

    // play/pause toggle
    const handlePlayPause = useCallback(async () => {
      const engine = engineRef.current;
      const currentPlaybackSceneId = currentScene?.id ?? null;
      if (
        !engine ||
        !currentPlaybackSceneId ||
        readyPlaybackSceneIdRef.current !== currentPlaybackSceneId ||
        activeSceneIdRef.current !== currentPlaybackSceneId
      ) {
        pendingPlaySceneIdRef.current = currentPlaybackSceneId;
        return;
      }

      const mode = engine.getMode();
      if (mode === 'playing' || mode === 'live') {
        saveSceneResumePosition(currentScene?.id, currentPlaybackActionIndexRef.current);
        engine.pause();
        // Pause lecture buffer so text stops immediately
        if (lectureSessionIdRef.current) {
          chatAreaRef.current?.pauseBuffer(lectureSessionIdRef.current);
        }
      } else if (mode === 'paused') {
        engine.resume();
        // Resume lecture buffer
        if (lectureSessionIdRef.current) {
          chatAreaRef.current?.resumeBuffer(lectureSessionIdRef.current);
        }
      } else {
        const wasCompleted = playbackCompleted;
        setPlaybackCompleted(false);
        // Starting playback - create/reuse lecture session
        if (currentScene && chatAreaRef.current) {
          const sessionId = await chatAreaRef.current.startLecture(currentScene.id);
          lectureSessionIdRef.current = sessionId;
        }
        if (wasCompleted) {
          // Restart from beginning (user clicked restart after completion)
          lectureActionCounterRef.current = 0;
          engine.start();
        } else {
          // Continue from current position (e.g. after discussion end)
          engine.continuePlayback();
        }
      }
    }, [playbackCompleted, currentScene, saveSceneResumePosition]);

    // get scene information
    const isPendingScene = currentSceneId === PENDING_SCENE_ID;
    const hasNextPending = generatingOutlines.length > 0;
    // True when every outline has materialized into a scene and nothing is
    // currently generating — signals the classroom has finished and the user
    // can see a completion page. Comparing scenes.length === outlines.length
    // (rather than just `scenes.length > 0`) means a partial generation with
    // some failed outlines does not falsely trigger completion. The persisted
    // generationComplete flag also marks completion directly, so an edited
    // finished deck (e.g. a deleted slide, leaving outlines.length > scenes)
    // still reads as complete.
    const isCourseComplete =
      generationComplete ||
      (outlines.length > 0 && scenes.length === outlines.length && generatingOutlines.length === 0);
    const canAdvanceToPendingSlot = hasNextPending || isCourseComplete;

    // previous scene (gated)
    const handlePreviousScene = useCallback(() => {
      if (isPendingScene) {
        // From pending page → go to last real scene
        if (scenes.length > 0) {
          void gatedSceneSwitch(scenes[scenes.length - 1].id);
        }
        return;
      }
      const currentIndex = scenes.findIndex((s) => s.id === currentSceneId);
      if (currentIndex > 0) {
        void gatedSceneSwitch(scenes[currentIndex - 1].id);
      }
    }, [currentSceneId, gatedSceneSwitch, isPendingScene, scenes]);

    // next scene (gated)
    const handleNextScene = useCallback(() => {
      if (isPendingScene) return; // Already on pending, nowhere to go
      const currentIndex = scenes.findIndex((s) => s.id === currentSceneId);
      if (currentIndex < scenes.length - 1) {
        void gatedSceneSwitch(scenes[currentIndex + 1].id);
      } else if (canAdvanceToPendingSlot) {
        // On last real scene → advance to pending slot (generating or completion page)
        void gatedSceneSwitch(PENDING_SCENE_ID);
      }
    }, [currentSceneId, gatedSceneSwitch, canAdvanceToPendingSlot, isPendingScene, scenes]);

    const currentSceneIndex = isPendingScene
      ? scenes.length
      : scenes.findIndex((s) => s.id === currentSceneId);
    const totalScenesCount = scenes.length + (canAdvanceToPendingSlot ? 1 : 0);
    const { canvasEngineState, showStopDiscussion, showElementReference, canPickSlideElement } =
      useMemo(
        () =>
          projectZhiyuClassroomControls({
            engineMode,
            chatIsStreaming,
            chatIsSoftClosing,
            chatSessionType,
            piChatEnabled,
            mode,
            whiteboardOpen,
            currentSceneType: currentScene?.type ?? null,
            currentSceneContentType: currentScene?.content.type ?? null,
          }),
        [
          chatIsSoftClosing,
          chatIsStreaming,
          chatSessionType,
          currentScene?.content.type,
          currentScene?.type,
          engineMode,
          mode,
          piChatEnabled,
          whiteboardOpen,
        ],
      );
    const handlePickElement = useCallback(
      (element: PPTElement) => {
        if (currentScene?.type !== 'slide' || currentScene.content.type !== 'slide') return;
        const selectionVersion = selectionVersionRef.current + 1;
        selectionVersionRef.current = selectionVersion;
        const { displaySummary } = getSlideElementPresentation(element, t);
        setDraftElementReference({
          reference: {
            kind: 'slide_element',
            sceneId: currentScene.id,
            elementId: element.id,
          },
          selectionVersion,
          sceneOrder: currentSceneIndex >= 0 ? currentSceneIndex : currentScene.order,
          elementType: element.type,
          displaySummary,
        });
        setElementPickActive(false);
      },
      [currentScene, currentSceneIndex, setDraftElementReference, t],
    );

    const handleToggleElementPick = useCallback(() => {
      if (!canPickSlideElement) return;
      setElementPickActive((active) => !active);
    }, [canPickSlideElement]);

    useEffect(() => {
      if (whiteboardOpen || !canPickSlideElement) setElementPickActive(false);
    }, [canPickSlideElement, whiteboardOpen]);

    useEffect(() => {
      const previousSceneId = elementReferenceSceneIdRef.current;
      elementReferenceSceneIdRef.current = currentSceneId;
      if (previousSceneId === currentSceneId) return;
      setDraftElementReference(null);
    }, [currentSceneId, setDraftElementReference]);

    // get action information
    const totalActions = currentScene?.actions?.length || 0;
    const canJumpToAction = useCallback(
      (sceneId: string, actionIndex: number): boolean => {
        if (sceneId !== currentSceneId) return false;
        return canJumpWithinReconstructablePrefix(
          currentScene?.actions ?? [],
          currentPlaybackActionIndex,
          actionIndex,
        );
      },
      [currentPlaybackActionIndex, currentScene?.actions, currentSceneId],
    );

    const handleJumpToAction = useCallback(
      async (sceneId: string, actionIndex: number) => {
        const engine = engineRef.current;
        if (!engine || sceneId !== currentSceneId || !currentScene) return;
        const autoplay = engine.getMode() === 'playing';
        const jumped = await engine.jumpToAction(actionIndex, { autoplay });
        if (!jumped) return;
        setPlaybackCompleted(false);
        updateCurrentPlaybackActionIndex(actionIndex);
        const action = currentScene.actions?.[actionIndex];
        if (action?.type === 'speech') {
          setLectureSpeech(action.text);
        }
      },
      [currentScene, currentSceneId, updateCurrentPlaybackActionIndex],
    );

    // whiteboard toggle
    const handleWhiteboardToggle = useCallback(() => {
      if (!whiteboardOpen) setElementPickActive(false);
      setWhiteboardOpenManually(!whiteboardOpen);
    }, [setWhiteboardOpenManually, whiteboardOpen]);

    const isPresentationShortcutTarget = useCallback((target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;

      if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
        return true;
      }

      return (
        target.closest(
          ['input', 'textarea', 'select', '[role="slider"]', 'input[type="range"]'].join(', '),
        ) !== null
      );
    }, []);

    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented) return;
        // Let modifier-key combos (Ctrl+C, Ctrl+S, etc.) pass through to the browser
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (
          isPresentationShortcutTarget(event.target) ||
          isPresentationShortcutTarget(document.activeElement)
        ) {
          return;
        }

        switch (event.key) {
          case 'ArrowLeft':
            if (!isPresenting) return;
            event.preventDefault();
            handlePreviousScene();
            resetPresentationIdleTimer();
            break;
          case 'ArrowRight':
            if (!isPresenting) return;
            event.preventDefault();
            handleNextScene();
            resetPresentationIdleTimer();
            break;
          case ' ':
          case 'Spacebar':
            // During active QA/discussion, Roundtable owns Space for
            // buffer-level pause/resume — don't also fire engine play/pause.
            if (chatSessionType === 'qa' || chatSessionType === 'discussion') break;
            event.preventDefault();
            handlePlayPause();
            break;
          case 'Escape':
            // With keyboard.lock(), Escape no longer auto-exits fullscreen.
            // If panels are open, roundtable handles Escape (close panels).
            // If no panels are open, manually exit fullscreen.
            if (isPresenting && !isPresentationInteractionActive) {
              event.preventDefault();
              togglePresentation();
            }
            break;
          case 'ArrowUp':
            event.preventDefault();
            setTTSVolume(ttsVolume + 0.1);
            break;
          case 'ArrowDown':
            event.preventDefault();
            setTTSVolume(ttsVolume - 0.1);
            break;
          case 'm':
          case 'M':
            event.preventDefault();
            setTTSMuted(!ttsMuted);
            break;
          case 's':
          case 'S':
            event.preventDefault();
            toggleSceneRailPresentation();
            break;
          case 'c':
          case 'C':
            event.preventDefault();
            toggleInteractionPresentation();
            break;
          default:
            break;
        }
      };

      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [
      chatSessionType,
      handleNextScene,
      handlePlayPause,
      handlePreviousScene,
      isPresenting,
      isPresentationInteractionActive,
      isPresentationShortcutTarget,
      resetPresentationIdleTimer,
      setTTSMuted,
      setTTSVolume,
      toggleInteractionPresentation,
      toggleSceneRailPresentation,
      togglePresentation,
      ttsMuted,
      ttsVolume,
    ]);

    // Intercept F11 to use our presentation fullscreen instead of browser fullscreen
    // This way ESC can exit fullscreen (browser F11 fullscreen requires F11 to exit)
    useEffect(() => {
      const onF11 = (event: KeyboardEvent) => {
        if (event.key === 'F11') {
          event.preventDefault();
          togglePresentation();
        }
      };

      window.addEventListener('keydown', onF11);
      return () => window.removeEventListener('keydown', onF11);
    }, [togglePresentation]);

    // Build discussion request for Roundtable ProactiveCard from trigger
    const discussionRequest: DiscussionAction | null = discussionTrigger
      ? {
          type: 'discussion',
          id: discussionTrigger.id,
          topic: discussionTrigger.question,
          prompt: discussionTrigger.prompt,
          agentId: discussionTrigger.agentId || 'default-1',
        }
      : null;

    const projectClassroomLiveStatus = useCallback(
      (thinking: boolean) =>
        projectZhiyuClassroomLiveStatus({
          engineMode,
          chatSessionType,
          thinking,
        }),
      [chatSessionType, engineMode],
    );
    const renderClassroomRoles = useCallback(
      (thinkingState: ClassroomThinkingState) => (
        <div className="space-y-2">
          {participants.map((participant) => {
            const teaching = participant.id === speakingAgentId && engineMode === 'playing';
            const thinking = participant.id === thinkingState?.agentId;
            const status = thinking
              ? t('classroomWorkspace.roleStatus.thinking')
              : teaching
                ? t('classroomWorkspace.roleStatus.teaching')
                : t('classroomWorkspace.roleStatus.idle');
            return (
              <div
                key={participant.id}
                className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/70 p-3"
              >
                <img
                  src={participant.avatar}
                  alt=""
                  aria-hidden="true"
                  className="size-9 rounded-full object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-foreground">
                    {participant.name}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{status}</p>
                </div>
                <span
                  className={cn(
                    'size-2 rounded-full',
                    teaching && 'bg-primary',
                    thinking && 'bg-[var(--zhiyu-ai)]',
                    !teaching && !thinking && 'bg-muted-foreground/35',
                  )}
                  aria-hidden="true"
                />
              </div>
            );
          })}
        </div>
      ),
      [engineMode, participants, speakingAgentId, t],
    );
    const handleToggleMute = useCallback(() => {
      if (ttsEnabled) setTTSMuted(!ttsMuted);
    }, [setTTSMuted, ttsEnabled, ttsMuted]);
    const handleToggleAutoPlay = useCallback(() => {
      setAutoPlayLecture(!autoPlayLecture);
    }, [autoPlayLecture, setAutoPlayLecture]);
    const handleCyclePlaybackSpeed = useCallback(() => {
      const currentIndex = PLAYBACK_SPEEDS.indexOf(
        playbackSpeed as (typeof PLAYBACK_SPEEDS)[number],
      );
      setPlaybackSpeed(PLAYBACK_SPEEDS[(currentIndex + 1) % PLAYBACK_SPEEDS.length]);
    }, [playbackSpeed, setPlaybackSpeed]);

    const classroomCurrentSceneTitle =
      currentScene?.title || (isCourseComplete && isPendingScene ? t('stage.courseComplete') : '');
    const classroomHeader = useMemo(
      () =>
        !isPresenting && !hideHeader ? (
          <Header
            courseTitle={stage?.name}
            currentSceneTitle={classroomCurrentSceneTitle}
            mode={mode}
            proModeActive={proModeActive}
            canEdit={!!canEnterProMode}
            onToggleEditMode={onEnterProMode}
            backControl={headerBackControl}
            hideBackControl={hideHeaderBackControl}
            hideGlobalControls={hideHeaderGlobalControls}
            hideCourseActions={hideHeaderCourseActions}
          />
        ) : null,
      [
        canEnterProMode,
        classroomCurrentSceneTitle,
        headerBackControl,
        hideHeader,
        hideHeaderBackControl,
        hideHeaderCourseActions,
        hideHeaderGlobalControls,
        isPresenting,
        mode,
        onEnterProMode,
        proModeActive,
        stage?.name,
      ],
    );
    const classroomSceneRail = useMemo(
      () => (
        <SceneSidebar
          collapsed={presentedSidebarCollapsed}
          onCollapseChange={handleSceneRailPresentationChange}
          onSceneSelect={gatedSceneSwitch}
          onRetryOutline={onRetryOutline}
          generationJobDisplay={generationJobDisplay}
          isCourseComplete={isCourseComplete}
          hidden={isPresenting}
        />
      ),
      [
        gatedSceneSwitch,
        handleSceneRailPresentationChange,
        isCourseComplete,
        isPresenting,
        onRetryOutline,
        generationJobDisplay,
        presentedSidebarCollapsed,
      ],
    );

    return (
      <div
        ref={stageRef}
        className={cn(
          'flex-1 overflow-hidden bg-[#eef1ef] dark:bg-background',
          isPresenting && !controlsVisible && 'cursor-none',
        )}
      >
        <ZhiyuClassroomShell
          presenting={isPresenting}
          sceneRailCollapsed={presentedSidebarCollapsed}
          interactionCollapsed={presentedChatCollapsed}
          sceneRailDrawer={narrowViewport}
          interactionDrawer={compactViewport}
          onSceneRailDismiss={
            narrowViewport ? () => handleSceneRailPresentationChange(true) : undefined
          }
          onInteractionDismiss={
            compactViewport ? () => handleInteractionPresentationChange(true) : undefined
          }
          sceneRailDismissLabel={t('classroomWorkspace.collapseSceneRail')}
          interactionDismissLabel={t('classroomWorkspace.collapseInteraction')}
          sceneRailLabel={t('classroomWorkspace.sceneRail')}
          interactionLabel={t('classroomWorkspace.interactionTitle')}
          header={classroomHeader}
          sceneRail={classroomSceneRail}
          stage={
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              <div
                className="overflow-hidden relative flex-1 min-h-0 isolate"
                suppressHydrationWarning
              >
                <CanvasArea
                  currentScene={currentScene}
                  currentSceneIndex={currentSceneIndex}
                  scenesCount={totalScenesCount}
                  mode={mode}
                  engineState={canvasEngineState}
                  isLiveSession={
                    chatIsStreaming ||
                    chatIsSoftClosing ||
                    isTopicPending ||
                    engineMode === 'live' ||
                    !!chatSessionType
                  }
                  isSoftClosing={chatIsSoftClosing}
                  softCloseDeadline={softCloseDeadline}
                  whiteboardOpen={whiteboardOpen}
                  sidebarCollapsed={presentedSidebarCollapsed}
                  chatCollapsed={presentedChatCollapsed}
                  onToggleSidebar={toggleSceneRailPresentation}
                  onToggleChat={toggleInteractionPresentation}
                  onPrevSlide={handlePreviousScene}
                  onNextSlide={handleNextScene}
                  onPlayPause={handlePlayPause}
                  onWhiteboardClose={handleWhiteboardToggle}
                  isPresenting={isPresenting}
                  onTogglePresentation={togglePresentation}
                  showStopDiscussion={
                    engineMode === 'live' ||
                    ((chatIsStreaming || chatIsSoftClosing) &&
                      (chatSessionType === 'qa' || chatSessionType === 'discussion'))
                  }
                  onStopDiscussion={handleStopDiscussion}
                  onContinueDiscussion={handleContinueDiscussion}
                  showElementReference={showElementReference}
                  canPickSlideElement={canPickSlideElement}
                  elementPickActive={elementPickActive}
                  onToggleElementPick={handleToggleElementPick}
                  onPickElement={handlePickElement}
                  onCancelElementPick={() => setElementPickActive(false)}
                  hideToolbar={mode === 'playback' || (isPresenting && !controlsVisible)}
                  isPendingScene={isPendingScene}
                  isCourseComplete={isCourseComplete}
                  isGenerationFailed={
                    isPendingScene && failedOutlines.some((f) => f.id === generatingOutlines[0]?.id)
                  }
                  onRetryGeneration={
                    onRetryOutline && generatingOutlines[0]
                      ? () => onRetryOutline(generatingOutlines[0].id)
                      : undefined
                  }
                />
              </div>

              {/* Roundtable Area */}
              {mode === 'playback' && (
                <div
                  className={cn(
                    'transition-opacity duration-300',
                    !isPresenting && 'shrink-0',
                    isPresenting && 'absolute inset-x-0 bottom-0 z-20',
                  )}
                >
                  <ClassroomRoundtableIsland
                    runtime={classroomLiveRuntime}
                    projectPlaybackView={projectPlaybackView}
                    mode={mode}
                    initialParticipants={participants}
                    lectureSpeech={lectureSpeech}
                    idleText={firstSpeechText}
                    playbackCompleted={playbackCompleted}
                    discussionRequest={discussionRequest}
                    engineMode={engineMode}
                    isStreaming={chatIsStreaming}
                    audioIndicatorState={audioIndicatorState}
                    audioAgentId={audioAgentId}
                    sessionType={
                      chatSessionType === 'qa'
                        ? 'qa'
                        : chatSessionType === 'discussion'
                          ? 'discussion'
                          : undefined
                    }
                    speakingAgentId={speakingAgentId}
                    showEndFlash={showEndFlash}
                    endFlashSessionType={endFlashSessionType}
                    isCueUser={isCueUser}
                    isSoftClosing={chatIsSoftClosing}
                    softCloseDeadline={softCloseDeadline}
                    isTopicPending={isTopicPending}
                    onMessageSend={async (msg) => {
                      const draft = draftElementReferenceRef.current;
                      const elementReferenceSnapshot: ElementReferenceSendSnapshot | undefined =
                        draft
                          ? {
                              reference: draft.reference,
                              selectionVersion: draft.selectionVersion,
                            }
                          : undefined;
                      // Always clear Level-1 pause state — the closure may hold a stale
                      // isDiscussionPaused value (e.g. voice input's onTranscription callback
                      // captures onMessageSend before React re-renders with the updated state).
                      dispatchClassroomRuntime({
                        type: 'discussion.pauseChanged',
                        paused: false,
                      });
                      // Clear the sticky livePausedRef so the next agent-loop buffer
                      // starts unpaused. (pauseActiveLiveBuffer sets a ref that new
                      // buffers inherit — must be cleared before sendMessage creates one.)
                      chatAreaRef.current?.resumeActiveLiveBuffer();
                      // Flush any buffered / in-flight TTS audio from the previous
                      // agent turn so it doesn't leak into the next round.
                      discussionTTS.cleanup();
                      // Clear soft-paused state — user is continuing the topic
                      if (isTopicPending) {
                        setIsTopicPending(false);
                        setLiveSpeech(null);
                        setSpeakingAgentId(null);
                      }
                      setChatIsSoftClosing(false);
                      // User interrupts during playback — handleUserInterrupt triggers
                      // onUserInterrupt callback which already calls sendMessage, so skip
                      // the direct sendMessage below to avoid sending twice.
                      // Include 'paused' because onInputActivate pauses the engine before
                      // the user finishes typing — without this the interrupt position
                      // would never be saved and resuming after QA skips to the next sentence.
                      if (
                        engineRef.current &&
                        (engineMode === 'playing' ||
                          engineMode === 'live' ||
                          engineMode === 'paused')
                      ) {
                        pendingInterruptElementReferenceRef.current = elementReferenceSnapshot;
                        try {
                          engineRef.current.handleUserInterrupt(msg);
                        } finally {
                          pendingInterruptElementReferenceRef.current = undefined;
                        }
                      } else {
                        void sendMessageWithElementReference(msg, elementReferenceSnapshot);
                      }
                      // Auto-switch to chat tab when user sends a message
                      chatAreaRef.current?.switchToTab('chat');
                      setIsCueUser(false);
                      // Immediately mark streaming for synchronized stop button
                      setChatIsStreaming(true);
                      setChatSessionType(chatSessionType || 'qa');
                      // Optimistic thinking: show thinking dots immediately so there's
                      // no blank gap between userMessage expiry and the SSE thinking event.
                      // The real SSE event will overwrite this with the same or updated value.
                      setThinkingState({ stage: 'director' });
                    }}
                    onDiscussionStart={() => {
                      // User clicks "Join" on ProactiveCard
                      engineRef.current?.confirmDiscussion();
                    }}
                    onDiscussionSkip={() => {
                      // User clicks "Skip" on ProactiveCard
                      engineRef.current?.skipDiscussion();
                    }}
                    onStopDiscussion={handleStopDiscussion}
                    onContinueDiscussion={handleContinueDiscussion}
                    onUserInputActivity={() => {
                      handleContinueDiscussion();
                    }}
                    onInputActivate={() => {
                      // Level-1 pause: freeze buffer tick + TTS audio while SSE keeps buffering.
                      // User resumes manually via Space / pause button after closing the input.
                      // No isDiscussionPaused guard — always attempt to pause the buffer.
                      // The return value ensures UI state stays in sync with buffer state.
                      if (chatSessionType === 'qa' || chatSessionType === 'discussion') {
                        const paused = chatAreaRef.current?.pauseActiveLiveBuffer();
                        if (paused) {
                          discussionTTS.pause();
                          dispatchClassroomRuntime({
                            type: 'discussion.pauseChanged',
                            paused: true,
                          });
                        }
                      }
                      // Also pause playback engine
                      if (
                        engineRef.current &&
                        (engineMode === 'playing' || engineMode === 'live')
                      ) {
                        engineRef.current.pause();
                      }
                    }}
                    onResumeTopic={doResumeTopic}
                    onPlayPause={handlePlayPause}
                    isDiscussionPaused={isDiscussionPaused}
                    onDiscussionPause={() => {
                      const paused = chatAreaRef.current?.pauseActiveLiveBuffer();
                      if (paused) {
                        discussionTTS.pause();
                        dispatchClassroomRuntime({
                          type: 'discussion.pauseChanged',
                          paused: true,
                        });
                      }
                    }}
                    onDiscussionResume={() => {
                      chatAreaRef.current?.resumeActiveLiveBuffer();
                      discussionTTS.resume();
                      dispatchClassroomRuntime({
                        type: 'discussion.pauseChanged',
                        paused: false,
                      });
                    }}
                    totalActions={totalActions}
                    currentActionIndex={currentPlaybackActionIndex ?? 0}
                    currentSceneIndex={currentSceneIndex}
                    scenesCount={totalScenesCount}
                    whiteboardOpen={whiteboardOpen}
                    sidebarCollapsed={presentedSidebarCollapsed}
                    chatCollapsed={presentedChatCollapsed}
                    onToggleSidebar={toggleSceneRailPresentation}
                    onToggleChat={toggleInteractionPresentation}
                    onPrevSlide={handlePreviousScene}
                    onNextSlide={handleNextScene}
                    onWhiteboardClose={handleWhiteboardToggle}
                    isPresenting={isPresenting}
                    controlsVisible={controlsVisible}
                    onTogglePresentation={togglePresentation}
                    onPresentationInteractionChange={setIsPresentationInteractionActive}
                    fullscreenContainerRef={stageRef}
                    showElementReference={showElementReference}
                    canPickSlideElement={canPickSlideElement}
                    elementPickActive={elementPickActive}
                    onToggleElementPick={handleToggleElementPick}
                    elementReferencePill={
                      draftElementReference
                        ? {
                            sceneLabel: t('chat.lectureNotes.pageLabel', {
                              n: (draftElementReference.sceneOrder ?? 0) + 1,
                            }),
                            elementType: getSlideElementTypeLabel(
                              draftElementReference.elementType,
                              t,
                            ),
                            displaySummary: draftElementReference.displaySummary,
                          }
                        : undefined
                    }
                    onClearElementReference={() => setDraftElementReference(null)}
                    hideEmbeddedToolbar={!isPresenting}
                  />
                </div>
              )}
            </div>
          }
          interaction={
            <ClassroomInteractionIsland
              runtime={classroomLiveRuntime}
              collapsed={presentedChatCollapsed || isPresenting}
              onCollapsedChange={handleInteractionPresentationChange}
              projectLiveStatus={projectClassroomLiveStatus}
              renderRolesContent={renderClassroomRoles}
              onTabChange={(tab) => {
                if (tab === 'lecture') chatAreaRef.current?.switchToTab('lecture');
                if (tab === 'discussion') chatAreaRef.current?.switchToTab('chat');
              }}
              persistentContent={
                <ChatArea
                  ref={chatAreaRef}
                  embedded
                  width={chatAreaWidth}
                  onWidthChange={setChatAreaWidth}
                  collapsed={false}
                  onCollapseChange={handleInteractionPresentationChange}
                  activeBubbleId={activeBubbleId}
                  onActiveBubble={(id, producerSessionId) => {
                    if (!isCurrentChatProducer(producerSessionId)) return;
                    setActiveBubbleId(id);
                  }}
                  currentSceneId={currentSceneId}
                  currentActionIndex={currentPlaybackActionIndex}
                  canJumpToAction={canJumpToAction}
                  onJumpToAction={(sceneId, actionIndex) => {
                    void handleJumpToAction(sceneId, actionIndex);
                  }}
                  onLiveSpeech={(text, agentId, producerSessionId) => {
                    if (!isCurrentChatProducer(producerSessionId)) return;
                    // Capture epoch at call time — discard if scene has changed since
                    const epoch = classroomLiveRuntime.captureEpoch();
                    // Use queueMicrotask to let any pending scene-switch reset settle first
                    queueMicrotask(() => {
                      if (
                        !isCurrentChatProducer(producerSessionId) ||
                        !classroomLiveRuntime.isCurrentEpoch(epoch)
                      ) {
                        return;
                      }
                      setLiveSpeech(text);
                      if (agentId !== undefined) {
                        setSpeakingAgentId(agentId);
                      }
                      if (text !== null || agentId) {
                        setChatIsStreaming(true);
                        setChatSessionType(chatAreaRef.current?.getActiveSessionType?.() ?? null);
                        setIsTopicPending(false);
                      } else if (text === null && agentId === null) {
                        setChatIsStreaming(false);
                        // Don't clear chatSessionType here — it's needed by the stop
                        // button when director cues user (cue_user → done → liveSpeech null).
                        // It gets properly cleared in doSessionCleanup and scene change.
                      }
                    });
                  }}
                  onSpeechProgress={(ratio, producerSessionId) => {
                    if (!isCurrentChatProducer(producerSessionId)) return;
                    const epoch = classroomLiveRuntime.captureEpoch();
                    queueMicrotask(() => {
                      if (
                        !isCurrentChatProducer(producerSessionId) ||
                        !classroomLiveRuntime.isCurrentEpoch(epoch)
                      ) {
                        return;
                      }
                      setSpeechProgress(ratio);
                    });
                  }}
                  onThinking={(state, producerSessionId) => {
                    if (!isCurrentChatProducer(producerSessionId)) return;
                    const epoch = classroomLiveRuntime.captureEpoch();
                    queueMicrotask(() => {
                      if (
                        !isCurrentChatProducer(producerSessionId) ||
                        !classroomLiveRuntime.isCurrentEpoch(epoch)
                      ) {
                        return;
                      }
                      setThinkingState(state);
                    });
                  }}
                  onCueUser={(_fromAgentId, _prompt, producerSessionId) => {
                    if (!isCurrentChatProducer(producerSessionId)) return;
                    setIsCueUser(true);
                  }}
                  onLiveSessionError={handleLiveSessionError}
                  onSoftCloseSession={(payload) => {
                    if (!isCurrentChatProducer(payload.sessionId)) return;
                    setThinkingState(null);
                    setSpeechProgress(null);
                    setIsCueUser(false);
                    setActiveBubbleId(null);
                  }}
                  onSoftClosingChange={(softClosing, deadline) => {
                    setChatIsSoftClosing(softClosing);
                    setSoftCloseDeadline(deadline);
                  }}
                  onStopSession={handleSessionStop}
                  onSegmentSealed={(messageId, partId, text, agentId, producerSessionId) => {
                    if (!isCurrentChatProducer(producerSessionId)) return;
                    discussionTTS.handleSegmentSealed(messageId, partId, text, agentId);
                  }}
                  shouldHoldAfterReveal={discussionTTS.shouldHold}
                />
              }
            />
          }
          playbackBar={
            <ZhiyuPlaybackBar
              currentSceneIndex={currentSceneIndex}
              scenesCount={totalScenesCount}
              engineState={canvasEngineState}
              isLiveSession={
                chatIsStreaming ||
                chatIsSoftClosing ||
                isTopicPending ||
                engineMode === 'live' ||
                !!chatSessionType
              }
              isSoftClosing={chatIsSoftClosing}
              softCloseDeadline={softCloseDeadline}
              whiteboardOpen={whiteboardOpen}
              sidebarCollapsed={presentedSidebarCollapsed}
              chatCollapsed={presentedChatCollapsed}
              onToggleSidebar={toggleSceneRailPresentation}
              onToggleChat={toggleInteractionPresentation}
              onPrevSlide={handlePreviousScene}
              onNextSlide={handleNextScene}
              onPlayPause={handlePlayPause}
              onWhiteboardClose={handleWhiteboardToggle}
              showStopDiscussion={showStopDiscussion}
              onStopDiscussion={handleStopDiscussion}
              onContinueDiscussion={handleContinueDiscussion}
              isPresenting={isPresenting}
              onTogglePresentation={togglePresentation}
              ttsEnabled={ttsEnabled}
              ttsMuted={ttsMuted}
              ttsVolume={ttsVolume}
              onToggleMute={handleToggleMute}
              onVolumeChange={setTTSVolume}
              autoPlayLecture={autoPlayLecture}
              onToggleAutoPlay={handleToggleAutoPlay}
              playbackSpeed={playbackSpeed}
              onCycleSpeed={handleCyclePlaybackSpeed}
              showElementReference={showElementReference}
              canPickSlideElement={canPickSlideElement}
              elementPickActive={elementPickActive}
              onToggleElementPick={handleToggleElementPick}
            />
          }
        />

        {/* Scene switch confirmation dialog */}
        <AlertDialog
          open={!!pendingSceneId}
          onOpenChange={(open) => {
            if (!open && !sceneSwitchConfirmingRef.current) cancelSceneSwitch();
          }}
        >
          <AlertDialogContent
            container={isPresenting ? stageRef.current : undefined}
            className="max-w-sm rounded-2xl p-0 overflow-hidden border-0 shadow-[0_25px_60px_-12px_rgba(0,0,0,0.15)] dark:shadow-[0_25px_60px_-12px_rgba(0,0,0,0.5)]"
          >
            <VisuallyHidden.Root>
              <AlertDialogTitle>{t('stage.confirmSwitchTitle')}</AlertDialogTitle>
            </VisuallyHidden.Root>
            {/* Top accent bar */}
            <div className="h-1 bg-gradient-to-r from-amber-400 via-orange-400 to-red-400" />

            <div className="px-6 pt-5 pb-2 flex flex-col items-center text-center">
              {/* Icon */}
              <div className="w-12 h-12 rounded-full bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center mb-4 ring-1 ring-amber-200/50 dark:ring-amber-700/30">
                <AlertTriangle className="w-6 h-6 text-amber-500 dark:text-amber-400" />
              </div>
              {/* Title */}
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-1.5">
                {t('stage.confirmSwitchTitle')}
              </h3>
              {/* Description */}
              <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                {t('stage.confirmSwitchMessage')}
              </p>
            </div>

            <AlertDialogFooter className="px-6 pb-5 pt-3 flex-row gap-3">
              <AlertDialogCancel onClick={cancelSceneSwitch} className="flex-1 rounded-xl">
                {t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmSceneSwitch}
                className="flex-1 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white border-0 shadow-md shadow-amber-200/50 dark:shadow-amber-900/30"
              >
                {t('common.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  },
);
