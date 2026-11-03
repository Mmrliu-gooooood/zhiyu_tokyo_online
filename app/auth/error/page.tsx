'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';

export default function AuthErrorPage() {
  return (
    <Suspense>
      <AuthErrorBody />
    </Suspense>
  );
}

function AuthErrorBody() {
  const { t } = useI18n();
  const params = useSearchParams();
  const code = params.get('error') || 'unknown';
  const description = t(`auth.errors.${code}`, { defaultValue: t('auth.errors.unknown') });
  // A spent reset link can't be resent from check-email; ask for a new one.
  if (params.get('flow') === 'recovery') {
    return (
      <AuthShell title={t('auth.errorTitle')} description={description}>
        <div className="space-y-3">
          <Button className="w-full" asChild>
            <a href="/auth/forgot-password">{t('auth.requestNewReset')}</a>
          </Button>
          <Button className="w-full" variant="outline" asChild>
            <a href="/auth/login">{t('auth.backToLogin')}</a>
          </Button>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t('auth.errorTitle')} description={description}>
      <Button className="w-full" asChild>
        <a href="/auth/login">{t('auth.backToLogin')}</a>
      </Button>
      <Button className="w-full" variant="outline" asChild>
        <a href="/auth/check-email">{t('auth.resendSubmit')}</a>
      </Button>
    </AuthShell>
  );
}
