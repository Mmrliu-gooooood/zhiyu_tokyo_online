'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  PencilLine,
  LayoutList,
  MessageSquare,
  Volume1,
  Volume2,
  VolumeX,
  Repeat,
  Maximize2,
  Minimize2,
  Quote,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useSoftCloseCountdown } from '@/components/chat/use-soft-close-countdown';

export interface CanvasToolbarProps {
  readonly currentSceneIndex: number;
  readonly scenesCount: number;
  readonly engineState: 'idle' | 'playing' | 'paused';
  readonly isLiveSession?: boolean;
  readonly isSoftClosing?: boolean;
  readonly softCloseDeadline?: number;
  readonly whiteboardOpen: boolean;
  readonly sidebarCollapsed?: boolean;
  readonly chatCollapsed?: boolean;
  readonly onToggleSidebar?: () => void;
  readonly onToggleChat?: () => void;
  readonly onPrevSlide: () => void;
  readonly onNextSlide: () => void;
  readonly onPlayPause: () => void;
  readonly onWhiteboardClose: () => void;
  readonly showStopDiscussion?: boolean;
  readonly onStopDiscussion?: () => void;
  readonly onContinueDiscussion?: () => void;
  readonly isPresenting?: boolean;
  readonly onTogglePresentation?: () => void;
  readonly className?: string;
  // Audio/playback controls
  readonly ttsEnabled?: boolean;
  readonly ttsMuted?: boolean;
  readonly ttsVolume?: number;
  readonly onToggleMute?: () => void;
  readonly onVolumeChange?: (volume: number) => void;
  readonly autoPlayLecture?: boolean;
  readonly onToggleAutoPlay?: () => void;
  readonly playbackSpeed?: number;
  readonly onCycleSpeed?: () => void;
  readonly showElementReference?: boolean;
  readonly canPickSlideElement?: boolean;
  readonly elementPickActive?: boolean;
  readonly onToggleElementPick?: () => void;
}

/* Compact control button */
const ctrlBtn = cn(
  'relative w-7 h-7 rounded-md flex items-center justify-center',
  'transition-all duration-150 outline-none cursor-pointer',
  'hover:bg-muted-foreground/[0.08] active:scale-90',
);

/* Labelled control: icon + text; the text shows once the bar itself is wide enough */
const labelBtn = cn(
  'relative h-7 rounded-md flex items-center justify-center gap-1 px-1.5 @[46rem]/bar:px-2',
  'text-[12px] font-medium whitespace-nowrap',
  'transition-all duration-150 outline-none cursor-pointer',
  'hover:bg-muted-foreground/[0.08] active:scale-95',
);

/* Subtle separator */
function CtrlDivider() {
  return <div className="w-px h-3 bg-muted/80 mx-0.5 shrink-0" />;
}

/* Volume icon based on level */
function VolumeIcon({
  muted,
  volume,
  disabled,
}: {
  muted: boolean;
  volume: number;
  disabled: boolean;
}) {
  const cls = 'w-3.5 h-3.5';
  if (disabled || muted || volume === 0) return <VolumeX className={cls} />;
  if (volume < 0.5) return <Volume1 className={cls} />;
  return <Volume2 className={cls} />;
}

export function CanvasToolbar({
  currentSceneIndex,
  scenesCount,
  engineState,
  isLiveSession,
  isSoftClosing,
  softCloseDeadline,
  whiteboardOpen,
  sidebarCollapsed,
  chatCollapsed,
  onToggleSidebar,
  onToggleChat,
  onPrevSlide,
  onNextSlide,
  onPlayPause,
  onWhiteboardClose,
  showStopDiscussion,
  onStopDiscussion,
  onContinueDiscussion,
  isPresenting,
  onTogglePresentation,
  className,
  ttsEnabled,
  ttsMuted,
  ttsVolume = 1,
  onToggleMute,
  onVolumeChange,
  autoPlayLecture,
  onToggleAutoPlay,
  playbackSpeed = 1,
  onCycleSpeed,
  showElementReference,
  canPickSlideElement,
  elementPickActive,
  onToggleElementPick,
}: CanvasToolbarProps) {
  const { t } = useI18n();
  const remainingSoftCloseSeconds = useSoftCloseCountdown(softCloseDeadline);
  const canGoPrev = currentSceneIndex > 0;
  const canGoNext = currentSceneIndex < scenesCount - 1;
  const showPlayPause = !isLiveSession;

  const whiteboardElementCount = useStageStore(
    (s) => s.stage?.whiteboard?.[0]?.elements?.length || 0,
  );

  // Volume slider hover state
  const [volumeHover, setVolumeHover] = useState(false);
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const volumeContainerRef = useRef<HTMLDivElement>(null);

  const handleVolumeEnter = useCallback(() => {
    clearTimeout(volumeTimerRef.current);
    setVolumeHover(true);
  }, []);

  const handleVolumeLeave = useCallback(() => {
    volumeTimerRef.current = setTimeout(() => setVolumeHover(false), 300);
  }, []);

  // Cleanup volume hover timer on unmount
  useEffect(() => () => clearTimeout(volumeTimerRef.current), []);

  // Effective volume for display
  const effectiveVolume = ttsMuted ? 0 : ttsVolume;
  const presentationLabel = isPresenting ? t('stage.exitFullscreen') : t('stage.fullscreen');

  return (
    <div className={cn('@container/bar flex items-center gap-2', className)}>
      {/* ── Left: sidebar toggle + page indicator ── */}
      <div className="flex items-center gap-1 shrink-0 pl-1">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className={cn(
              ctrlBtn,
              'w-6 h-6',
              sidebarCollapsed ? 'text-muted-foreground' : 'text-muted-foreground',
            )}
            aria-label={t('classroomWorkspace.toggleSceneRail')}
          >
            <LayoutList className="w-3.5 h-3.5" />
          </button>
        )}
        <span className="whitespace-nowrap text-[12px] font-medium tabular-nums text-muted-foreground select-none">
          {t('classroomWorkspace.pageOf', { current: currentSceneIndex + 1, total: scenesCount })}
        </span>
      </div>

      <CtrlDivider />

      {/* ── Center: unified playback controls ── */}
      <div className="flex-1 flex items-center justify-center min-w-0">
        <div
          className={cn(
            'inline-flex items-center gap-0.5 px-1 h-8',
            isPresenting
              ? '' /* Single visual layer in fullscreen — buttons sit inside outer pill directly */
              : 'bg-muted/60 rounded-lg',
          )}
        >
          {/* Volume with vertical popover slider */}
          {onToggleMute && (
            <div
              ref={volumeContainerRef}
              className="relative flex items-center"
              onMouseEnter={handleVolumeEnter}
              onMouseLeave={handleVolumeLeave}
            >
              <button
                onClick={onToggleMute}
                disabled={!ttsEnabled}
                className={cn(
                  ctrlBtn,
                  'w-6 h-6',
                  !ttsEnabled
                    ? 'text-subtle-foreground cursor-not-allowed'
                    : ttsMuted
                      ? 'text-mistake'
                      : 'text-muted-foreground',
                )}
                aria-label={
                  ttsMuted ? t('classroomWorkspace.unmute') : t('classroomWorkspace.mute')
                }
              >
                <VolumeIcon muted={!!ttsMuted} volume={ttsVolume} disabled={!ttsEnabled} />
              </button>

              {/* Vertical volume slider (pops up above) */}
              <div
                className={cn(
                  'absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex flex-col items-center',
                  'transition-all duration-200 ease-out pointer-events-none opacity-0',
                  volumeHover && ttsEnabled && 'pointer-events-auto opacity-100',
                )}
              >
                <div className="bg-card border border-border rounded-lg shadow-lg px-2 py-2.5 flex flex-col items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground tabular-nums font-medium select-none">
                    {Math.round(effectiveVolume * 100)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={effectiveVolume}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      onVolumeChange?.(v);
                      if (v > 0 && ttsMuted) onToggleMute?.();
                    }}
                    className={cn(
                      'appearance-none cursor-pointer',
                      'h-16 w-1 rounded-full',
                      'bg-muted',
                      '[writing-mode:vertical-lr] [direction:rtl]',
                      '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3',
                      '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary',
                      '[&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer',
                      '[&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3',
                      '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:border-0',
                    )}
                  />
                </div>
                {/* Arrow pointing down */}
                <div className="w-2 h-2 bg-card border-b border-r border-border rotate-45 -mt-[5px]" />
              </div>
            </div>
          )}

          {/* Speed */}
          {onCycleSpeed && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onCycleSpeed}
                    className={cn(
                      'w-9 h-7 rounded-md flex items-center justify-center',
                      'transition-all duration-150 outline-none cursor-pointer',
                      'text-[12px] font-semibold tabular-nums leading-none',
                      'active:scale-90',
                      playbackSpeed !== 1
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    aria-label={t('classroomWorkspace.speed')}
                  >
                    {playbackSpeed === 1.5 ? '1.5x' : `${playbackSpeed}x`}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {t('roundtable.speed')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          <CtrlDivider />

          {/* Prev scene */}
          {scenesCount > 1 && (
            <button
              onClick={onPrevSlide}
              disabled={!canGoPrev}
              className={cn(
                labelBtn,
                'text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none',
              )}
              aria-label={t('classroomWorkspace.previousScene')}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span className="hidden @[46rem]/bar:inline">{t('classroomWorkspace.prevPage')}</span>
            </button>
          )}

          {/* Play / Pause / Stop Discussion */}
          {showStopDiscussion && onStopDiscussion ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onStopDiscussion();
                }}
                className={cn(
                  'flex items-center gap-1.5 h-6 px-2.5 rounded-md',
                  'bg-mistake/10 text-mistake-ink',
                  'text-[11px] font-semibold whitespace-nowrap',
                  'hover:bg-mistake/20 active:scale-95 transition-all cursor-pointer',
                )}
                title={t('roundtable.stopDiscussion')}
              >
                <span className="inline-flex rounded-full h-1.5 w-1.5 bg-mistake" />
                {t('roundtable.stopDiscussion')}
              </button>
              {isSoftClosing && onContinueDiscussion && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onContinueDiscussion();
                  }}
                  className="flex h-6 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-primary/25 bg-card/70 px-2.5 text-[11px] font-semibold text-primary transition-all hover:bg-secondary active:scale-95"
                  title={t('roundtable.softClosing')}
                >
                  {t('roundtable.softClosing')}
                  {remainingSoftCloseSeconds !== undefined && (
                    <span className="text-[9px] font-medium tabular-nums text-muted-foreground">
                      {remainingSoftCloseSeconds}s
                    </span>
                  )}
                </button>
              )}
            </div>
          ) : showPlayPause ? (
            <button
              onClick={onPlayPause}
              className={cn(
                labelBtn,
                'bg-card text-foreground shadow-edge-outline active:shadow-edge-outline-pressed',
              )}
              aria-label={
                engineState === 'playing'
                  ? t('classroomWorkspace.pause')
                  : t('classroomWorkspace.play')
              }
            >
              {engineState === 'playing' ? (
                <Pause className="w-3.5 h-3.5 text-primary" />
              ) : (
                <Play className="w-3.5 h-3.5 ml-px text-primary" />
              )}
              <span className="hidden @[46rem]/bar:inline">
                {engineState === 'playing'
                  ? t('classroomWorkspace.pause')
                  : t('classroomWorkspace.play')}
              </span>
            </button>
          ) : null}

          {/* Next scene */}
          {scenesCount > 1 && (
            <button
              onClick={onNextSlide}
              disabled={!canGoNext}
              className={cn(
                labelBtn,
                'text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none',
              )}
              aria-label={t('classroomWorkspace.nextScene')}
            >
              <span className="hidden @[46rem]/bar:inline">{t('classroomWorkspace.nextPage')}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}

          <CtrlDivider />

          {/* Auto-play */}
          {onToggleAutoPlay && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onToggleAutoPlay}
                    className={cn(
                      ctrlBtn,
                      'w-8 h-6',
                      autoPlayLecture ? 'text-primary' : 'text-muted-foreground',
                    )}
                    aria-label={t('classroomWorkspace.autoPlay')}
                  >
                    <Repeat className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {autoPlayLecture ? t('roundtable.autoPlayOff') : t('roundtable.autoPlay')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Whiteboard */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onWhiteboardClose();
            }}
            className={cn(
              labelBtn,
              whiteboardOpen
                ? 'bg-primary-soft text-primary-ink'
                : 'text-muted-foreground hover:text-foreground',
            )}
            title={whiteboardOpen ? t('whiteboard.minimize') : t('whiteboard.open')}
            aria-label={whiteboardOpen ? t('whiteboard.minimize') : t('whiteboard.open')}
          >
            <PencilLine className="w-3.5 h-3.5" />
            <span className="hidden @[46rem]/bar:inline">{t('classroomWorkspace.whiteboard')}</span>
            {!whiteboardOpen && whiteboardElementCount > 0 && (
              <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </button>

          {showElementReference && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleElementPick?.();
              }}
              disabled={!canPickSlideElement}
              className={cn(
                'relative flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2 text-[12px] font-medium transition-all',
                elementPickActive
                  ? 'bg-primary/15 text-primary ring-1 ring-primary/35'
                  : 'text-muted-foreground hover:bg-muted-foreground/[0.08]',
                !canPickSlideElement && 'cursor-not-allowed opacity-35',
              )}
              aria-label={t('chat.elementReference.button')}
              aria-pressed={elementPickActive}
              title={
                canPickSlideElement
                  ? t('chat.elementReference.button')
                  : t('chat.elementReference.unavailable')
              }
            >
              <Quote className="h-3.5 w-3.5" />
              <span className="hidden @[36rem]/bar:inline">
                {t('chat.elementReference.button')}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* ── Right: fullscreen + chat toggle ── */}
      <div className="flex items-center justify-end gap-px shrink-0 pr-1">
        <CtrlDivider />
        {onTogglePresentation && (
          <button
            onClick={onTogglePresentation}
            className={cn(
              ctrlBtn,
              'w-6 h-6',
              isPresenting ? 'text-primary' : 'text-muted-foreground',
            )}
            aria-label={presentationLabel}
            title={presentationLabel}
          >
            {isPresenting ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        {onToggleChat && (
          <button
            onClick={onToggleChat}
            className={cn(
              ctrlBtn,
              'w-6 h-6',
              chatCollapsed ? 'text-muted-foreground' : 'text-muted-foreground',
            )}
            aria-label={t('classroomWorkspace.toggleInteraction')}
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
