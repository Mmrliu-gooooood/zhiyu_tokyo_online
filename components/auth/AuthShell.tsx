'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { ZhiyuLockup } from '@/components/brand/ZhiyuLockup';
import { LANDING_PATH } from '@/lib/auth/public-paths';
import { useI18n } from '@/lib/hooks/use-i18n';

export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[100dvh] items-center justify-center overflow-x-hidden bg-background px-4 py-8">
      <div className="w-full min-w-0 max-w-md rounded-2xl border border-border/80 bg-card/90 p-6 shadow-xl backdrop-blur-xl sm:p-8">
        <div className="mb-6 flex min-w-0 flex-col items-center gap-3 text-center">
          <Link href={LANDING_PATH} aria-label={t('auth.productName')}>
            <ZhiyuLockup />
          </Link>
          <h1 className="font-display text-2xl font-bold text-foreground">{title}</h1>
          {description ? (
            <p className="max-w-full text-pretty text-sm leading-6 text-muted-foreground break-words">
              {description}
            </p>
          ) : null}
        </div>
        {children}
        {footer ? (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-sm text-muted-foreground">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
