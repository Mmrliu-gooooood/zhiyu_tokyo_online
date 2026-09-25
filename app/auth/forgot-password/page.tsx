'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle } from 'lucide-react';

import { AuthField } from '@/components/auth/AuthField';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { canUseHostedAuthUi } from '@/lib/auth/mode';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState('');
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
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/confirm?next=/auth/update-password`,
      });
      router.push('/auth/check-email');
    } catch {
      setError(t('auth.networkError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title={t('auth.forgotTitle')}
      description={t('auth.forgotDescription')}
      footer={
        <a className="text-primary underline-offset-4 hover:underline" href="/auth/login">
          {t('auth.backToLogin')}
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
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={loading || !email}>
          {loading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t('auth.sendReset')}
        </Button>
      </form>
    </AuthShell>
  );
}
