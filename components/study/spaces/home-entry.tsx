'use client';

/**
 * Home affordances for study spaces (learning plan B01): the header entry, and
 * the "this course will join <space>" banner when Home was opened from a
 * space's "generate a course" action (`/?studySpace=<id>`).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BookOpenCheck, X } from 'lucide-react';

import { peekAccountUserId } from '@/lib/auth/account-environment';
import { useI18n } from '@/lib/hooks/use-i18n';
import { fetchStudyCapability, studyApi } from '@/lib/study/spaces/client';
import { isStudyId } from '@/lib/study/spaces/contracts';
import { cn } from '@/lib/utils';

/** True when this deployment serves study spaces and an account is signed in. */
export function useStudySpacesAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (!peekAccountUserId()) {
        setAvailable(false);
        return;
      }
      void fetchStudyCapability().then((enabled) => {
        if (!cancelled) setAvailable(enabled && Boolean(peekAccountUserId()));
      });
    };
    refresh();
    window.addEventListener('auth-change', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('auth-change', refresh);
    };
  }, []);
  return available;
}

export function StudySpacesNavButton({ className }: { className?: string }) {
  const { t } = useI18n();
  if (!useStudySpacesAvailable()) return null;
  return (
    <Link
      href="/study"
      data-testid="study-spaces-entry"
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      <BookOpenCheck className="size-4" />
      <span className="hidden sm:inline">{t('study.nav')}</span>
    </Link>
  );
}

export interface StudyGenerationTarget {
  id: string;
  name: string;
}

/**
 * The space named by `?studySpace=` on Home, once it is confirmed to be the
 * signed-in learner's active space. Cleared by the banner's close button.
 */
export function useStudyGenerationTarget(): {
  target: StudyGenerationTarget | null;
  clear: () => void;
} {
  const [target, setTarget] = useState<StudyGenerationTarget | null>(null);
  useEffect(() => {
    const spaceId = new URLSearchParams(window.location.search).get('studySpace');
    if (!isStudyId(spaceId)) return;
    let cancelled = false;
    void (async () => {
      if (!(await fetchStudyCapability()) || !peekAccountUserId()) return;
      try {
        const space = await studyApi.getSpace(spaceId);
        if (!cancelled && space.status === 'active') setTarget({ id: space.id, name: space.name });
      } catch {
        // Not the learner's space (or not reachable): generate without a link.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const clear = () => {
    setTarget(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('studySpace');
    window.history.replaceState(window.history.state, '', url.toString());
  };
  return { target, clear };
}

export function StudyGenerationTargetBanner({
  target,
  onClear,
}: {
  target: StudyGenerationTarget;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      data-testid="study-generation-target"
      className="mx-5 mt-3 flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 text-xs text-foreground"
    >
      <BookOpenCheck className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        {t('study.generateInto', { name: target.name })}
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label={t('study.generateIntoCancel')}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
