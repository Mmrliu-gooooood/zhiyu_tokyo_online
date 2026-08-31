import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { projectZhiyuClassroomLayout } from './zhiyu-classroom-layout';

export type ZhiyuClassroomShellProps = {
  readonly header: ReactNode;
  readonly sceneRail: ReactNode;
  readonly stage: ReactNode;
  readonly interaction: ReactNode;
  readonly playbackBar: ReactNode;
  readonly interactionCollapsed: boolean;
  readonly sceneRailCollapsed: boolean;
  readonly presenting?: boolean;
  readonly className?: string;
};

/**
 * Layout-only classroom shell. Playback, chat and stage state remain owned by
 * PlaybackChromeRoot and arrive here as already-wired slots.
 */
export function ZhiyuClassroomShell({
  header,
  sceneRail,
  stage,
  interaction,
  playbackBar,
  interactionCollapsed,
  sceneRailCollapsed,
  presenting = false,
  className,
}: ZhiyuClassroomShellProps) {
  const layout = projectZhiyuClassroomLayout({
    sceneRailCollapsed,
    interactionCollapsed,
    presenting,
  });
  return (
    <div
      data-testid="zhiyu-classroom-shell"
      data-scene-rail={sceneRailCollapsed ? 'collapsed' : 'expanded'}
      data-interaction-panel={interactionCollapsed ? 'collapsed' : 'expanded'}
      style={
        {
          '--zhiyu-scene-rail-width': `${layout.sceneRailWidth}px`,
          '--zhiyu-interaction-width': `${layout.interactionPanelWidth}px`,
        } as CSSProperties
      }
      className={cn(
        'flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-[#eef1ef] text-foreground dark:bg-background',
        className,
      )}
    >
      {header ? <div className="relative z-30 shrink-0">{header}</div> : null}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <aside
          className={cn(
            'relative z-20 flex min-h-0 shrink-0 max-[899px]:absolute max-[899px]:inset-y-0 max-[899px]:left-0 max-[899px]:shadow-xl',
            presenting && 'hidden',
          )}
        >
          {sceneRail}
        </aside>

        <main
          data-testid="zhiyu-learning-stage"
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            !sceneRailCollapsed && 'max-[899px]:pl-[72px]',
          )}
        >
          {stage}
        </main>

        <aside
          className={cn(
            'relative z-20 flex min-h-0 shrink-0 max-[1279px]:absolute max-[1279px]:inset-y-0 max-[1279px]:right-0 max-[1279px]:shadow-xl',
            presenting && 'hidden',
          )}
        >
          {interaction}
        </aside>
      </div>

      {!presenting && playbackBar ? (
        <div className="relative z-30 shrink-0">{playbackBar}</div>
      ) : null}
    </div>
  );
}
