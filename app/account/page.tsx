'use client';

import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { AuthShell } from '@/components/auth/AuthShell';
import { AuthField } from '@/components/auth/AuthField';
import { Button } from '@/components/ui/button';
import { signOutAndReload } from '@/lib/auth/client-barrier';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { AccountSnapshot } from '@/lib/auth/account-environment';

export default function AccountPage() {
  const { t } = useI18n();
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!canUseHostedAuthUi()) return;
    void fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('unauthenticated');
        return response.json() as Promise<AccountSnapshot>;
      })
      .then((body) => {
        setAccount(body);
        setDisplayName(body.displayName ?? '');
      })
      .catch(() => {
        window.location.assign('/auth/login?next=/account');
      });
  }, []);

  if (!canUseHostedAuthUi()) {
    return (
      <AuthShell title={t('auth.accountTitle')} description={t('auth.hostedDisabled')}>
        <Button className="w-full" asChild>
          <a href="/">{t('auth.backHome')}</a>
        </Button>
      </AuthShell>
    );
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const response = await fetch('/api/auth/profile', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      if (!response.ok) {
        setError(t('auth.profileSaveFailed'));
      }
    } catch {
      setError(t('auth.networkError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AuthShell title={t('auth.accountTitle')} description={t('auth.accountDescription')}>
      <form className="space-y-4" onSubmit={saveProfile}>
        <AuthField
          id="email"
          label={t('auth.email')}
          type="email"
          autoComplete="email"
          value={account?.email ?? ''}
          onChange={() => undefined}
          readOnly
        />
        <AuthField
          id="displayName"
          label={t('auth.displayName')}
          type="text"
          autoComplete="nickname"
          value={displayName}
          onChange={setDisplayName}
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={saving || !account}>
          {saving ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t('auth.saveProfile')}
        </Button>
        <Button type="button" variant="outline" className="w-full" onClick={() => void signOutAndReload()}>
          {t('auth.signOut')}
        </Button>
      </form>
    </AuthShell>
  );
}
