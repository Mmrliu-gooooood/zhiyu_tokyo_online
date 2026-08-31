'use client';

import { Loader2 } from 'lucide-react';
import { ZhiyuLockup } from '@/components/brand/ZhiyuLockup';
import { useI18n } from '@/lib/hooks/use-i18n';

export function ZhiyuRouteLoading({
  labelKey = 'common.loading',
  testId = 'zhiyu-route-loading',
}: {
  readonly labelKey?: string;
  readonly testId?: string;
}) {
  const { t } = useI18n();

  return (
    <main
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid={testId}
      className="flex min-h-screen w-full items-center justify-center bg-background px-6 text-center"
    >
      <div className="flex flex-col items-center gap-5 rounded-[22px] border border-border bg-card px-10 py-9 shadow-[0_16px_48px_rgba(20,32,25,0.08)] dark:shadow-black/25">
        <ZhiyuLockup size="sm" />
        <Loader2 className="size-5 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{t(labelKey)}</p>
      </div>
    </main>
  );
}
