'use client';

import { useEffect, useState } from 'react';

import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { useI18n } from '@/lib/hooks/use-i18n';

interface AdminStatus {
  role: string;
  readiness: {
    database: boolean;
    schema: boolean;
    worker: boolean;
    accepting: boolean;
  };
  accountCount: number | null;
}

export default function AdminPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canUseHostedAuthUi()) return;
    void fetch('/api/admin/status', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 403) throw new Error('forbidden');
        if (!response.ok) throw new Error('unauthenticated');
        return response.json() as Promise<AdminStatus>;
      })
      .then(setStatus)
      .catch((caught: Error) => {
        if (caught.message === 'forbidden') setError(t('auth.adminForbidden'));
        else window.location.assign('/auth/login?next=/admin');
      });
  }, [t]);

  if (!canUseHostedAuthUi()) {
    return (
      <AuthShell title={t('auth.adminTitle')} description={t('auth.hostedDisabled')}>
        <Button className="w-full" asChild>
          <a href="/">{t('auth.backHome')}</a>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t('auth.adminTitle')} description={t('auth.adminDescription')}>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {status ? (
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt>{t('auth.adminRole')}</dt>
            <dd>{status.role}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>{t('auth.adminAccounts')}</dt>
            <dd>{status.accountCount ?? t('auth.adminUnknown')}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>{t('auth.adminDatabase')}</dt>
            <dd>{status.readiness.database ? t('auth.ready') : t('auth.notReady')}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>{t('auth.adminSchema')}</dt>
            <dd>{status.readiness.schema ? t('auth.ready') : t('auth.notReady')}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>{t('auth.adminWorker')}</dt>
            <dd>{status.readiness.worker ? t('auth.ready') : t('auth.notReady')}</dd>
          </div>
        </dl>
      ) : null}
      <Button className="mt-6 w-full" asChild>
        <a href="/">{t('auth.backHome')}</a>
      </Button>
    </AuthShell>
  );
}
