'use client';

import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { AuthField } from '@/components/auth/AuthField';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { HOSTED_NEW_PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export default function UpdatePasswordPage() {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!canUseHostedAuthUi()) {
    return (
      <AuthShell title={t('auth.updatePasswordTitle')} description={t('auth.hostedDisabled')}>
        <Button className="w-full" asChild>
          <a href="/">{t('auth.backHome')}</a>
        </Button>
      </AuthShell>
    );
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (loading) return;
    setError('');
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
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(t('auth.updatePasswordFailed'));
        return;
      }
      setDone(true);
    } catch {
      setError(t('auth.networkError'));
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <AuthShell title={t('auth.passwordUpdatedTitle')} description={t('auth.passwordUpdatedDescription')}>
        <Button className="w-full" asChild>
          <a href="/auth/login">{t('auth.backToLogin')}</a>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t('auth.updatePasswordTitle')} description={t('auth.updatePasswordDescription')}>
      <form className="space-y-4" onSubmit={onSubmit}>
        <AuthField
          id="password"
          label={t('auth.newPassword')}
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
          disabled={loading || !password}
        >
          {loading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t('auth.updatePasswordSubmit')}
        </Button>
      </form>
    </AuthShell>
  );
}
