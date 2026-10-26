'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

import { AuthHashCleanup } from '@/components/auth/AuthHashCleanup';
import { AccessCodeGuard } from '@/components/access-code-guard';
import { DocumentMetadataSync } from '@/components/document-metadata-sync';
import { ServerProvidersInit } from '@/components/server-providers-init';
import { StorageHealthNotice } from '@/components/storage-health-notice';
import { ProSwapWatcher } from '@/components/workbench/ProSwapWatcher';
import { Toaster } from '@/components/ui/sonner';
import {
  clearAccountEnvironment,
  requireAccountEnvironment,
  setAccountUserId,
} from '@/lib/auth/account-environment';
import { LANDING_PATH, isSessionFreePagePath } from '@/lib/auth/public-paths';
import { canUseHostedAuthUi, isHostedAuthEnabled } from '@/lib/auth/mode';
import { useI18n } from '@/lib/hooks/use-i18n';
import { rehydrateAccountStores } from '@/lib/store/account-stores';

export function AuthAppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const authPage = isSessionFreePagePath(pathname);
  const hosted = isHostedAuthEnabled();
  const sessionUi = canUseHostedAuthUi();
  const { t } = useI18n();
  const [ready, setReady] = useState(authPage || (!sessionUi && !hosted));
  const [signedIn, setSignedIn] = useState(false);
  // Auth pages and deployments without a session UI are ready at once; latch
  // it while rendering (it stays true after navigating on), not in an effect.
  if ((authPage || !sessionUi) && !ready) setReady(true);

  useEffect(() => {
    if (authPage || !sessionUi) return;
    let cancelled = false;
    requireAccountEnvironment()
      .then(async (account) => {
        if (cancelled) return;
        setAccountUserId(account.userId);
        // Account settings live under the account's namespace; load them
        // before account UI mounts and starts writing to them.
        await rehydrateAccountStores(account.userId);
        if (cancelled) return;
        setSignedIn(true);
        setReady(true);
        window.dispatchEvent(new Event('auth-change'));
      })
      .catch(() => {
        if (cancelled) return;
        if (hosted) {
          window.location.assign(
            pathname === '/' ? LANDING_PATH : `/auth/login?next=${encodeURIComponent(pathname)}`,
          );
          return;
        }
        clearAccountEnvironment();
        setSignedIn(false);
        setReady(true);
      });
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      void requireAccountEnvironment().catch(() => {
        if (hosted) window.location.assign('/auth/login');
      });
    };
    window.addEventListener('pageshow', onPageShow);
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel('zhiyu-auth');
      channel.onmessage = (event) => {
        if (event.data?.type === 'sign-out') {
          if (hosted) window.location.assign('/auth/login');
          else window.location.reload();
        }
      };
    } catch {
      channel = undefined;
    }
    return () => {
      cancelled = true;
      window.removeEventListener('pageshow', onPageShow);
      channel?.close();
    };
  }, [hosted, sessionUi, authPage, pathname]);

  const business = !authPage && ready;

  return (
    <>
      <AuthHashCleanup />
      {business ? <DocumentMetadataSync /> : null}
      {business ? <ServerProvidersInit /> : null}
      {business ? <ProSwapWatcher /> : null}
      {!ready && !authPage ? (
        <div className="flex min-h-[100dvh] items-center justify-center text-sm text-muted-foreground">
          {t('auth.loadingSession')}
        </div>
      ) : hosted || authPage || signedIn ? (
        children
      ) : (
        <AccessCodeGuard>{children}</AccessCodeGuard>
      )}
      <Toaster position="top-center" />
      {business ? <StorageHealthNotice /> : null}
    </>
  );
}
