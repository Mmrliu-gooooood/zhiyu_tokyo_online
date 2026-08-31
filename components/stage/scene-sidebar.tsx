'use client';

import { useState } from 'react';
import {
  AlertCircle,
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
}

export function SceneSidebar({
  collapsed,
  onCollapseChange,
  onSceneSelect,
  onRetryOutline,
  isCourseComplete,
  hidden = false,
}: SceneSidebarProps) {
  const { t } = useI18n();
  const { scenes, currentSceneId, setCurrentSceneId, generatingOutlines, generationStatus } =
    useStageStore();
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
  const pendingOutline = generatingOutlines[0];
  const pendingFailed = pendingOutline
    ? failedOutlines.some((outline) => outline.id === pendingOutline.id)
    : false;
  const pendingActive = currentSceneId === PENDING_SCENE_ID;

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
        {scenes.map((scene, index) => {
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
                    {(index + 1).toString().padStart(2, '0')}
                  </span>
                ) : null}
              </div>
              {!collapsed ? (
                <div className="mt-2 flex w-full min-w-0 items-center gap-2 px-0.5">
                  <span className="text-[10px] font-bold tabular-nums text-muted-foreground">
                    {(index + 1).toString().padStart(2, '0')}
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
        })}

        {pendingOutline ? (
          <div
            className={cn(
              'relative rounded-2xl p-2',
              pendingActive && !pendingFailed ? 'bg-secondary shadow-sm' : 'bg-muted/55',
              collapsed && 'rounded-xl p-1',
            )}
          >
            <button
              type="button"
              data-testid="scene-item"
              aria-current={pendingActive ? 'page' : undefined}
              disabled={pendingFailed}
              onClick={() => selectScene(PENDING_SCENE_ID)}
              className="flex w-full min-w-0 flex-col text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-default"
            >
              <div
                className={cn(
                  'flex w-full items-center justify-center rounded-lg border border-dashed',
                  collapsed ? 'aspect-[4/3]' : 'aspect-video',
                  pendingFailed
                    ? 'border-destructive/30 bg-destructive/5 text-destructive'
                    : 'border-primary/25 bg-secondary/65 text-primary',
                )}
              >
                {pendingFailed ? (
                  <AlertCircle className="size-5" />
                ) : (
                  <Loader2
                    className={cn('size-5', generationStatus !== 'paused' && 'animate-spin')}
                  />
                )}
              </div>
              {!collapsed ? (
                <div className="mt-2 flex min-w-0 items-center gap-2 px-0.5">
                  <span className="text-[10px] font-bold tabular-nums text-muted-foreground">
                    {(scenes.length + 1).toString().padStart(2, '0')}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                    {pendingOutline.title}
                  </span>
                </div>
              ) : null}
            </button>
            {pendingFailed && onRetryOutline && !collapsed ? (
              <button
                type="button"
                onClick={() => void retryOutline(pendingOutline.id)}
                disabled={retryingOutlineId === pendingOutline.id}
                className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-destructive/10 px-2 py-1.5 text-[11px] font-semibold text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-60"
              >
                <RefreshCw
                  className={cn(
                    'size-3.5',
                    retryingOutlineId === pendingOutline.id && 'animate-spin',
                  )}
                />
                {t('generation.retryScene')}
              </button>
            ) : null}
          </div>
        ) : isCourseComplete ? (
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
