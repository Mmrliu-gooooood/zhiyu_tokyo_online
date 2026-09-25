'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LoaderCircle } from 'lucide-react';

import { AuthField } from '@/components/auth/AuthField';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { canUseHostedAuthUi } from '@/lib/auth/mode';

export default function CheckEmailPage() {
  return (
    <Suspense>
      <CheckEmailBody />
    </Suspense>
  );
}

function CheckEmailBody() {
  const { t } = useI18n();
  const params = useSearchParams();
  const authUi = canUseHostedAuthUi();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onResend(event: React.FormEvent) {
    event.preventDefault();
    if (loading) return;
    setError('');
    setMessage('');
    if (!authUi) {
      setError(t('auth.hostedDisabled'));
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/auth/resend', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (response.status === 429) {
        setError(t('auth.errors.rate_limited'));
        return;
      }
      if (!response.ok) {
        setError(t('auth.resendFailed'));
        return;
      }
      setMessage(t('auth.resendSent'));
    } catch {
      setError(t('auth.networkError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title={t('auth.checkEmailTitle')} description={t('auth.checkEmailDescription')}>
      <form className="space-y-4" onSubmit={onResend}>
        <p className="text-sm leading-6 text-muted-foreground">{t('auth.resendHint')}</p>
        <AuthField
          id="email"
          label={t('auth.email')}
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
        />
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={loading || !email}>
          {loading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t('auth.resendSubmit')}
        </Button>
      </form>
      <Button className="mt-3 w-full" variant="outline" asChild>
        <a href="/auth/login">{t('auth.backToLogin')}</a>
      </Button>
    </AuthShell>
  );
}
