'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';

/**
 * Landing page for the links in confirm / reset mails. The token is spent
 * only when the reader presses the button (a POST to `/auth/confirm`), so a
 * mail provider's link scanner opening the URL first can't use it up.
 * Never auto-submit: some scanners run JavaScript.
 */
export default function AuthVerifyPage() {
  return (
    <Suspense>
      <AuthVerifyBody />
    </Suspense>
  );
}

function AuthVerifyBody() {
  const { t } = useI18n();
  const params = useSearchParams();
  const [submitting, setSubmitting] = useState(false);
  const tokenHash = params.get('token_hash') ?? '';
  const type = params.get('type') ?? '';
  const next = params.get('next') ?? '/';
  const recovery = type === 'recovery';

  if (!tokenHash || !type) {
    return (
      <AuthShell title={t('auth.errorTitle')} description={t('auth.errors.missing_token')}>
        <Button className="w-full" asChild>
          <a href="/auth/login">{t('auth.backToLogin')}</a>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t(recovery ? 'auth.verifyRecoveryTitle' : 'auth.verifyEmailTitle')}
      description={t(recovery ? 'auth.verifyRecoveryDescription' : 'auth.verifyEmailDescription')}
    >
      <form
        method="post"
        action="/auth/confirm"
        onSubmit={(event) => {
          // A second submit would arrive after the first spent the token.
          if (submitting) event.preventDefault();
          else setSubmitting(true);
        }}
      >
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value={type} />
        <input type="hidden" name="next" value={next} />
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t(recovery ? 'auth.verifyRecoverySubmit' : 'auth.verifyEmailSubmit')}
        </Button>
      </form>
    </AuthShell>
  );
}
