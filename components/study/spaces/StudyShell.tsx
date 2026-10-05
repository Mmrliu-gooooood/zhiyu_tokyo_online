'use client';

/**
 * Chrome and status states shared by the study pages (learning plan B01).
 */
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { LoaderCircle } from 'lucide-react';

import { AccountMenu } from '@/components/auth/AccountMenu';
import { ZhiyuLockup } from '@/components/brand/ZhiyuLockup';
import { Button } from '@/components/ui/button';
import { peekAccountUserId } from '@/lib/auth/account-environment';
import { useI18n } from '@/lib/hooks/use-i18n';
import { flushAllStudyProgress } from '@/lib/study/progress/sync';
import { fetchStudyCapabilities, fetchStudyCapability } from '@/lib/study/spaces/client';

export function StudyShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [materialsOn, setMaterialsOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchStudyCapabilities().then(
      (capabilities) => !cancelled && setMaterialsOn(capabilities.materials),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border/80 bg-card/85 px-4 backdrop-blur-md md:px-8">
        <Link href="/" aria-label={t('study.backHome')} className="shrink-0 rounded-md">
          <ZhiyuLockup size="sm" />
        </Link>
        <nav className="flex items-center gap-1">
          <Link
            href="/study"
            className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t('study.nav')}
          </Link>
          {materialsOn ? (
            <Link
              href="/study/materials"
              data-testid="study-nav-materials"
              className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t('study.materials.nav')}
            </Link>
          ) : null}
          <Link
            href="/"
            className="hidden whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex"
          >
            {t('study.backHome')}
          </Link>
          <AccountMenu triggerClassName="rounded-md text-muted-foreground hover:bg-muted hover:text-foreground hover:shadow-none dark:hover:bg-muted" />
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6 md:px-8 md:pt-10">{children}</main>
    </div>
  );
}

export type StudyLoadState =
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'signed-out'
  | 'not-found'
  | 'error';

/** The non-ready states of a study page. */
export function StudyStatus({
  state,
  onRetry,
}: {
  state: Exclude<StudyLoadState, 'ready'>;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }
  const body = {
    unavailable: { title: t('study.state.unavailableTitle'), text: t('study.state.unavailable') },
    'signed-out': { title: t('study.state.signedOutTitle'), text: t('study.state.signedOut') },
    'not-found': { title: t('study.state.notFoundTitle'), text: t('study.state.notFound') },
    error: { title: t('study.state.errorTitle'), text: t('study.state.error') },
  }[state];
  return (
    <div
      data-testid={`study-state-${state}`}
      className="mx-auto flex max-w-md flex-col items-center gap-3 py-24 text-center"
    >
      <h1 className="text-lg font-semibold text-foreground">{body.title}</h1>
      <p className="text-sm leading-6 text-muted-foreground">{body.text}</p>
      <div className="mt-2 flex gap-2">
        {state === 'signed-out' ? (
          <Button asChild>
            <Link href={`/auth/login?next=${encodeURIComponent('/study')}`}>
              {t('study.state.signIn')}
            </Link>
          </Button>
        ) : null}
        {state === 'error' && onRetry ? (
          <Button onClick={onRetry}>{t('common.retry')}</Button>
        ) : null}
        {state === 'not-found' ? (
          <Button asChild variant="outline">
            <Link href="/study">{t('study.backToSpaces')}</Link>
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link href="/">{t('study.backHome')}</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Read a study page's data: the capability and sign-in gates first, then any
 * queued progress (so the page shows it), then `read`. Never throws.
 */
export async function loadStudyPage<T>(
  read: () => Promise<T>,
): Promise<{ state: 'ready'; data: T } | { state: Exclude<StudyLoadState, 'loading' | 'ready'> }> {
  if (!(await fetchStudyCapability())) return { state: 'unavailable' };
  if (!peekAccountUserId()) return { state: 'signed-out' };
  try {
    await flushAllStudyProgress();
    return { state: 'ready', data: await read() };
  } catch (error) {
    return { state: studyFailureState(error) };
  }
}

/** Map a failed study request to a page state. */
export function studyFailureState(error: unknown): Exclude<StudyLoadState, 'loading' | 'ready'> {
  const status = (error as { status?: number })?.status;
  const code = (error as { code?: string })?.code;
  if (code === 'STUDY_ACCOUNT_REQUIRED' || status === 401) return 'signed-out';
  if (code === 'STUDY_SPACE_NOT_FOUND' || code === 'STUDY_MATERIAL_NOT_FOUND') return 'not-found';
  if (status === 404) return 'unavailable';
  return 'error';
}
