'use client';

import type { ReactNode } from 'react';
import { ZhiyuLockup } from '@/components/brand/ZhiyuLockup';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ZhiyuGenerationStep } from './zhiyu-generation-state';
import { ZhiyuGenerationTimeline } from './ZhiyuGenerationTimeline';

export function ZhiyuGenerationShell({
  title,
  steps,
  preview,
  illustration,
  actions,
  statusTitle,
  statusDetail,
  terminal = false,
}: {
  readonly title: string;
  readonly steps: readonly ZhiyuGenerationStep[];
  readonly preview: ReactNode;
  readonly illustration?: ReactNode;
  readonly actions?: ReactNode;
  readonly statusTitle?: string;
  readonly statusDetail?: string;
  readonly terminal?: boolean;
}) {
  const { t } = useI18n();

  return (
    <div
      data-testid="zhiyu-generation-shell"
      className="min-h-[100dvh] w-full bg-background text-left text-foreground"
    >
      <header className="border-b border-border/70 bg-background/92 px-4 backdrop-blur md:px-7">
        <div className="mx-auto flex min-h-16 w-full max-w-[1500px] items-center gap-4">
          <ZhiyuLockup size="sm" />
          <div className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
            {title}
          </p>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      </header>

      {/* On desktop the two panels keep one fixed height for the whole run, so
          changing titles, previews and status lines never resize the page;
          anything taller scrolls inside its panel. */}
      <main className="mx-auto grid w-full max-w-[1500px] gap-5 px-4 py-5 lg:h-[calc(100dvh-4rem)] lg:min-h-[640px] lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:px-7 lg:py-7">
        <section className="rounded-[22px] border border-border/70 bg-card p-5 shadow-[0_16px_44px_rgba(20,26,46,0.06)] md:p-6 lg:min-h-0 lg:overflow-y-auto">
          <div className="mb-5">
            {!terminal ? (
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-ai">
                {t('generation.aiWorking')}
              </p>
            ) : null}
            {/* Two lines are reserved for the title and the detail so a shorter
                status does not pull the progress list up. */}
            <h1 className="line-clamp-2 min-h-[2lh] font-display text-xl font-bold md:text-2xl">
              {statusTitle ?? t('generation.aiWorking')}
            </h1>
            <p className="mt-2 line-clamp-2 min-h-[2lh] text-sm leading-6 text-muted-foreground">
              {statusDetail ?? t('generation.generatingOutlinesDesc')}
            </p>
          </div>
          {illustration ?? <GenerationProgressSummary steps={steps} />}
          <ZhiyuGenerationTimeline steps={steps} />
        </section>

        <section
          data-testid="zhiyu-generation-preview"
          className="min-h-[480px] overflow-hidden rounded-[22px] border border-border/70 bg-card shadow-[0_16px_44px_rgba(20,26,46,0.06)] lg:min-h-0 lg:overflow-y-auto"
        >
          {preview}
        </section>
      </main>
    </div>
  );
}

/** Overall progress in words and a bar, above the step list. */
function GenerationProgressSummary({ steps }: { readonly steps: readonly ZhiyuGenerationStep[] }) {
  const { t } = useI18n();
  const done = steps.filter((step) => step.status === 'done').length;
  const percent = steps.length ? Math.round((done / steps.length) * 100) : 0;
  return (
    <div className="mb-5 rounded-xl bg-muted/70 px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-foreground">
          {t('generation.progressSummary', { done, total: steps.length })}
        </span>
        <span className="text-sm font-semibold tabular-nums text-primary">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={t('generation.progressSummary', { done, total: steps.length })}
        className="mt-2.5 h-2 overflow-hidden rounded-full bg-card"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
