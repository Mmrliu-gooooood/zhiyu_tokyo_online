'use client';

import { AlertCircle, Check, Circle, LoaderCircle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { ZhiyuGenerationStatus, ZhiyuGenerationStep } from './zhiyu-generation-state';

const STATUS_STYLES: Record<ZhiyuGenerationStatus, string> = {
  done: 'border-primary/15 bg-primary/8 text-primary dark:bg-primary/12',
  active: 'border-ai/20 bg-ai-soft text-ai',
  pending: 'border-border/70 bg-muted/35 text-muted-foreground',
  error: 'border-mistake/20 bg-mistake-soft text-mistake',
};

const STATUS_LABEL_KEYS: Record<ZhiyuGenerationStatus, string> = {
  done: 'actions.status.result',
  active: 'actions.status.running',
  pending: 'actions.status.inputStreaming',
  error: 'actions.status.error',
};

function StatusIcon({ status }: { readonly status: ZhiyuGenerationStatus }) {
  if (status === 'done') return <Check className="size-4" strokeWidth={2.5} />;
  if (status === 'active') {
    return <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />;
  }
  if (status === 'error') return <AlertCircle className="size-4" />;
  return <Circle className="size-3" />;
}

export function ZhiyuGenerationTimeline({
  steps,
}: {
  readonly steps: readonly ZhiyuGenerationStep[];
}) {
  const { t } = useI18n();

  return (
    <ol
      data-testid="zhiyu-generation-timeline"
      className="space-y-2"
      aria-label={t('generation.aiWorking')}
      aria-live="polite"
    >
      {steps.map((step) => {
        const statusLabel = t(STATUS_LABEL_KEYS[step.status]);
        return (
          <li
            key={step.id}
            data-status={step.status}
            aria-label={`${t(step.labelKey)}: ${statusLabel}`}
            aria-current={step.status === 'active' ? 'step' : undefined}
            className={cn(
              'flex min-h-12 items-center gap-3 rounded-xl border px-3.5 py-2.5 transition-colors',
              STATUS_STYLES[step.status],
            )}
          >
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-background/70"
              aria-hidden="true"
            >
              <StatusIcon status={step.status} />
            </span>
            <span className="min-w-0 flex-1 text-left text-sm font-medium text-foreground">
              {t(step.labelKey)}
            </span>
            <span className="sr-only">{statusLabel}</span>
            {step.detail ? (
              <span className="shrink-0 text-xs font-semibold tabular-nums text-current">
                {step.detail}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
