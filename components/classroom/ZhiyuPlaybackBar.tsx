'use client';

import { CanvasToolbar, type CanvasToolbarProps } from '@/components/canvas/canvas-toolbar';
import { cn } from '@/lib/utils';

export type ZhiyuPlaybackBarProps = CanvasToolbarProps & {
  readonly visible?: boolean;
};

/** Presentation-only home for the existing playback callbacks and state. */
export function ZhiyuPlaybackBar({
  visible = true,
  className,
  ...toolbarProps
}: ZhiyuPlaybackBarProps) {
  return (
    <div
      data-testid="zhiyu-playback-bar"
      className={cn(
        'flex h-12 items-center border-t border-border/70 bg-card/95 px-3 shadow-[0_-8px_24px_rgba(30,55,45,0.04)] backdrop-blur-xl transition-opacity dark:bg-card/95',
        !visible && 'pointer-events-none opacity-0',
      )}
    >
      <CanvasToolbar
        {...toolbarProps}
        className={cn('h-full w-full px-1', className)}
      />
    </div>
  );
}
