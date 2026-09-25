'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LoaderCircle } from 'lucide-react';

import { AuthField } from '@/components/auth/AuthField';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { HOSTED_LOGIN_PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy';
import { safeNextPath } from '@/lib/auth/safe-next';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const authUi = canUseHostedAuthUi();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (loading) return;
    setError('');
    if (!authUi) {
      setError(t('auth.hostedDisabled'));
      return;
    }
    setLoading(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(t('auth.invalidCredentials'));
        return;
      }
      window.location.assign(safeNextPath(searchParams.get('next')));
    } catch {
      setError(t('auth.networkError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title={t('auth.loginTitle')}
      description={t('auth.loginDescription')}
      footer={
        <>
          <a className="text-primary underline-offset-4 hover:underline" href="/auth/forgot-password">
            {t('auth.forgotPassword')}
          </a>
          <span aria-hidden="true">·</span>
          <a className="text-primary underline-offset-4 hover:underline" href="/auth/sign-up">
            {t('auth.createAccount')}
          </a>
        </>
      }
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        {authUi ? null : (
          <p className="rounded-md bg-muted px-3 py-2 text-sm leading-6 text-muted-foreground">
            {t('auth.hostedDisabled')}
          </p>
        )}
        <AuthField
          id="email"
          label={t('auth.email')}
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
        />
        <AuthField
          id="password"
          label={t('auth.password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          minLength={HOSTED_LOGIN_PASSWORD_MIN_LENGTH}
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button
          type="submit"
          className="w-full"
          disabled={loading || !email || password.length < HOSTED_LOGIN_PASSWORD_MIN_LENGTH}
        >
          {loading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t('auth.loginSubmit')}
        </Button>
      </form>
    </AuthShell>
  );
}
