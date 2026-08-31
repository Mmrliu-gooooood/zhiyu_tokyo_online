'use client';

import { BookOpen, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { ThumbnailInteractive } from '@/components/slide-renderer/components/ThumbnailInteractive';
import type { Scene, SlideContent, InteractiveContent } from '@/lib/types/stage';

interface SceneThumbnailContentProps {
  readonly scene: Scene;
  readonly size?: number;
  readonly viewportSize: number;
  readonly viewportRatio: number;
  readonly visible?: boolean;
}

const INTERACTIVE_FALLBACK_SIZE = 200;

/**
 * Uses the real generated renderer where a safe thumbnail exists. Other scene
 * types get a semantic icon from the existing icon library, not reconstructed
 * course content or CSS illustration.
 */
export function SceneThumbnailContent({
  scene,
  size,
  viewportSize,
  viewportRatio,
  visible = true,
}: SceneThumbnailContentProps) {
  if (scene.type === 'slide') {
    const slideContent = scene.content as SlideContent;
    return (
      <SlideThumbnail
        slide={slideContent.canvas}
        sceneId={scene.id}
        viewportSize={viewportSize}
        viewportRatio={viewportRatio}
        visible={visible}
      />
    );
  }

  if (scene.type === 'interactive') {
    const interactiveContent = scene.content as InteractiveContent;
    if (interactiveContent.html && visible) {
      return (
        <ThumbnailInteractive
          content={interactiveContent}
          size={size ?? INTERACTIVE_FALLBACK_SIZE}
        />
      );
    }
    return (
      <div className="flex h-full w-full flex-col bg-gradient-to-br from-emerald-50 to-teal-50 p-1.5 dark:from-emerald-950/30 dark:to-teal-950/20">
        <div className="mb-1 flex items-center gap-1 border-b border-emerald-200/40 pb-1 dark:border-emerald-700/20">
          <div className="flex gap-0.5">
            <div className="h-1 w-1 rounded-full bg-red-300 dark:bg-red-500/60" />
            <div className="h-1 w-1 rounded-full bg-amber-300 dark:bg-amber-500/60" />
            <div className="h-1 w-1 rounded-full bg-green-300 dark:bg-green-500/60" />
          </div>
          <div className="ml-0.5 h-1.5 flex-1 rounded-full bg-emerald-200/40 dark:bg-emerald-700/30" />
        </div>
        <div className="flex flex-1 gap-1">
          <div className="w-1/4 space-y-1 pt-0.5">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-0.5 w-full rounded-full bg-emerald-200/60 dark:bg-emerald-700/30"
              />
            ))}
          </div>
          <div className="flex flex-1 items-center justify-center rounded border border-emerald-200/40 bg-emerald-100/40 dark:border-emerald-700/20 dark:bg-emerald-800/20">
            <Globe className="h-4 w-4 text-emerald-300/80 dark:text-emerald-600/50" />
          </div>
        </div>
      </div>
    );
  }

  if (scene.type === 'quiz') {
    return (
      <div className="flex h-full w-full flex-col bg-gradient-to-br from-orange-50 to-amber-50 p-2 dark:from-orange-950/30 dark:to-amber-950/20">
        <div className="mb-1.5 h-1.5 w-4/5 rounded-full bg-orange-200/70 dark:bg-orange-700/30" />
        <div className="grid flex-1 grid-cols-2 gap-1">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={cn(
                'flex items-center gap-1 rounded px-1',
                i === 1
                  ? 'border border-orange-300/50 bg-orange-400/20 dark:border-orange-600/30 dark:bg-orange-500/20'
                  : 'border border-orange-100/60 bg-white/60 dark:border-orange-800/20 dark:bg-white/5',
              )}
            >
              <div
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  i === 1
                    ? 'bg-orange-400 dark:bg-orange-500'
                    : 'bg-orange-200 dark:bg-orange-700/50',
                )}
              />
              <div
                className={cn(
                  'h-1 flex-1 rounded-full',
                  i === 1
                    ? 'bg-orange-300/60 dark:bg-orange-600/40'
                    : 'bg-orange-100/80 dark:bg-orange-800/30',
                )}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (scene.type === 'pbl') {
    return (
      <div className="flex h-full w-full flex-col bg-gradient-to-br from-blue-50 to-indigo-50 p-1.5 dark:from-blue-950/30 dark:to-indigo-950/20">
        <div className="mb-1.5 flex items-center gap-1">
          <div className="h-1.5 w-1.5 rounded bg-blue-300 dark:bg-blue-600" />
          <div className="h-1 w-8 rounded-full bg-blue-200/60 dark:bg-blue-700/30" />
        </div>
        <div className="flex flex-1 gap-1 overflow-hidden">
          {[0, 1, 2].map((col) => (
            <div
              key={col}
              className="flex flex-1 flex-col gap-0.5 rounded bg-white/50 p-0.5 dark:bg-white/5"
            >
              <div
                className={cn(
                  'mb-0.5 h-0.5 w-3 rounded-full',
                  col === 0 ? 'bg-blue-300/70' : col === 1 ? 'bg-amber-300/70' : 'bg-green-300/70',
                )}
              />
              {Array.from({ length: col === 0 ? 3 : col === 1 ? 2 : 1 }).map((_, i) => (
                <div
                  key={i}
                  className="h-2 w-full rounded border border-blue-200/30 bg-blue-100/60 dark:border-blue-700/20 dark:bg-blue-800/20"
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gray-50 text-gray-300 dark:bg-gray-800 dark:text-gray-500">
      <BookOpen className="h-4 w-4" />
    </div>
  );
}
