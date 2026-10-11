'use client';

/**
 * /study/[spaceId] — one subject space (learning plan B01): continue learning,
 * its courses with viewing progress, goal / exam date / exam scope, adding
 * existing courses, generating a new course into the space, archive and delete.
 * With the question bank on (B07): the way to its bank and tests, and a
 * voluntary "test yourself" next to each course watched to the end.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  ChevronLeft,
  ClipboardCheck,
  MessageSquareQuote,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { AddCoursesDialog } from '@/components/study/spaces/AddCoursesDialog';
import { StudySpaceFormDialog } from '@/components/study/spaces/StudySpaceFormDialog';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { ExamCountdown, RelativeTime } from '@/components/study/spaces/study-format';
import { useI18n } from '@/lib/hooks/use-i18n';
import { StudyApiError, fetchStudyCapabilities, studyApi } from '@/lib/study/spaces/client';
import { SpaceMaterialsSection } from '@/components/study/materials/SpaceMaterialsSection';
import type { StudySpaceCourse, StudySpaceDetail } from '@/lib/study/spaces/contracts';
import {
  courseViewStatus,
  pickContinueCourse,
  resumeHref,
  stoppedAtPage,
  viewedPercent,
} from '@/lib/study/spaces/view-model';

export function StudySpaceDetailPage({ spaceId }: { spaceId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [space, setSpace] = useState<StudySpaceDetail | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<StudySpaceCourse | null>(null);

  const [loadKey, setLoadKey] = useState(0);
  const [materialsOn, setMaterialsOn] = useState(false);
  const [qaOn, setQaOn] = useState(false);
  const [examsOn, setExamsOn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchStudyCapabilities().then((capabilities) => {
      if (cancelled) return;
      setMaterialsOn(capabilities.materials);
      setQaOn(capabilities.qa);
      setExamsOn(capabilities.exams);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(() => studyApi.getSpace(spaceId)).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') setSpace(result.data);
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, loadKey]);

  /** Re-read after a change, keeping the page on screen. */
  const refresh = () => setLoadKey((key) => key + 1);

  if (state !== 'ready' || !space) {
    return (
      <StudyShell>
        <StudyStatus
          state={state === 'ready' ? 'loading' : state}
          onRetry={() => {
            setState('loading');
            refresh();
          }}
        />
      </StudyShell>
    );
  }

  const archived = space.status === 'archived';
  const next = pickContinueCourse(space.courses);
  const meta = [
    space.educationLevel ? t(`study.level.${space.educationLevel}`) : null,
    space.subject,
  ]
    .filter(Boolean)
    .join(' · ');

  /** Apply an edit; a stale revision shows the newer space instead of overwriting it. */
  async function save(patch: Parameters<typeof studyApi.updateSpace>[2]) {
    try {
      setSpace(await studyApi.updateSpace(space!.id, space!.revision, patch));
    } catch (error) {
      if (error instanceof StudyApiError && error.code === 'STUDY_REVISION_CONFLICT') {
        const current = error.body?.current as StudySpaceDetail | undefined;
        if (current) setSpace(current);
        throw new Error(t('study.errors.conflict'));
      }
      throw new Error(t('study.errors.generic'));
    }
  }

  return (
    <StudyShell>
      <Link
        href="/study"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t('study.backToSpaces')}
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1
              className="truncate text-2xl font-semibold tracking-[-0.02em] text-foreground md:text-3xl"
              data-testid="study-space-name"
            >
              {space.name}
            </h1>
            {archived ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {t('study.archived')}
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {meta ? <span>{meta}</span> : null}
            {space.examDate ? (
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="size-4" />
                {space.examDate}
                {' · '}
                <ExamCountdown examDate={space.examDate} timezone={space.timezone} />
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {examsOn ? (
            <Button asChild variant="outline" data-testid="study-open-practice">
              <Link href={`/study/${encodeURIComponent(space.id)}/practice`}>
                <ClipboardCheck className="mr-1 size-4" />
                {t('study.practice.open')}
              </Link>
            </Button>
          ) : null}
          {qaOn ? (
            <Button asChild data-testid="study-open-ask">
              <Link href={`/study/${encodeURIComponent(space.id)}/ask`}>
                <MessageSquareQuote className="mr-1 size-4" />
                {t('study.qa.open')}
              </Link>
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => setEditOpen(true)}
            data-testid="study-edit-space"
          >
            <Pencil className="mr-1 size-4" />
            {t('study.edit')}
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label={t('study.moreActions')}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() =>
                  void save({ status: archived ? 'active' : 'archived' }).catch((error: Error) =>
                    toast.error(error.message),
                  )
                }
              >
                {archived ? (
                  <ArchiveRestore className="mr-2 size-4" />
                ) : (
                  <Archive className="mr-2 size-4" />
                )}
                {archived ? t('study.restore') : t('study.archive')}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setConfirmDelete(true)}
              >
                <Trash2 className="mr-2 size-4" />
                {t('study.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {space.goal || space.examScope ? (
        <section className="mb-6 grid gap-3 sm:grid-cols-2">
          {space.goal ? (
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-xs font-medium text-muted-foreground">{t('study.form.goal')}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{space.goal}</p>
            </div>
          ) : null}
          {space.examScope ? (
            <div className="rounded-2xl border border-border bg-card p-4">
              <p className="text-xs font-medium text-muted-foreground">
                {t('study.form.examScope')}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{space.examScope}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      {next ? (
        <section
          data-testid="study-space-continue"
          className="mb-8 flex flex-col gap-4 rounded-2xl border border-primary/20 bg-primary/5 p-5 sm:flex-row sm:items-center"
        >
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-primary">
              {next.progress ? t('study.continueLearning') : t('study.startLearning')}
            </p>
            <h2 className="mt-1 truncate text-lg font-semibold text-foreground">{next.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              <CourseProgressText course={next} />
            </p>
          </div>
          <Button onClick={() => router.push(resumeHref(next.stageId))}>
            <Play className="mr-1 size-4" />
            {next.progress ? t('study.continue') : t('study.start')}
          </Button>
        </section>
      ) : null}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">
            {t('study.myCourses')}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {space.courses.length}
            </span>
          </h2>
          {!archived ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAddOpen(true)}
                data-testid="study-add-courses"
              >
                <Plus className="mr-1 size-4" />
                {t('study.addExisting')}
              </Button>
              <Button size="sm" asChild>
                <Link
                  href={`/?studySpace=${encodeURIComponent(space.id)}`}
                  data-testid="study-generate-course"
                >
                  <Sparkles className="mr-1 size-4" />
                  {t('study.generateCourse')}
                </Link>
              </Button>
            </div>
          ) : null}
        </div>

        {space.courses.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm leading-6 text-muted-foreground">
            {archived ? t('study.noCoursesArchived') : t('study.noCourses')}
          </div>
        ) : (
          <ul className="space-y-2" data-testid="study-course-list">
            {space.courses.map((course) => (
              <li
                key={course.stageId}
                data-testid="study-course-row"
                className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-medium text-foreground">{course.name}</h3>
                    <StatusChip course={course} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <CourseProgressText course={course} />
                  </p>
                  <Progress
                    className="mt-2 max-w-sm"
                    value={viewedPercent(course.progress, course.sceneCount)}
                  />
                </div>
                <div className="flex shrink-0 gap-2">
                  {examsOn && courseViewStatus(course.progress) === 'reached-end' ? (
                    <Button size="sm" variant="ghost" asChild data-testid="study-course-test">
                      <Link
                        href={`/study/${encodeURIComponent(space.id)}/practice?tab=build&course=${encodeURIComponent(course.stageId)}`}
                      >
                        <ClipboardCheck className="mr-1 size-4" />
                        {t('study.practice.testCourse')}
                      </Link>
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => router.push(resumeHref(course.stageId))}
                  >
                    {course.progress ? t('study.continue') : t('study.start')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => setRemoveTarget(course)}
                  >
                    {t('study.removeCourse')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {materialsOn ? <SpaceMaterialsSection spaceId={space.id} archived={archived} /> : null}

      {editOpen ? (
        <StudySpaceFormDialog
          open
          onOpenChange={setEditOpen}
          space={space}
          onSubmit={async (_input, changed) => {
            if (Object.keys(changed).length > 0) await save(changed);
          }}
        />
      ) : null}
      {addOpen ? (
        <AddCoursesDialog open onOpenChange={setAddOpen} spaceId={space.id} onAdded={refresh} />
      ) : null}

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('study.removeCourseTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('study.removeCourseText', { name: removeTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = removeTarget;
                setRemoveTarget(null);
                if (!target) return;
                void studyApi
                  .unlinkCourse(space.id, target.stageId)
                  .then(() => refresh())
                  .catch(() => toast.error(t('study.errors.generic')));
              }}
            >
              {t('study.removeCourse')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('study.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('study.deleteText', { name: space.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void studyApi
                  .deleteSpace(space.id)
                  .then(() => router.push('/study'))
                  .catch(() => toast.error(t('study.errors.generic')));
              }}
            >
              {t('study.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </StudyShell>
  );
}

function StatusChip({ course }: { course: StudySpaceCourse }) {
  const { t } = useI18n();
  const status = courseViewStatus(course.progress);
  return (
    <>
      {course.generation === 'incomplete' ? (
        <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-400">
          {t('study.course.generating')}
        </span>
      ) : null}
      <span
        data-testid="study-course-status"
        data-status={status}
        className={
          status === 'reached-end'
            ? 'shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary'
            : 'shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground'
        }
      >
        {t(`study.course.status.${status}`)}
      </span>
    </>
  );
}

function CourseProgressText({ course }: { course: StudySpaceCourse }) {
  const { t } = useI18n();
  const progress = course.progress;
  if (!progress) return <>{t('study.course.pages', { count: course.sceneCount })}</>;
  const page = stoppedAtPage(progress);
  return (
    <>
      {page
        ? t('study.progress.stoppedAt', { page, total: progress.sceneCount })
        : t('study.progress.positionGone')}
      {progress.sceneChanged ? ` · ${t('study.progress.pageEdited')}` : ''}
      {' · '}
      <RelativeTime iso={progress.updatedAt} />
    </>
  );
}
