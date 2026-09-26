'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle } from 'lucide-react';

import { AuthField } from '@/components/auth/AuthField';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { HOSTED_NEW_PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export default function SignUpPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
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
    if (password !== confirm) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    if (password.length < HOSTED_NEW_PASSWORD_MIN_LENGTH) {
      setError(t('auth.passwordTooShort'));
      return;
    }
    setLoading(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
      });
      if (signUpError) {
        setError(t('auth.signUpFailed'));
        return;
      }
      router.push(`/auth/check-email?email=${encodeURIComponent(email)}`);
    } catch {
      setError(t('auth.networkError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title={t('auth.signUpTitle')}
      description={t('auth.signUpDescription')}
      footer={
        <a className="text-primary underline-offset-4 hover:underline" href="/auth/login">
          {t('auth.alreadyHaveAccount')}
        </a>
      }
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        {authUi ? null : (
          <p className="rounded-md bg-muted px-3 py-2 text-sm leading-6 text-muted-foreground">
            {t('auth.hostedDisabled')}
          </p>
        )}
        <AuthField id="email" label={t('auth.email')} type="email" autoComplete="email" value={email} onChange={setEmail} />
        <AuthField
          id="password"
          label={t('auth.password')}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          minLength={HOSTED_NEW_PASSWORD_MIN_LENGTH}
          hint={t('auth.passwordTooShort')}
        />
        <AuthField
          id="confirm"
          label={t('auth.confirmPassword')}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          minLength={HOSTED_NEW_PASSWORD_MIN_LENGTH}
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button
          type="submit"
          className="w-full"
          disabled={loading || !email || !password || !confirm}
        >
          {loading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t('auth.signUpSubmit')}
        </Button>
      </form>
    </AuthShell>
  );
}
