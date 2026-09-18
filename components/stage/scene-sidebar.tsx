'use client';

import { useState } from 'react';
import {
  AlertCircle,
  CircleSlash2,
  Clock3,
  Layers3,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Trophy,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStageStore, useCanvasStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { SceneThumbnailContent } from './scene-thumbnail-content';
import type { GenerationJobDisplayProjection } from '@/lib/generation/job-display';
import {
  ZHIYU_SCENE_RAIL_COLLAPSED_WIDTH,
  ZHIYU_SCENE_RAIL_EXPANDED_WIDTH,
} from '@/components/classroom/zhiyu-classroom-layout';

interface SceneSidebarProps {
  readonly collapsed: boolean;
  readonly onCollapseChange: (collapsed: boolean) => void;
  readonly onSceneSelect?: (sceneId: string) => void;
  readonly onRetryOutline?: (outlineId: string) => Promise<void>;
  readonly isCourseComplete?: boolean;
  readonly hidden?: boolean;
  readonly generationJobDisplay?: GenerationJobDisplayProjection | null;
}

export function SceneSidebar({
  collapsed,
  onCollapseChange,
  onSceneSelect,
  onRetryOutline,
  isCourseComplete,
  hidden = false,
  generationJobDisplay,
}: SceneSidebarProps) {
  const { t } = useI18n();
  const {
    scenes,
    outlines,
    currentSceneId,
    setCurrentSceneId,
    generatingOutlines,
    generationStatus,
  } = useStageStore();
  const failedOutlines = useStageStore.use.failedOutlines();
  const viewportSize = useCanvasStore.use.viewportSize();
  const viewportRatio = useCanvasStore.use.viewportRatio();
  const [retryingOutlineId, setRetryingOutlineId] = useState<string | null>(null);

  const selectScene = (sceneId: string) => {
    if (onSceneSelect) onSceneSelect(sceneId);
    else setCurrentSceneId(sceneId);
  };

  const retryOutline = async (outlineId: string) => {
    if (!onRetryOutline) return;
    setRetryingOutlineId(outlineId);
    try {
      await onRetryOutline(outlineId);
    } finally {
      setRetryingOutlineId(null);
    }
  };

  const width = hidden
    ? 0
    : `var(--zhiyu-scene-rail-width, ${
        collapsed ? ZHIYU_SCENE_RAIL_COLLAPSED_WIDTH : ZHIYU_SCENE_RAIL_EXPANDED_WIDTH
      }px)`;
  const sceneByOrder = new Map(scenes.map((scene) => [scene.order, scene]));
  // Completion is authoritative for finished/edited decks. Their saved planning
  // outlines can outlive deleted or reordered slides and are not pending work.
  const railOutlines = isCourseComplete ? [] : outlines.length ? outlines : generatingOutlines;
  const outlineOrders = new Set(railOutlines.map((outline) => outline.order));
  const sceneRows = [
    ...railOutlines.map((outline) => ({
      outlineId: outline.id,
      title: outline.title,
      order: outline.order,
      scene: sceneByOrder.get(outline.order) ?? null,
    })),
    ...scenes
      .filter((scene) => !outlineOrders.has(scene.order))
      .map((scene) => ({
        outlineId: scene.id,
        title: scene.title,
        order: scene.order,
        scene,
      })),
  ].sort((left, right) => left.order - right.order);
  const firstPendingRow = sceneRows.find((row) => !row.scene);
  const pendingActive = currentSceneId === PENDING_SCENE_ID;
  const pageList = (outlineIds: Array<string | undefined>) =>
    [
      ...new Set(
        outlineIds
          .map((outlineId) => outlines.findIndex((outline) => outline.id === outlineId) + 1)
          .filter((page) => page > 0),
      ),
    ].join(', ');
  const triggerPages = generationJobDisplay
    ? pageList(generationJobDisplay.triggerIssues.map((issue) => issue.outlineId))
    : '';
  const unknownPages = generationJobDisplay
    ? pageList(generationJobDisplay.unknownIssues.map((issue) => issue.outlineId))
    : '';
  const taskStatusDetail = generationJobDisplay?.stopped
    ? triggerPages && unknownPages
      ? t('generation.classroomStoppedWithTriggerAndUnknown', {
          triggerPages,
          triggerCode: generationJobDisplay.triggerIssues[0]?.code ?? 'GENERATION_FAILED',
          unknownPages,
        })
      : triggerPages
        ? t('generation.classroomStoppedWithTrigger', {
            triggerPages,
            triggerCode: generationJobDisplay.triggerIssues[0]?.code ?? 'GENERATION_FAILED',
          })
        : unknownPages
          ? t('generation.classroomStoppedWithUnknown', { unknownPages })
          : t('generation.classroomGenerationStopped')
    : generationJobDisplay?.status === 'retry_wait'
      ? generationJobDisplay.retryAt
        ? t('generation.classroomRetryScheduledAt', {
            time: new Intl.DateTimeFormat(undefined, {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            }).format(new Date(generationJobDisplay.retryAt)),
          })
        : t('generation.classroomRetryWaiting')
      : generationJobDisplay?.status === 'cancelled'
        ? t('generation.classroomGenerationCancelled')
        : null;
  const taskRecoveryOutlineId =
    firstPendingRow?.outlineId ??
    generationJobDisplay?.triggerIssues.find((issue) => issue.outlineId)?.outlineId ??
    railOutlines[0]?.id ??
    scenes[0]?.id;

  return (
    <nav
      data-testid="zhiyu-scene-rail"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label={t('classroomWorkspace.sceneRail')}
      aria-hidden={hidden || undefined}
      style={{ width }}
      className={cn(
        'flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-border/70 bg-card/95 transition-[width] duration-300 dark:bg-card/95',
        hidden && 'pointer-events-none border-r-0',
      )}
    >
      <div
        className={cn(
          'flex h-14 shrink-0 items-center border-b border-border/60',
          collapsed ? 'justify-center px-2' : 'justify-between px-4',
          hidden && 'invisible',
        )}
      >
        {!collapsed ? (
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
            <Layers3 className="size-4 text-primary" />
            <span className="truncate">{t('classroomWorkspace.sceneRail')}</span>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => onCollapseChange(!collapsed)}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          aria-label={
            collapsed
              ? t('classroomWorkspace.expandSceneRail')
              : t('classroomWorkspace.collapseSceneRail')
          }
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>

      <div
        data-testid="scene-list"
        className={cn(
          'min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-3 scrollbar-hide',
          collapsed ? 'space-y-2 px-2' : 'space-y-3 px-3',
          hidden && 'invisible',
        )}
      >
        {taskStatusDetail && generationJobDisplay && !collapsed ? (
          <div
            data-testid="generation-task-status"
            className={cn(
              'rounded-xl border px-3 py-2.5 text-[11px] leading-4',
              generationJobDisplay.stopped
                ? 'border-destructive/25 bg-destructive/5 text-destructive'
                : 'border-border/70 bg-muted/55 text-muted-foreground',
            )}
          >
            <p>{taskStatusDetail}</p>
            {generationJobDisplay.recovery !== 'none' && onRetryOutline && taskRecoveryOutlineId ? (
              <button
                type="button"
                aria-label={t('generation.retryScene')}
                onClick={() => void retryOutline(taskRecoveryOutlineId)}
                disabled={retryingOutlineId === taskRecoveryOutlineId}
                className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-destructive/10 px-2 py-1.5 text-[11px] font-semibold text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-60"
              >
                <RefreshCw
                  className={cn(
                    'size-3.5',
                    retryingOutlineId === taskRecoveryOutlineId && 'animate-spin',
                  )}
                />
                {t('generation.retryCourseGeneration')}
              </button>
            ) : null}
          </div>
        ) : null}

        {sceneRows.map((row) => {
          const displayNumber = (row.order + 1).toString().padStart(2, '0');
          if (row.scene) {
            const scene = row.scene;
            const active = currentSceneId === scene.id;
            return (
              <button
                key={scene.id}
                type="button"
                data-testid="scene-item"
                aria-current={active ? 'page' : undefined}
                onClick={() => selectScene(scene.id)}
                className={cn(
                  'group relative flex w-full min-w-0 flex-col text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                  collapsed ? 'rounded-xl p-1' : 'rounded-2xl p-2',
                  active
                    ? 'bg-secondary text-primary shadow-sm'
                    : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground',
                )}
              >
                {active ? (
                  <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" />
                ) : null}
                <div
                  className={cn(
                    'relative w-full overflow-hidden rounded-lg bg-muted ring-1 ring-border/60',
                    collapsed ? 'aspect-[4/3]' : 'aspect-video',
                  )}
                >
                  <SceneThumbnailContent
                    scene={scene}
                    size={collapsed ? 52 : 204}
                    viewportSize={viewportSize}
                    viewportRatio={viewportRatio}
                  />
                  {collapsed ? (
                    <span className="absolute bottom-1 left-1 rounded bg-card/90 px-1 py-0.5 text-[9px] font-bold tabular-nums text-foreground shadow-sm">
                      {displayNumber}
                    </span>
                  ) : null}
                </div>
                {!collapsed ? (
                  <div className="mt-2 flex w-full min-w-0 items-center gap-2 px-0.5">
                    <span className="text-[10px] font-bold tabular-nums text-muted-foreground">
                      {displayNumber}
                    </span>
                    <span
                      data-testid="scene-title"
                      className={cn(
                        'min-w-0 flex-1 truncate text-xs font-semibold',
                        active ? 'text-primary' : 'text-foreground',
                      )}
                    >
                      {scene.title}
                    </span>
                  </div>
                ) : (
                  <span className="sr-only" data-testid="scene-title">
                    {scene.title}
                  </span>
                )}
              </button>
            );
          }

          const leading = row === firstPendingRow;
          const failed =
            generationJobDisplay?.stopped === true ||
            failedOutlines.some((outline) => outline.id === row.outlineId);
          const active = leading && pendingActive;
          return (
            <div
              key={`pending:${row.outlineId}`}
              className={cn(
                'relative rounded-2xl p-2',
                active && !failed ? 'bg-secondary shadow-sm' : 'bg-muted/55',
                collapsed && 'rounded-xl p-1',
              )}
            >
              <button
                type="button"
                data-testid="scene-item"
                aria-current={active ? 'page' : undefined}
                disabled={!leading || failed}
                onClick={() => selectScene(PENDING_SCENE_ID)}
                className="flex w-full min-w-0 flex-col text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-default"
              >
                <div
                  className={cn(
                    'relative flex w-full items-center justify-center rounded-lg border border-dashed',
                    collapsed ? 'aspect-[4/3]' : 'aspect-video',
                    failed
                      ? 'border-destructive/30 bg-destructive/5 text-destructive'
                      : 'border-primary/25 bg-secondary/65 text-primary',
                  )}
                >
                  {failed ? (
                    <AlertCircle className="size-5" />
                  ) : generationJobDisplay?.status === 'retry_wait' ? (
                    <Clock3 className="size-5" />
                  ) : generationJobDisplay?.status === 'cancelled' ? (
                    <CircleSlash2 className="size-5" />
                  ) : (
                    <Loader2
                      className={cn(
                        'size-5',
                        (generationJobDisplay?.executing ?? generationStatus === 'generating') &&
                          'animate-spin motion-reduce:animate-none',
                      )}
                    />
                  )}
                  {collapsed ? (
                    <span className="absolute bottom-1 left-1 rounded bg-card/90 px-1 py-0.5 text-[9px] font-bold tabular-nums text-foreground shadow-sm">
                      {displayNumber}
                    </span>
                  ) : null}
                </div>
                {!collapsed ? (
                  <div className="mt-2 flex min-w-0 items-center gap-2 px-0.5">
                    <span className="text-[10px] font-bold tabular-nums text-muted-foreground">
                      {displayNumber}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                      {row.title}
                    </span>
                  </div>
                ) : null}
              </button>
              {leading && failed && onRetryOutline && !collapsed && !generationJobDisplay ? (
                <button
                  type="button"
                  aria-label={t('generation.retryScene')}
                  onClick={() => void retryOutline(row.outlineId)}
                  disabled={retryingOutlineId === row.outlineId}
                  className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-destructive/10 px-2 py-1.5 text-[11px] font-semibold text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-60"
                >
                  <RefreshCw
                    className={cn(
                      'size-3.5',
                      retryingOutlineId === row.outlineId && 'animate-spin',
                    )}
                  />
                  {t('generation.retryScene')}
                </button>
              ) : null}
            </div>
          );
        })}

        {!firstPendingRow && isCourseComplete ? (
          <button
            type="button"
            data-testid="scene-item"
            aria-current={pendingActive ? 'page' : undefined}
            onClick={() => selectScene(PENDING_SCENE_ID)}
            className={cn(
              'flex w-full items-center rounded-xl text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
              collapsed ? 'justify-center p-2' : 'gap-2 p-3',
              pendingActive
                ? 'bg-secondary text-primary shadow-sm'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Trophy className="size-4 shrink-0" />
            {!collapsed ? (
              <span className="truncate text-xs font-semibold">{t('stage.courseComplete')}</span>
            ) : (
              <span className="sr-only">{t('stage.courseComplete')}</span>
            )}
          </button>
        ) : null}
      </div>
    </nav>
  );
}
