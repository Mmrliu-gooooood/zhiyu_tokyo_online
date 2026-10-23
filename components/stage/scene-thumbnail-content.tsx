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
      <div className="flex h-full w-full flex-col bg-gradient-to-br from-primary-soft to-ai-soft p-1.5">
        <div className="mb-1 flex items-center gap-1 border-b border-primary/30 pb-1">
          <div className="flex gap-0.5">
            <div className="h-1 w-1 rounded-full bg-mistake-soft" />
            <div className="h-1 w-1 rounded-full bg-review-soft" />
            <div className="h-1 w-1 rounded-full bg-correct-soft" />
          </div>
          <div className="ml-0.5 h-1.5 flex-1 rounded-full bg-primary-soft/40" />
        </div>
        <div className="flex flex-1 gap-1">
          <div className="w-1/4 space-y-1 pt-0.5">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-0.5 w-full rounded-full bg-primary-soft/60" />
            ))}
          </div>
          <div className="flex flex-1 items-center justify-center rounded border border-primary/30 bg-primary-soft/40">
            <Globe className="h-4 w-4 text-primary/80" />
          </div>
        </div>
      </div>
    );
  }

  if (scene.type === 'quiz') {
    return (
      <div className="flex h-full w-full flex-col bg-gradient-to-br from-review-soft to-review-soft p-2">
        <div className="mb-1.5 h-1.5 w-4/5 rounded-full bg-review-soft/70" />
        <div className="grid flex-1 grid-cols-2 gap-1">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={cn(
                'flex items-center gap-1 rounded px-1',
                i === 1
                  ? 'border border-review/30 bg-review/20'
                  : 'border border-review/30 bg-card/60',
              )}
            >
              <div
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  i === 1 ? 'bg-review' : 'bg-review-soft',
                )}
              />
              <div
                className={cn(
                  'h-1 flex-1 rounded-full',
                  i === 1 ? 'bg-review-soft/60' : 'bg-review-soft/80',
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
      <div className="flex h-full w-full flex-col bg-gradient-to-br from-ai-soft to-ai-soft p-1.5">
        <div className="mb-1.5 flex items-center gap-1">
          <div className="h-1.5 w-1.5 rounded bg-ai-soft" />
          <div className="h-1 w-8 rounded-full bg-ai-soft/60" />
        </div>
        <div className="flex flex-1 gap-1 overflow-hidden">
          {[0, 1, 2].map((col) => (
            <div key={col} className="flex flex-1 flex-col gap-0.5 rounded bg-card/50 p-0.5">
              <div
                className={cn(
                  'mb-0.5 h-0.5 w-3 rounded-full',
                  col === 0
                    ? 'bg-ai-soft/70'
                    : col === 1
                      ? 'bg-review-soft/70'
                      : 'bg-primary-soft/70',
                )}
              />
              {Array.from({ length: col === 0 ? 3 : col === 1 ? 2 : 1 }).map((_, i) => (
                <div key={i} className="h-2 w-full rounded border border-ai/30 bg-ai-soft/60" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-muted text-subtle-foreground">
      <BookOpen className="h-4 w-4" />
    </div>
  );
}
