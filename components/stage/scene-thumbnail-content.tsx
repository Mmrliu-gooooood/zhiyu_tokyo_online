'use client';

import { BookOpen, ClipboardCheck, MousePointerClick, PanelsTopLeft } from 'lucide-react';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { ThumbnailInteractive } from '@/components/slide-renderer/components/ThumbnailInteractive';
import type { Scene, SlideContent, InteractiveContent } from '@/lib/types/stage';
import { useI18n } from '@/lib/hooks/use-i18n';

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
  const { t } = useI18n();

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
  }

  const presentation = {
    quiz: {
      icon: ClipboardCheck,
      label: t('edit.sceneType.quiz'),
      className: 'bg-[var(--zhiyu-learning-soft)] text-[var(--zhiyu-learning)]',
    },
    interactive: {
      icon: MousePointerClick,
      label: t('edit.sceneType.interactive'),
      className: 'bg-secondary text-primary',
    },
    pbl: {
      icon: PanelsTopLeft,
      label: t('edit.sceneType.pbl'),
      className: 'bg-[var(--zhiyu-ai-soft)] text-[var(--zhiyu-ai)]',
    },
  }[scene.type];

  if (!presentation) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-muted text-muted-foreground">
        <BookOpen className="size-4" />
      </div>
    );
  }

  const Icon = presentation.icon;
  return (
    <div
      className={`flex h-full w-full flex-col items-center justify-center gap-1.5 ${presentation.className}`}
    >
      <Icon className="size-5" />
      <span className="max-w-full truncate px-2 text-[10px] font-semibold">
        {presentation.label}
      </span>
    </div>
  );
}
