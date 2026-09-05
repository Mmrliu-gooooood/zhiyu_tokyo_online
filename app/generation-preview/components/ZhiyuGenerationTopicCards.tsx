'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { SceneOutline } from '@/lib/types/generation';

export function ZhiyuGenerationTopicCards({
  outlines,
  rotating,
  onExpand,
}: {
  readonly outlines: readonly Pick<SceneOutline, 'id' | 'title'>[];
  readonly rotating: boolean;
  readonly onExpand?: () => void;
}) {
  const { t } = useI18n();
  const reducedMotion = useReducedMotion();
  const [page, setPage] = useState(0);
  const [pausedOverride, setPausedOverride] = useState<boolean | null>(null);
  const paused = pausedOverride ?? reducedMotion === true;
  const pageCount = Math.max(1, Math.ceil(outlines.length / 4));
  const visiblePage = rotating ? Math.min(page, pageCount - 1) : 0;

  useEffect(() => {
    if (!rotating || paused || pageCount <= 1) return;
    const timer = window.setInterval(
      () => setPage((current) => (Math.min(current, pageCount - 1) + 1) % pageCount),
      5_000,
    );
    return () => window.clearInterval(timer);
  }, [rotating, paused, pageCount]);

  return (
    <div className="w-full max-w-2xl">
      <motion.div
        key={visiblePage}
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.22 }}
        className="grid w-full max-w-2xl gap-3 sm:grid-cols-2"
      >
        {outlines.slice(visiblePage * 4, visiblePage * 4 + 4).map((outline) => (
          <button
            key={outline.id}
            type="button"
            disabled={!onExpand}
            onClick={onExpand}
            className="rounded-xl border border-border/70 bg-card p-4 text-left disabled:cursor-default"
          >
            <span className="block line-clamp-2 text-sm font-semibold">{outline.title}</span>
          </button>
        ))}
      </motion.div>
      {rotating && pageCount > 1 ? (
        <div className="mt-4 flex items-center justify-center gap-3">
          <div
            role="group"
            aria-label={t('generation.outlineEditorTitle')}
            className="flex items-center gap-1"
          >
            {Array.from({ length: pageCount }, (_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`${index + 1} / ${pageCount}`}
                aria-current={visiblePage === index ? 'page' : undefined}
                onClick={() => setPage(index)}
                className="flex size-8 items-center justify-center rounded-full text-xs text-muted-foreground aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {index + 1}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label={t(paused ? 'proactiveCard.resume' : 'proactiveCard.pause')}
            onClick={() => setPausedOverride(!paused)}
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </button>
        </div>
      ) : null}
    </div>
  );
}
