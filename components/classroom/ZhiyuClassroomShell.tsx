'use client';

import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
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
  readonly onSceneRailDismiss?: () => void;
  readonly onInteractionDismiss?: () => void;
  readonly sceneRailDismissLabel?: string;
  readonly interactionDismissLabel?: string;
  readonly sceneRailLabel?: string;
  readonly interactionLabel?: string;
  readonly sceneRailDrawer?: boolean;
  readonly interactionDrawer?: boolean;
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
  onSceneRailDismiss,
  onInteractionDismiss,
  sceneRailDismissLabel,
  interactionDismissLabel,
  sceneRailLabel,
  interactionLabel,
  sceneRailDrawer = false,
  interactionDrawer = false,
}: ZhiyuClassroomShellProps) {
  const layout = projectZhiyuClassroomLayout({
    sceneRailCollapsed,
    interactionCollapsed,
    presenting,
  });
  const sceneRailRef = useRef<HTMLElement>(null);
  const interactionRef = useRef<HTMLElement>(null);
  const sceneDrawerOpen = !presenting && sceneRailDrawer && !sceneRailCollapsed;
  const interactionDrawerOpen = !presenting && interactionDrawer && !interactionCollapsed;
  const activeDrawer = interactionDrawerOpen ? 'interaction' : sceneDrawerOpen ? 'scene' : null;

  useEffect(() => {
    if (!activeDrawer) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = activeDrawer === 'interaction' ? interactionRef.current : sceneRailRef.current;
    const firstFocusable = drawer?.querySelector<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    (firstFocusable ?? drawer)?.focus();
    return () => previouslyFocused?.focus();
  }, [activeDrawer]);

  const keepFocusInDrawer = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!activeDrawer) return;
    const dismiss = activeDrawer === 'interaction' ? onInteractionDismiss : onSceneRailDismiss;
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const drawer = activeDrawer === 'interaction' ? interactionRef.current : sceneRailRef.current;
    const focusable = Array.from(
      drawer?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      drawer?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      data-testid="zhiyu-classroom-shell"
      data-scene-rail={sceneRailCollapsed ? 'collapsed' : 'expanded'}
      data-interaction-panel={interactionCollapsed ? 'collapsed' : 'expanded'}
      onKeyDown={keepFocusInDrawer}
      style={
        {
          '--zhiyu-scene-rail-width': `${layout.sceneRailWidth}px`,
          '--zhiyu-interaction-width': `${layout.interactionPanelWidth}px`,
        } as CSSProperties
      }
      className={cn(
        'flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-muted text-foreground',
        className,
      )}
    >
      {header ? (
        <div
          className="relative z-30 shrink-0"
          inert={activeDrawer ? true : undefined}
          aria-hidden={activeDrawer ? 'true' : undefined}
        >
          {header}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <aside
          ref={sceneRailRef}
          role={sceneDrawerOpen ? 'dialog' : undefined}
          aria-modal={sceneDrawerOpen ? 'true' : undefined}
          aria-label={sceneDrawerOpen ? sceneRailLabel : undefined}
          tabIndex={sceneDrawerOpen ? -1 : undefined}
          data-presentation={sceneRailDrawer ? 'drawer' : 'rail'}
          inert={activeDrawer === 'interaction' ? true : undefined}
          aria-hidden={activeDrawer === 'interaction' ? 'true' : undefined}
          className={cn(
            'relative z-20 flex min-h-0 shrink-0 max-[899px]:absolute max-[899px]:inset-y-0 max-[899px]:left-0 max-[899px]:shadow-xl',
            presenting && 'hidden',
          )}
        >
          {sceneRail}
        </aside>

        <main
          data-testid="zhiyu-learning-stage"
          inert={activeDrawer ? true : undefined}
          aria-hidden={activeDrawer ? 'true' : undefined}
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            !sceneRailCollapsed && 'max-[899px]:pl-[72px]',
          )}
        >
          {stage}
        </main>

        {!sceneRailCollapsed && onSceneRailDismiss ? (
          <button
            type="button"
            tabIndex={-1}
            data-testid="zhiyu-scene-drawer-backdrop"
            aria-label={sceneRailDismissLabel}
            onClick={onSceneRailDismiss}
            className="absolute inset-0 z-10 hidden bg-black/20 backdrop-blur-[1px] max-[899px]:block"
          />
        ) : null}

        {!interactionCollapsed && onInteractionDismiss ? (
          <button
            type="button"
            tabIndex={-1}
            data-testid="zhiyu-interaction-drawer-backdrop"
            aria-label={interactionDismissLabel}
            onClick={onInteractionDismiss}
            className="absolute inset-0 z-10 hidden bg-black/20 backdrop-blur-[1px] max-[1279px]:block"
          />
        ) : null}

        <aside
          ref={interactionRef}
          role={interactionDrawerOpen ? 'dialog' : undefined}
          aria-modal={interactionDrawerOpen ? 'true' : undefined}
          aria-label={interactionDrawerOpen ? interactionLabel : undefined}
          tabIndex={interactionDrawerOpen ? -1 : undefined}
          data-presentation={interactionDrawer ? 'drawer' : 'panel'}
          inert={activeDrawer === 'scene' ? true : undefined}
          aria-hidden={activeDrawer === 'scene' ? 'true' : undefined}
          className={cn(
            'relative z-20 flex min-h-0 shrink-0 max-[1279px]:absolute max-[1279px]:inset-y-0 max-[1279px]:right-0 max-[1279px]:shadow-xl',
            presenting && 'hidden',
          )}
        >
          {interaction}
        </aside>
      </div>

      {!presenting && playbackBar ? (
        <div
          className="relative z-30 shrink-0"
          inert={activeDrawer ? true : undefined}
          aria-hidden={activeDrawer ? 'true' : undefined}
        >
          {playbackBar}
        </div>
      ) : null}
    </div>
  );
}
