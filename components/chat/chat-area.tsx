'use client';

import {
  useImperativeHandle,
  forwardRef,
  useRef,
  useCallback,
  useState,
  useMemo,
  useEffect,
} from 'react';
import type { SessionType } from '@/lib/types/chat';
import type { DiscussionRequest } from '@/components/roundtable';
import type { Action } from '@/lib/types/action';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { buildLectureNotes } from '@/lib/chat/lecture-notes';
import { PanelRightClose, BookOpen, MessageSquare, ShieldCheck } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  useChatSessions,
  MANUAL_STOP_END_OPTIONS,
  type EndSessionOptions,
  type SessionCleanupPayload,
  type ChatMessageSendOptions,
} from './use-chat-sessions';
import { SessionList } from './session-list';
import { LectureNotesView } from './lecture-notes-view';
import { isGuidedLearningEnabled } from '@/lib/learning/feature-flags';
import type { GuidedLearningContext } from '@/lib/learning/guided-contracts';
import { nanoid } from 'nanoid';

interface ChatAreaProps {
  className?: string;
  /** Presentation-only embedding inside the ZHIYU interaction panel. */
  embedded?: boolean;
  width?: number;
  onWidthChange?: (width: number) => void;
  collapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  activeBubbleId?: string | null;
  onActiveBubble?: (messageId: string | null, producerSessionId: string) => void;
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
  onLiveSessionError?: (producerSessionId: string) => void;
  onSoftCloseSession?: (payload: SessionCleanupPayload) => void;
  onSoftClosingChange?: (softClosing: boolean, deadline?: number) => void;
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
  currentSceneId?: string | null;
  currentActionIndex?: number | null;
  canJumpToAction?: (sceneId: string, actionIndex: number) => boolean;
  onJumpToAction?: (sceneId: string, actionIndex: number) => void;
}

export interface ChatAreaRef {
  createSession: (type: SessionType, title: string) => Promise<string>;
  endSession: (sessionId: string, options?: EndSessionOptions) => Promise<void>;
  endActiveSession: (options?: EndSessionOptions) => Promise<void>;
  stopActiveSession: () => Promise<void>;
  continueActiveSoftClosingSession: () => boolean;
  softPauseActiveSession: () => Promise<void>;
  resumeActiveSession: () => Promise<void>;
  sendMessage: (content: string, options?: ChatMessageSendOptions) => Promise<void>;
  startDiscussion: (request: DiscussionRequest) => Promise<void>;
  startLecture: (sceneId: string) => Promise<string>;
  addLectureMessage: (sessionId: string, action: Action, actionIndex: number) => void;
  getIsStreaming: () => boolean;
  getActiveSessionType: () => string | null;
  getActiveSessionId: () => string | null;
  getLectureMessageId: (sessionId: string) => string | null;
  pauseBuffer: (sessionId: string) => void;
  resumeBuffer: (sessionId: string) => void;
  pauseActiveLiveBuffer: () => boolean;
  resumeActiveLiveBuffer: () => void;
  switchToTab: (tab: 'lecture' | 'chat') => void;
}

const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 240;
const MAX_WIDTH = 560;

export function GuidedModeToggle({
  enabled,
  active,
  disabled,
  label,
  description,
  onChange,
}: {
  enabled: boolean;
  active: boolean;
  disabled: boolean;
  label: string;
  description: string;
  onChange: (active: boolean) => void;
}) {
  if (!enabled) return null;
  return (
    <div
      data-testid="guided-learning-toggle"
      className="flex min-w-0 shrink-0 items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-gray-800"
    >
      <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#356B59] dark:text-[#9FC0B0]" />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-gray-600 dark:text-gray-300">
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-label={label}
        title={description}
        disabled={disabled}
        onClick={() => onChange(!active)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          active ? 'bg-[#356B59] dark:bg-[#7FA392]' : 'bg-gray-200 dark:bg-gray-700',
        )}
      >
        <span
          className={cn(
            'absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
            active ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

export const ChatArea = forwardRef<ChatAreaRef, ChatAreaProps>(
  (
    {
      className,
      embedded = false,
      width = DEFAULT_WIDTH,
      onWidthChange,
      collapsed = false,
      onCollapseChange,
      activeBubbleId,
      onActiveBubble,
      onLiveSpeech,
      onSpeechProgress,
      onThinking,
      onCueUser,
      onLiveSessionError,
      onSoftCloseSession,
      onSoftClosingChange,
      onStopSession,
      onSegmentSealed,
      shouldHoldAfterReveal,
      currentSceneId,
      currentActionIndex,
      canJumpToAction,
      onJumpToAction,
    },
    ref,
  ) => {
    const { t } = useI18n();
    const stage = useStageStore((s) => s.stage);
    const scenes = useStageStore((s) => s.scenes);
    const {
      sessions,
      activeSessionId,
      activeSessionType,
      expandedSessionIds,
      isStreaming,
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
      getLectureMessageId,
      pauseBuffer,
      resumeBuffer,
      pauseActiveLiveBuffer,
      resumeActiveLiveBuffer,
    } = useChatSessions({
      onLiveSpeech,
      onSpeechProgress,
      onThinking,
      onCueUser,
      onActiveBubble,
      onLiveSessionError,
      onSoftCloseSession,
      onStopSession,
      onSegmentSealed,
      shouldHoldAfterReveal,
    });

    const [activeTab, setActiveTab] = useState<'lecture' | 'chat'>('lecture');
    const [guidedMode, setGuidedMode] = useState(false);
    const guidedLearningEnabled = isGuidedLearningEnabled();
    const isDraggingRef = useRef(false);
    const [isDragging, setIsDragging] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);

    // Derive lecture notes directly from scenes — updates reactively as scenes stream in.
    const lectureNotes = useMemo(() => buildLectureNotes(scenes), [scenes]);

    // Filter out lecture sessions for the Chat tab
    const chatSessions = useMemo(() => sessions.filter((s) => s.type !== 'lecture'), [sessions]);

    // Whether there's an active discussion/QA session (for amber dot on Chat tab)
    const hasActiveChatSession = useMemo(
      () => chatSessions.some((s) => s.status === 'active'),
      [chatSessions],
    );

    const softClosingChatSession = useMemo(
      () => chatSessions.find((s) => s.status === 'soft-closing'),
      [chatSessions],
    );

    useEffect(() => {
      onSoftClosingChange?.(
        Boolean(softClosingChatSession),
        softClosingChatSession?.softCloseDeadline,
      );
    }, [softClosingChatSession, onSoftClosingChange]);

    // Wrap endSession for QA/Discussion: also notify parent for engine cleanup
    const handleEndSession = useCallback(
      async (sessionId: string) => {
        const session = chatSessions.find((candidate) => candidate.id === sessionId);
        if (session?.status === 'soft-closing') {
          const payload = await confirmSoftClosingSession(sessionId);
          if (payload) onStopSession?.(payload);
          return;
        }
        await endSession(sessionId, MANUAL_STOP_END_OPTIONS);
        onStopSession?.({ sessionId, source: 'manual_stop' });
      },
      [chatSessions, confirmSoftClosingSession, endSession, onStopSession],
    );

    const handleStopActiveSession = useCallback(async () => {
      const active = chatSessions.find(
        (session) => session.status === 'active' || session.status === 'soft-closing',
      );
      if (active) await handleEndSession(active.id);
    }, [chatSessions, handleEndSession]);

    const handleContinueActiveSoftClosingSession = useCallback((): boolean => {
      const softClosing = chatSessions.find((session) => session.status === 'soft-closing');
      return softClosing ? continueSoftClosingSession(softClosing.id) : false;
    }, [chatSessions, continueSoftClosingSession]);

    const switchToTab = useCallback((tab: 'lecture' | 'chat') => {
      setActiveTab(tab);
    }, []);

    const sendMessageWithMode = useCallback(
      async (content: string, options: ChatMessageSendOptions = {}) => {
        const interactionMode =
          options.interactionMode ?? (guidedLearningEnabled && guidedMode ? 'guided' : 'standard');
        if (interactionMode !== 'guided' || options.learningContext) {
          return sendMessage(content, { ...options, interactionMode });
        }

        const currentSession = sessions.find((session) => session.id === activeSessionId);
        if (
          currentSession?.config.interactionMode === 'guided' &&
          currentSession.status !== 'completed'
        ) {
          return sendMessage(content, { ...options, interactionMode });
        }

        const currentScene = scenes.find((scene) => scene.id === currentSceneId);
        if (!stage || !currentScene) {
          return sendMessage(content, { ...options, interactionMode });
        }
        const { createLearningContentSnapshot } = await import('@/lib/learning/content-snapshot');
        const [courseSnapshot, scopedSnapshot] = await Promise.all([
          createLearningContentSnapshot({ courseTitle: stage.name, scenes }),
          createLearningContentSnapshot({ courseTitle: stage.name, scenes: [currentScene] }),
        ]);
        const learningContext: GuidedLearningContext = {
          schemaVersion: 1,
          requestId: nanoid(),
          chatSessionId: activeSessionId ?? 'pending-session',
          stageId: stage.id,
          contentRevision: courseSnapshot.contentRevision,
          scopedRevision: scopedSnapshot.contentRevision,
          phase: 'explain',
          source: { kind: 'scene', sceneId: currentScene.id },
          evidence: scopedSnapshot.fragments.map((fragment) => ({
            ref: fragment.id,
            content: fragment.text,
          })),
        };
        return sendMessage(content, { ...options, interactionMode, learningContext });
      },
      [
        activeSessionId,
        currentSceneId,
        guidedLearningEnabled,
        guidedMode,
        scenes,
        sendMessage,
        sessions,
        stage,
      ],
    );

    useImperativeHandle(ref, () => ({
      createSession,
      endSession,
      endActiveSession,
      stopActiveSession: handleStopActiveSession,
      continueActiveSoftClosingSession: handleContinueActiveSoftClosingSession,
      softPauseActiveSession,
      resumeActiveSession,
      sendMessage: sendMessageWithMode,
      startDiscussion,
      startLecture,
      addLectureMessage,
      getIsStreaming: () => isStreaming,
      getActiveSessionType: () => activeSessionType,
      getActiveSessionId: () => activeSessionId,
      getLectureMessageId,
      pauseBuffer,
      resumeBuffer,
      pauseActiveLiveBuffer,
      resumeActiveLiveBuffer,
      switchToTab,
    }));

    // Drag-to-resize
    const handleDragStart = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        isDraggingRef.current = true;
        setIsDragging(true);
        const startX = e.clientX;
        const startWidth = width;

        const handleMouseMove = (me: MouseEvent) => {
          const delta = startX - me.clientX;
          const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
          onWidthChange?.(newWidth);
        };

        const handleMouseUp = () => {
          isDraggingRef.current = false;
          setIsDragging(false);
          document.removeEventListener('mousemove', handleMouseMove);
          document.removeEventListener('mouseup', handleMouseUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
      },
      [width, onWidthChange],
    );

    const displayWidth = embedded ? '100%' : collapsed ? 0 : width;

    return (
      <div
        data-testid="chat-area"
        style={{
          width: displayWidth,
          transition: isDragging ? 'none' : 'width 0.3s ease',
        }}
        className={cn(
          'flex flex-col shrink-0 z-20 relative overflow-visible',
          embedded
            ? 'h-full min-h-0 bg-transparent'
            : 'bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl border-l border-gray-100 dark:border-gray-800 shadow-[-2px_0_24px_rgba(0,0,0,0.02)]',
          className,
        )}
      >
        {/* Drag handle */}
        {!collapsed && !embedded && (
          <div
            onMouseDown={handleDragStart}
            className="group absolute bottom-0 left-0 top-0 z-50 w-1.5 cursor-col-resize transition-colors hover:bg-[#356B59]/20 active:bg-[#356B59]/30 dark:hover:bg-[#7FA392]/20 dark:active:bg-[#7FA392]/30"
          >
            <div className="absolute left-0.5 top-1/2 h-8 w-0.5 -translate-y-1/2 rounded-full bg-gray-300 transition-colors group-hover:bg-[#356B59] dark:bg-gray-600 dark:group-hover:bg-[#7FA392]" />
          </div>
        )}

        <div className={cn('flex flex-col w-full h-full overflow-hidden', collapsed && 'hidden')}>
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as 'lecture' | 'chat')}
            className="flex flex-col h-full gap-0"
          >
            {/* Tab header row */}
            {!embedded ? (
              <div className="h-10 flex items-center gap-1 shrink-0 mt-3 mb-1 px-3">
                <TabsList variant="line" className="h-full flex-1 w-0">
                  <TabsTrigger value="lecture" className="text-xs gap-1 flex-1">
                    <BookOpen className="w-3.5 h-3.5" />
                    {t('chat.tabs.lecture')}
                  </TabsTrigger>
                  <TabsTrigger value="chat" className="text-xs gap-1 flex-1 relative">
                    <MessageSquare className="w-3.5 h-3.5" />
                    {t('chat.tabs.chat')}
                    {/* Amber pulse dot when there's an active chat session and user is on Notes tab */}
                    {hasActiveChatSession && activeTab === 'lecture' && (
                      <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>

                {onCollapseChange && (
                  <button
                    type="button"
                    onClick={() => onCollapseChange(true)}
                    aria-label={t('common.close')}
                    className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center bg-gray-100/80 dark:bg-gray-800/80 text-gray-500 dark:text-gray-400 ring-1 ring-black/[0.04] dark:ring-white/[0.06] hover:bg-gray-200/90 dark:hover:bg-gray-700/90 hover:text-gray-700 dark:hover:text-gray-200 active:scale-90 transition-all duration-200"
                  >
                    <PanelRightClose className="w-4 h-4" />
                  </button>
                )}
              </div>
            ) : null}

            {/* Notes Tab */}
            <TabsContent value="lecture" className="flex-1 overflow-hidden flex flex-col">
              <LectureNotesView
                notes={lectureNotes}
                currentSceneId={currentSceneId}
                currentActionIndex={currentActionIndex}
                canJumpToAction={canJumpToAction}
                onJumpToAction={onJumpToAction}
              />
            </TabsContent>

            {/* Chat Tab */}
            <TabsContent value="chat" className="flex-1 overflow-hidden flex flex-col">
              <GuidedModeToggle
                enabled={guidedLearningEnabled}
                active={guidedMode}
                disabled={isStreaming}
                label={t('chat.guided.label')}
                description={t('chat.guided.description')}
                onChange={setGuidedMode}
              />
              <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-2 scrollbar-hide">
                {chatSessions.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-6 opacity-50">
                    <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#E7F1EC] text-[#356B59]/55 dark:bg-[#356B59]/20 dark:text-[#9FC0B0]">
                      <MessageSquare className="w-6 h-6" />
                    </div>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                      {t('chat.noConversations')}
                    </p>
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
                      {t('chat.startConversation')}
                    </p>
                  </div>
                ) : (
                  <>
                    <SessionList
                      sessions={chatSessions}
                      expandedSessionIds={expandedSessionIds}
                      isStreaming={isStreaming}
                      activeBubbleId={activeBubbleId}
                      onToggleExpand={toggleSessionExpand}
                      onEndSession={handleEndSession}
                      onContinueSession={continueSoftClosingSession}
                    />
                    <div ref={bottomRef} />
                  </>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    );
  },
);

ChatArea.displayName = 'ChatArea';
