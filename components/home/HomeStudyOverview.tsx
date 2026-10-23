'use client';

/**
 * Home's learner-facing parts: the greeting, and — for a signed-in learner
 * with study spaces — where to continue and what each space suggests next.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Play } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useShellStudyNav } from '@/components/shell/AppShell';
import { useLearnerIdentity } from '@/components/shell/ShellAccount';
import { SpaceCard } from '@/components/study/spaces/StudySpacesPage';
import { RelativeTime } from '@/components/study/spaces/study-format';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  pickGlobalContinue,
  resumeHref,
  stoppedAtPage,
  viewedPercent,
} from '@/lib/study/spaces/view-model';

/** Spaces shown on Home; the rest are one click away in the sidebar. */
const HOME_SPACES = 3;

export function HomeGreeting() {
  const { t } = useI18n();
  const { name } = useLearnerIdentity();
  // The hour is read after mount so the server render and hydration agree.
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => setHour(new Date().getHours()), []); // eslint-disable-line react-hooks/set-state-in-effect -- client clock after hydration
  const key =
    hour === null
      ? 'home.greetingWithName'
      : hour < 11
        ? 'home.greetingMorning'
        : hour < 18
          ? 'home.greetingAfternoon'
          : 'home.greetingEvening';
  return (
    <header className="mb-6 md:mb-8">
      <h1 className="text-balance font-display text-[28px] font-bold leading-[1.25] text-foreground md:text-[36px]">
        {t(key, { name })}
      </h1>
      <p className="mt-2 max-w-2xl text-[15px] leading-7 text-muted-foreground">
        {t('home.subtitle')}
      </p>
    </header>
  );
}

export function HomeStudyOverview() {
  const { t } = useI18n();
  const nav = useShellStudyNav();
  if (!nav.available || nav.spaces.length === 0) return null;
  const resume = pickGlobalContinue(nav.spaces);
  const spaces = nav.spaces.slice(0, HOME_SPACES);

  return (
    <div className="mt-8 flex flex-col gap-8">
      {resume ? (
        <section
          aria-labelledby="home-continue-title"
          data-testid="home-continue"
          className="flex flex-col gap-4 rounded-xl bg-card p-5 shadow-sticker sm:flex-row sm:items-center"
        >
          <div className="min-w-0 flex-1">
            <p id="home-continue-title" className="text-xs font-semibold text-primary-ink">
              {t('study.continueLearning')}
            </p>
            <h2 className="mt-1 truncate text-lg font-semibold text-foreground">
              {resume.progress.courseName}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {resume.space.name}
              {' · '}
              {stoppedAtPage(resume.progress)
                ? t('study.progress.stoppedAt', {
                    page: stoppedAtPage(resume.progress),
                    total: resume.progress.sceneCount,
                  })
                : t('study.progress.positionGone')}
              {' · '}
              <RelativeTime iso={resume.progress.updatedAt} />
            </p>
            <Progress
              className="mt-3 max-w-md"
              value={viewedPercent(resume.progress, resume.progress.sceneCount)}
            />
          </div>
          <Button asChild className="shrink-0">
            <Link href={resumeHref(resume.progress.stageId)}>
              <Play className="size-4" />
              {t('study.next.continueAction')}
            </Link>
          </Button>
        </section>
      ) : null}

      <section aria-labelledby="home-spaces-title">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="home-spaces-title" className="text-[17px] font-semibold text-foreground">
            {t('shell.mySpaces')}
          </h2>
          <Link
            href="/study"
            className="text-sm font-semibold text-primary hover:text-primary-hover"
          >
            {t('home.allSpaces')}
          </Link>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {spaces.map((space) => (
            <li key={space.id}>
              <SpaceCard space={space} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
