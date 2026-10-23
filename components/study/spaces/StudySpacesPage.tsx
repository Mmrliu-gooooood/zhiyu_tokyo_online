'use client';

/**
 * /study — the learner's subject spaces (learning plan B01): continue the most
 * recently studied course, open a space, create one, and see archived ones.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Archive,
  ArrowRight,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Plus,
  Play,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { StudySpaceFormDialog } from '@/components/study/spaces/StudySpaceFormDialog';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { ExamCountdown, RelativeTime } from '@/components/study/spaces/study-format';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { studyApi } from '@/lib/study/spaces/client';
import type { StudySpaceSummary } from '@/lib/study/spaces/contracts';
import {
  pickGlobalContinue,
  resumeHref,
  spaceNextStep,
  stoppedAtPage,
  viewedPercent,
} from '@/lib/study/spaces/view-model';

export function StudySpacesPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [spaces, setSpaces] = useState<StudySpaceSummary[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(() => studyApi.listSpaces()).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') setSpaces(result.data);
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  if (state !== 'ready') {
    return (
      <StudyShell>
        <StudyStatus
          state={state}
          onRetry={() => {
            setState('loading');
            setLoadKey((key) => key + 1);
          }}
        />
      </StudyShell>
    );
  }

  const active = spaces.filter((space) => space.status === 'active');
  const archived = spaces.filter((space) => space.status === 'archived');
  const resume = pickGlobalContinue(spaces);

  return (
    <StudyShell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-foreground md:text-3xl">
            {t('study.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('study.subtitle')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} data-testid="study-create-space">
          <Plus className="mr-1 size-4" />
          {t('study.createSpace')}
        </Button>
      </div>

      {resume ? (
        <section
          data-testid="study-continue"
          className="mb-8 flex flex-col gap-4 rounded-xl bg-primary-soft p-5 shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_18%,transparent)] sm:flex-row sm:items-center"
        >
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-primary-ink">{t('study.continueLearning')}</p>
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
          </div>
          <Button onClick={() => router.push(resumeHref(resume.progress.stageId))}>
            <Play className="mr-1 size-4" />
            {t('study.continue')}
          </Button>
        </section>
      ) : null}

      {active.length === 0 ? (
        <div
          data-testid="study-empty"
          className="flex flex-col items-center gap-4 rounded-xl bg-card px-5 py-10 text-center shadow-flat"
        >
          <h2 className="font-display text-xl font-bold text-foreground">
            {t('study.emptyTitle')}
          </h2>
          <p className="max-w-md text-sm leading-6 text-muted-foreground">{t('study.empty')}</p>
          <ol className="grid w-full max-w-2xl gap-2.5 text-left sm:grid-cols-3">
            {([1, 2, 3] as const).map((n) => (
              <li key={n} className="flex items-start gap-2.5 rounded-xl bg-muted px-3.5 py-3">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                  {n}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-semibold text-foreground">
                    {t(`study.emptyStep${n}Title`)}
                  </span>
                  <span className="text-xs leading-5 text-muted-foreground">
                    {t(`study.emptyStep${n}Desc`)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 size-4" />
            {t('study.createSpace')}
          </Button>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="study-space-list">
          {active.map((space) => (
            <li key={space.id}>
              <SpaceCard space={space} />
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 ? (
        <section className="mt-10">
          <button
            type="button"
            onClick={() => setShowArchived((value) => !value)}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={showArchived}
          >
            {showArchived ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
            <Archive className="size-4" />
            {t('study.archivedCount', { count: archived.length })}
          </button>
          {showArchived ? (
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {archived.map((space) => (
                <li key={space.id}>
                  <SpaceCard space={space} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {createOpen ? (
        <StudySpaceFormDialog
          open
          onOpenChange={setCreateOpen}
          onSubmit={async (input) => {
            const created = await studyApi.createSpace(input).catch((error) => {
              throw new Error(
                (error as { code?: string })?.code === 'STUDY_SPACE_LIMIT'
                  ? t('study.errors.spaceLimit')
                  : t('study.errors.generic'),
              );
            });
            router.push(`/study/${encodeURIComponent(created.id)}`);
          }}
        />
      ) : null}
    </StudyShell>
  );
}

function SpaceCard({ space }: { space: StudySpaceSummary }) {
  const { t } = useI18n();
  const meta = [
    space.educationLevel ? t(`study.level.${space.educationLevel}`) : null,
    space.subject,
  ].filter(Boolean);
  const href = `/study/${encodeURIComponent(space.id)}`;
  const next = spaceNextStep(space);
  const nextText = !next
    ? null
    : next.kind === 'continue'
      ? t('study.next.continue', { name: next.courseName, page: next.page })
      : next.kind === 'revisit'
        ? t('study.next.revisit', { name: next.courseName })
        : next.kind === 'start'
          ? t('study.next.start')
          : t('study.next.addFirst');
  return (
    // The whole card opens the space (the title link is stretched over it);
    // the next-step link sits above that layer.
    <div
      data-testid="study-space-card"
      className="relative flex h-full flex-col gap-3 rounded-xl bg-card p-5 sticker"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-[10px] font-display text-lg font-bold',
            space.status === 'archived'
              ? 'bg-muted text-muted-foreground'
              : 'bg-primary-soft text-primary-ink',
          )}
        >
          {Array.from(space.name.trim())[0] ?? '·'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h2 className="min-w-0 truncate text-base font-semibold text-foreground">
              <Link
                href={href}
                className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
              >
                {space.name}
              </Link>
            </h2>
            {space.status === 'archived' ? (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {t('study.archived')}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {meta.length ? <span>{meta.join(' · ')}</span> : null}
            <span>{t('study.courseCount', { count: space.courseCount })}</span>
            {space.examDate ? (
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="size-3.5" />
                <ExamCountdown examDate={space.examDate} timezone={space.timezone} />
              </span>
            ) : null}
          </p>
        </div>
      </div>
      {space.lastStudied ? (
        <div>
          <p className="truncate text-xs text-muted-foreground">
            {t('study.lastStudied', { name: space.lastStudied.courseName })}
          </p>
          <Progress
            className="mt-2"
            value={viewedPercent(space.lastStudied, space.lastStudied.sceneCount)}
          />
        </div>
      ) : null}
      {next ? (
        <div className="mt-auto flex flex-col items-start gap-2 border-t border-border pt-3">
          <div className="w-full min-w-0">
            <p className="text-[11px] font-semibold tracking-wide text-muted-foreground">
              {t('study.next.label')}
            </p>
            <p className="truncate text-[13px] font-semibold text-foreground">{nextText}</p>
          </div>
          <Button asChild size="sm" variant="secondary" className="relative z-10 shrink-0">
            <Link href={next.kind === 'continue' ? resumeHref(next.stageId) : href}>
              {next.kind === 'continue' ? (
                <Play className="size-3.5" />
              ) : (
                <ArrowRight className="size-3.5" />
              )}
              {next.kind === 'continue'
                ? t('study.next.continueAction')
                : t('study.next.openAction')}
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
