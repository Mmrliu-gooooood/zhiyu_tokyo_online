'use client';

import type { ReactNode } from 'react';
import { ZhiyuLockup } from '@/components/brand/ZhiyuLockup';
import { ZhiyuLearningVisual } from '@/components/home/ZhiyuLearningVisual';
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

      <main className="mx-auto grid w-full max-w-[1500px] gap-5 px-4 py-5 lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)] lg:px-7 lg:py-7">
        <section className="rounded-[22px] border border-border/70 bg-card p-5 shadow-[0_16px_44px_rgba(20,26,46,0.06)] md:p-6">
          <div className="mb-5">
            {!terminal ? (
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-ai">
                {t('generation.aiWorking')}
              </p>
            ) : null}
            <h1 className="font-display text-xl font-bold md:text-2xl">
              {statusTitle ?? t('generation.aiWorking')}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {statusDetail ?? t('generation.generatingOutlinesDesc')}
            </p>
          </div>
          <div className="mb-5">
            {illustration ?? <ZhiyuLearningVisual className="mx-auto max-w-[270px]" />}
          </div>
          <ZhiyuGenerationTimeline steps={steps} />
        </section>

        <section
          data-testid="zhiyu-generation-preview"
          className="min-h-[480px] overflow-hidden rounded-[22px] border border-border/70 bg-card shadow-[0_16px_44px_rgba(20,26,46,0.06)]"
        >
          {preview}
        </section>
      </main>
    </div>
  );
}
