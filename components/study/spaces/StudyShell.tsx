'use client';

/**
 * Chrome and status states shared by the study pages (learning plan B01).
 */
import { type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LoaderCircle } from 'lucide-react';

import { AppShell, useShellStudyNav } from '@/components/shell/AppShell';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { peekAccountUserId } from '@/lib/auth/account-environment';
import { useI18n } from '@/lib/hooks/use-i18n';
import { flushAllStudyProgress } from '@/lib/study/progress/sync';
import { fetchStudyCapability } from '@/lib/study/spaces/client';

/** `/study/<spaceId>[/<section>]`, excluding the study-wide sections. */
const SPACE_PATH = /^\/study\/(?!(?:materials|classmates|memory)(?:\/|$))([^/]+)(?:\/([^/]+))?/;

export function StudyShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const match = SPACE_PATH.exec(pathname);
  return (
    <AppShell>
      <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6 md:px-8 md:pt-8">
        {match ? <SpaceTabs spaceId={decodeURIComponent(match[1])} section={match[2]} /> : null}
        {children}
      </main>
    </AppShell>
  );
}

/** One space's sections as tabs, shared by the space page and its sub-pages. */
function SpaceTabs({ spaceId, section }: { spaceId: string; section?: string }) {
  const { t } = useI18n();
  const caps = useShellStudyNav().capabilities;
  const base = `/study/${encodeURIComponent(spaceId)}`;
  // Deeper pages sit under the tab they were opened from.
  const current =
    section === 'attempts'
      ? 'practice'
      : section === 'explanations'
        ? 'wrongbook'
        : !section || section === 'extractions'
          ? 'overview'
          : section;
  const tabs = [
    { key: 'overview', href: base, label: t('study.tabs.overview'), on: true },
    { key: 'ask', href: `${base}/ask`, label: t('study.qa.open'), on: caps?.qa },
    { key: 'practice', href: `${base}/practice`, label: t('study.practice.open'), on: caps?.exams },
    { key: 'review', href: `${base}/review`, label: t('study.review.open'), on: caps?.review },
    {
      key: 'wrongbook',
      href: `${base}/wrongbook`,
      label: t('study.wrongbook.open'),
      on: caps?.wrongbook,
    },
  ].filter((tab) => tab.on);
  if (tabs.length < 2) return null;
  return (
    <nav
      aria-label={t('study.tabs.label')}
      className="scrollbar-hide -mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-border px-4 md:mx-0 md:px-0"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === current ? 'page' : undefined}
          className={cn(
            'shrink-0 whitespace-nowrap px-3 py-2.5 text-sm transition-colors',
            tab.key === current
              ? 'font-semibold text-primary-ink shadow-[inset_0_-2px_0_var(--primary)]'
              : 'font-medium text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
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
      <h1 className="font-display text-xl font-bold text-foreground">{body.title}</h1>
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
  if (
    code === 'STUDY_SPACE_NOT_FOUND' ||
    code === 'STUDY_MATERIAL_NOT_FOUND' ||
    code === 'STUDY_PAPER_NOT_FOUND' ||
    code === 'STUDY_ATTEMPT_NOT_FOUND' ||
    code === 'STUDY_EXTRACTION_NOT_FOUND'
  ) {
    return 'not-found';
  }
  if (status === 404) return 'unavailable';
  return 'error';
}
