'use client';

/**
 * /study/[spaceId]/review — the space's review list (learning plan B12).
 *
 * - Today's tasks, within the minutes the student set, each with the reasons
 *   it is there (overdue, exam scope, recent mistakes, their own date or
 *   flag) — no hidden score. Later tasks, stable items and skipped ones
 *   follow; the evidence per knowledge point closes the page.
 * - A task can be redone as it was (a practice paper: practice, not proof),
 *   opened in place (answers, look back, classmate, variants), marked as
 *   reviewed, postponed or skipped. Dates the student sets win.
 * - With Memory off for the subject nothing is scheduled by the rules; the
 *   student's own dates and flags still are.
 * - The subject's Memory summary (what classmates see) is brought up to date
 *   in the background; the student can delete it.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CalendarClock,
  CalendarX,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Eye,
  LoaderCircle,
  RotateCcw,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';

import { MathText, TypeChip, newRequestKey } from '@/components/study/exams/exam-format';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { RelativeTime } from '@/components/study/spaces/study-format';
import { WrongItemBody } from '@/components/study/wrongbook/WrongbookPage';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/hooks/use-i18n';
import { examsApi } from '@/lib/study/assessments/client';
import type { SummaryView } from '@/lib/study/memory/summary';
import { reviewApi } from '@/lib/study/review/client';
import {
  EVIDENCE_STATES,
  type EvidenceState,
  type ReviewActionKind,
  type ReviewOverview,
  type ReviewReason,
  type ReviewTaskView,
} from '@/lib/study/review/contracts';
import { addDays } from '@/lib/study/review/plan';
import { StudyApiError, fetchStudyCapabilities, studyApi } from '@/lib/study/spaces/client';
import { cn } from '@/lib/utils';

const CHIP = 'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px]';
const SELECT = 'h-8 rounded-md border border-border bg-background px-2 text-sm';
const MINUTE_CHOICES = [5, 10, 15, 20, 30, 45, 60, 90, 120];

const STATE_STYLE: Record<EvidenceState, string> = {
  pending: 'bg-red-500/10 text-red-600 dark:text-red-400',
  practiced: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  helped: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  independent: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  stable: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
};

interface Flags {
  chatOn: boolean;
  practiceOn: boolean;
  memoryOn: boolean;
}

export function ReviewPage({ spaceId }: { spaceId: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [spaceName, setSpaceName] = useState('');
  const [overview, setOverview] = useState<ReviewOverview | null>(null);
  const [flags, setFlags] = useState<Flags>({ chatOn: false, practiceOn: false, memoryOn: false });
  const [summary, setSummary] = useState<SummaryView | null>(null);
  const [summaryState, setSummaryState] = useState<'idle' | 'working' | 'off'>('idle');
  const [loadKey, setLoadKey] = useState(0);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      const capabilities = await fetchStudyCapabilities();
      if (!capabilities.review) throw new StudyApiError(404, 'STUDY_NOT_AVAILABLE', null);
      const space = await studyApi.getSpace(spaceId);
      const data = await reviewApi.overview(spaceId);
      return { capabilities, space, data };
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') {
        const { capabilities, space, data } = result.data;
        setSpaceName(space.name);
        setOverview(data);
        setFlags({
          chatOn: capabilities.companionChat,
          practiceOn: capabilities.practice,
          memoryOn: capabilities.memory,
        });
      }
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, loadKey]);

  // The summary classmates see: refreshed in the background once the page is ready.
  useEffect(() => {
    if (state !== 'ready' || !flags.memoryOn) return;
    let cancelled = false;
    setSummaryState('working');
    reviewApi
      .refreshSummary(spaceId)
      .then((result) => {
        if (cancelled) return;
        setSummary(result.summary);
        setSummaryState(result.state === 'off' ? 'off' : 'idle');
      })
      .catch(() => {
        if (!cancelled) setSummaryState('idle');
      });
    return () => {
      cancelled = true;
    };
  }, [state, flags.memoryOn, spaceId]);

  const reload = useCallback(async () => {
    setReloading(true);
    try {
      setOverview(await reviewApi.overview(spaceId));
    } catch {
      toast.error(t('study.errors.generic'));
    } finally {
      setReloading(false);
    }
  }, [spaceId, t]);

  if (state !== 'ready' || !overview) {
    return (
      <StudyShell>
        <StudyStatus
          state={state === 'ready' ? 'loading' : state}
          onRetry={() => {
            setState('loading');
            setLoadKey((key) => key + 1);
          }}
        />
      </StudyShell>
    );
  }

  const minutes = overview.todayTasks.reduce((sum, task) => sum + task.minutes, 0);
  const empty =
    overview.todayTasks.length +
      overview.overflow.length +
      overview.upcoming.length +
      overview.unscheduled.length +
      overview.stable.length +
      overview.skipped.length ===
    0;

  return (
    <StudyShell>
      <Link
        href={`/study/${encodeURIComponent(spaceId)}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {spaceName || t('study.backToSpaces')}
      </Link>

      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground md:text-3xl">
            {t('study.review.title')}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            {t('study.review.subtitle')}
          </p>
        </div>
        {reloading ? <LoaderCircle className="size-5 animate-spin text-muted-foreground" /> : null}
      </header>

      {overview.mode === 'manual' ? (
        <p
          className="mb-4 rounded-xl bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground"
          data-testid="review-manual"
        >
          {t('study.review.manualMode')}{' '}
          <Link href="/study/memory" className="underline underline-offset-2">
            {t('study.review.openMemory')}
          </Link>
        </p>
      ) : null}

      <PlanBar spaceId={spaceId} overview={overview} onChanged={reload} />

      {flags.memoryOn && overview.mode === 'auto' ? (
        <SummaryCard
          spaceId={spaceId}
          summary={summary}
          working={summaryState === 'working'}
          off={summaryState === 'off'}
          onDeleted={() => setSummary(null)}
        />
      ) : null}

      {empty ? (
        <p
          className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground"
          data-testid="review-empty"
        >
          {t('study.review.empty')}{' '}
          <Link
            href={`/study/${encodeURIComponent(spaceId)}/wrongbook`}
            className="underline underline-offset-2"
          >
            {t('study.wrongbook.open')}
          </Link>
        </p>
      ) : (
        <>
          <TaskSection
            title={
              overview.mode === 'manual'
                ? t('study.review.section.todayManual')
                : t('study.review.section.today', {
                    count: overview.todayTasks.length,
                    minutes,
                  })
            }
            empty={t('study.review.section.todayEmpty')}
            tasks={overview.todayTasks}
            testId="review-today"
            spaceId={spaceId}
            overview={overview}
            flags={flags}
            onChanged={reload}
          />
          {overview.overflow.length ? (
            <TaskSection
              title={t('study.review.section.overflow', { count: overview.overflow.length })}
              hint={t('study.review.section.overflowHint')}
              tasks={overview.overflow}
              testId="review-overflow"
              spaceId={spaceId}
              overview={overview}
              flags={flags}
              onChanged={reload}
              collapsed
            />
          ) : null}
          {overview.unscheduled.length ? (
            <TaskSection
              title={t('study.review.section.unscheduled', { count: overview.unscheduled.length })}
              hint={t('study.review.section.unscheduledHint')}
              tasks={overview.unscheduled}
              testId="review-unscheduled"
              spaceId={spaceId}
              overview={overview}
              flags={flags}
              onChanged={reload}
            />
          ) : null}
          {overview.upcoming.length ? (
            <TaskSection
              title={t('study.review.section.upcoming', { count: overview.upcoming.length })}
              tasks={overview.upcoming}
              testId="review-upcoming"
              spaceId={spaceId}
              overview={overview}
              flags={flags}
              onChanged={reload}
              compact
            />
          ) : null}
          {overview.stable.length ? (
            <TaskSection
              title={t('study.review.section.stable', { count: overview.stable.length })}
              hint={t('study.review.section.stableHint')}
              tasks={overview.stable}
              testId="review-stable"
              spaceId={spaceId}
              overview={overview}
              flags={flags}
              onChanged={reload}
              compact
              collapsed
            />
          ) : null}
          {overview.skipped.length ? (
            <TaskSection
              title={t('study.review.section.skipped', { count: overview.skipped.length })}
              tasks={overview.skipped}
              testId="review-skipped"
              spaceId={spaceId}
              overview={overview}
              flags={flags}
              onChanged={reload}
              compact
              collapsed
            />
          ) : null}
          <ConceptEvidence overview={overview} />
        </>
      )}

      <p className="mt-6 text-[11px] leading-5 text-muted-foreground" data-testid="review-rules">
        {t('study.review.rules')}
        <span className="ml-1 opacity-70">({overview.ruleVersion})</span>
      </p>
    </StudyShell>
  );
}

// ── plan bar: today, minutes, exam ──────────────────────────────────────────

function PlanBar({
  spaceId,
  overview,
  onChanged,
}: {
  spaceId: string;
  overview: ReviewOverview;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const choices = MINUTE_CHOICES.includes(overview.settings.dailyMinutes)
    ? MINUTE_CHOICES
    : [...MINUTE_CHOICES, overview.settings.dailyMinutes].sort((a, b) => a - b);

  async function setMinutes(value: number) {
    setBusy(true);
    try {
      await reviewApi.settings(spaceId, value, overview.settings.revision);
      await onChanged();
    } catch (error) {
      toast.error(
        error instanceof StudyApiError && error.code === 'STUDY_REVISION_CONFLICT'
          ? t('study.errors.conflict')
          : t('study.errors.generic'),
      );
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm"
      data-testid="review-plan"
    >
      <span className="text-muted-foreground">
        {t('study.review.today', { date: overview.today })}
      </span>
      <label className="flex items-center gap-1.5 text-muted-foreground">
        {t('study.review.dailyMinutes')}
        <select
          value={overview.settings.dailyMinutes}
          disabled={busy}
          onChange={(event) => void setMinutes(Number(event.target.value))}
          className={SELECT}
          data-testid="review-minutes"
        >
          {choices.map((value) => (
            <option key={value} value={value}>
              {t('study.review.minutes', { count: value })}
            </option>
          ))}
        </select>
      </label>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground">
        <CalendarClock className="size-4" />
        {overview.exam.date
          ? overview.exam.daysLeft !== null && overview.exam.daysLeft >= 0
            ? t('study.review.examIn', { date: overview.exam.date, days: overview.exam.daysLeft })
            : t('study.review.examPassed', { date: overview.exam.date })
          : t('study.review.noExam')}
        {overview.exam.scope ? (
          <span className="max-w-[22rem] truncate" title={overview.exam.scope}>
            · {t('study.review.scope', { scope: overview.exam.scope })}
          </span>
        ) : (
          <span>· {t('study.review.noScope')}</span>
        )}
        <Link
          href={`/study/${encodeURIComponent(spaceId)}`}
          className="text-xs underline underline-offset-2 hover:text-foreground"
        >
          {t('study.review.editExam')}
        </Link>
      </span>
    </div>
  );
}

// ── summary ─────────────────────────────────────────────────────────────────

function SummaryCard({
  spaceId,
  summary,
  working,
  off,
  onDeleted,
}: {
  spaceId: string;
  summary: SummaryView | null;
  working: boolean;
  off: boolean;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  if (off) return null;
  return (
    <section
      className="mb-5 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm"
      data-testid="review-summary"
    >
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Eye className="size-3.5" />
        {t('study.review.summary.title')}
        {working ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
      </p>
      {summary?.text ? (
        <>
          <p className="leading-6 text-foreground" data-testid="review-summary-text">
            {summary.text}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {t('study.memory.summary.meta')} <RelativeTime iso={summary.createdAt} />
            </span>
            <button
              type="button"
              disabled={busy}
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => {
                setBusy(true);
                void reviewApi
                  .deleteSummary(spaceId)
                  .then(() => {
                    onDeleted();
                    toast.success(t('study.memory.summary.deleted'));
                  })
                  .catch(() => toast.error(t('study.errors.generic')))
                  .finally(() => setBusy(false));
              }}
              data-testid="review-summary-delete"
            >
              {t('study.memory.summary.delete')}
            </button>
          </p>
        </>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          {working ? t('study.review.summary.working') : t('study.review.summary.none')}
        </p>
      )}
    </section>
  );
}

// ── tasks ───────────────────────────────────────────────────────────────────

function TaskSection({
  title,
  hint,
  empty,
  tasks,
  testId,
  spaceId,
  overview,
  flags,
  onChanged,
  compact,
  collapsed,
}: {
  title: string;
  hint?: string;
  empty?: string;
  tasks: ReviewTaskView[];
  testId: string;
  spaceId: string;
  overview: ReviewOverview;
  flags: Flags;
  onChanged: () => Promise<void>;
  compact?: boolean;
  collapsed?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(!collapsed);
  return (
    <section className="mb-5" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mb-2 flex w-full items-center gap-1.5 text-left text-sm font-medium text-foreground"
      >
        {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        {title}
      </button>
      {open ? (
        <>
          {hint ? <p className="mb-2 text-xs text-muted-foreground">{hint}</p> : null}
          {tasks.length === 0 && empty ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
              {empty}
            </p>
          ) : (
            <ol className="space-y-2.5">
              {tasks.map((task) => (
                <TaskCard
                  key={task.itemId}
                  task={task}
                  spaceId={spaceId}
                  overview={overview}
                  flags={flags}
                  onChanged={onChanged}
                  compact={compact}
                />
              ))}
            </ol>
          )}
          {tasks.length === 0 && !empty ? (
            <p className="text-xs text-muted-foreground">{t('study.review.section.none')}</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function EvidenceChip({ state }: { state: EvidenceState }) {
  const { t } = useI18n();
  return (
    <span className={cn(CHIP, STATE_STYLE[state])} data-testid="review-evidence">
      {t(`study.review.evidence.${state}`)}
    </span>
  );
}

function reasonText(t: (key: string, values?: Record<string, unknown>) => string, reason: ReviewReason) {
  switch (reason.kind) {
    case 'overdue':
      return t('study.review.reason.overdue', { days: reason.days });
    case 'due':
      return t('study.review.reason.due', { date: reason.date });
    case 'exam':
      return t('study.review.reason.exam', { date: reason.examDate });
    case 'scope':
      return t('study.review.reason.scope', { concepts: reason.concepts.join('、') });
    case 'recent_wrong':
      return t('study.review.reason.recentWrong', { count: reason.count, days: reason.days });
    case 'manual':
      return t('study.review.reason.manual', { date: reason.date });
    default:
      return t(`study.review.reason.${reason.kind}`);
  }
}

function TaskCard({
  task,
  spaceId,
  overview,
  flags,
  onChanged,
  compact,
}: {
  task: ReviewTaskView;
  spaceId: string;
  overview: ReviewOverview;
  flags: Flags;
  onChanged: () => Promise<void>;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const trusted = task.sourceType === 'exam_attempt';

  async function act(kind: ReviewActionKind, until?: string) {
    setBusy(kind);
    try {
      await reviewApi.act(task.itemId, task.revision, kind, until);
      toast.success(
        t(`study.review.done.${kind}`, until ? { date: until } : undefined),
      );
      await onChanged();
    } catch (error) {
      toast.error(
        error instanceof StudyApiError && error.code === 'STUDY_REVISION_CONFLICT'
          ? t('study.errors.conflict')
          : t('study.errors.generic'),
      );
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function redo() {
    setBusy('redo');
    try {
      const paper = await reviewApi.redo(task.itemId, newRequestKey());
      const attempt = await examsApi.start(paper.paperId);
      router.push(
        `/study/${encodeURIComponent(spaceId)}/attempts/${encodeURIComponent(attempt.id)}`,
      );
    } catch (error) {
      toast.error(
        error instanceof StudyApiError && error.code === 'STUDY_REVIEW_REDO_UNAVAILABLE'
          ? t('study.review.redoUnavailable')
          : t('study.errors.generic'),
      );
      setBusy(null);
    }
  }

  const postponed = task.lastAction?.kind === 'postpone' && task.dueSource === 'manual';
  const actions: ReactNode = task.skipped ? (
    <Button
      size="sm"
      variant="outline"
      disabled={busy !== null}
      onClick={() => void act('clear')}
      data-testid="review-restore"
    >
      <Undo2 className="mr-1 size-4" />
      {t('study.review.action.restore')}
    </Button>
  ) : (
    <>
      {task.redo ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void redo()}
          data-testid="review-redo"
        >
          {busy === 'redo' ? (
            <LoaderCircle className="mr-1 size-4 animate-spin" />
          ) : (
            <RotateCcw className="mr-1 size-4" />
          )}
          {t('study.review.action.redo')}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={busy !== null}
        onClick={() => void act('done')}
        title={t('study.review.action.doneHint')}
        data-testid="review-done"
      >
        <Check className="mr-1 size-4" />
        {t('study.review.action.done')}
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" disabled={busy !== null} data-testid="review-postpone">
            <CalendarClock className="mr-1 size-4" />
            {t('study.review.action.postpone')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {[1, 3, 7].map((days) => (
            <DropdownMenuItem
              key={days}
              onSelect={() => void act('postpone', addDays(overview.today, days))}
              data-testid={`review-postpone-${days}`}
            >
              {t('study.review.action.postponeDays', {
                count: days,
                date: addDays(overview.today, days),
              })}
            </DropdownMenuItem>
          ))}
          {postponed ? (
            <DropdownMenuItem onSelect={() => void act('clear')} data-testid="review-unpostpone">
              {t('study.review.action.unpostpone')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy !== null}
        onClick={() => void act('skip')}
        title={t('study.review.action.skipHint')}
        data-testid="review-skip"
      >
        <CalendarX className="mr-1 size-4" />
        {t('study.review.action.skip')}
      </Button>
    </>
  );

  return (
    <li
      className="rounded-2xl border border-border bg-card"
      data-testid="review-task"
      data-item-id={task.itemId}
      data-state={task.evidenceState}
    >
      <div className="p-4">
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <TypeChip type={task.question.type} subtype={task.question.subtype as never} />
          <EvidenceChip state={task.evidenceState} />
          {task.concepts.slice(0, 3).map((concept) => (
            <span key={concept} className={cn(CHIP, 'bg-primary/10 text-primary')}>
              {concept}
            </span>
          ))}
          {task.due ? (
            <span className={cn(CHIP, 'bg-muted text-muted-foreground')} data-testid="review-due">
              {task.due === overview.today
                ? t('study.review.dueToday')
                : t('study.review.dueOn', { date: task.due })}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={cn(
            'w-full text-left text-sm leading-6 text-foreground',
            !open && (compact ? 'line-clamp-1' : 'line-clamp-2'),
          )}
          data-testid="review-task-toggle"
        >
          {trusted ? <MathText text={task.question.stem} /> : task.question.stem}
        </button>
        {!compact || open ? (
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground" data-testid="review-reasons">
            {task.reasons.map((reason) => (
              <li key={JSON.stringify(reason)}>· {reasonText(t, reason)}</li>
            ))}
            <li>
              · {t('study.review.evidenceLine', {
                independent: task.evidence.independentQuestions,
                helped: task.evidence.helped,
                practiced: task.evidence.practiced,
              })}
            </li>
            {task.evidence.lastAnswerAt ? (
              <li>
                · {t('study.review.lastAnswer')} <RelativeTime iso={task.evidence.lastAnswerAt} />
              </li>
            ) : null}
          </ul>
        ) : null}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {actions}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen((value) => !value)}
            data-testid="review-open"
          >
            {open ? <ChevronUp className="mr-1 size-4" /> : <ChevronDown className="mr-1 size-4" />}
            {open ? t('study.review.action.close') : t('study.review.action.open')}
          </Button>
        </div>
      </div>
      {open ? (
        <WrongItemBody
          itemId={task.itemId}
          spaceId={spaceId}
          chatOn={flags.chatOn}
          practiceOn={flags.practiceOn}
        />
      ) : null}
    </li>
  );
}

// ── evidence per knowledge point ────────────────────────────────────────────

function ConceptEvidence({ overview }: { overview: ReviewOverview }) {
  const { t } = useI18n();
  if (overview.concepts.length === 0) return null;
  const scoped = overview.concepts.some((concept) => concept.inScope !== null);
  return (
    <section className="mt-6" data-testid="review-concepts">
      <h2 className="mb-1 text-sm font-medium text-foreground">{t('study.review.concepts.title')}</h2>
      <p className="mb-2 text-xs text-muted-foreground">{t('study.review.concepts.hint')}</p>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[34rem] text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('study.review.concepts.name')}</th>
              {scoped ? (
                <th className="px-2 py-2 font-medium">{t('study.review.concepts.scope')}</th>
              ) : null}
              {EVIDENCE_STATES.map((state) => (
                <th key={state} className="px-2 py-2 text-center font-medium">
                  {t(`study.review.evidence.${state}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {overview.concepts.map((concept) => (
              <tr key={concept.name} data-testid="review-concept">
                <td className="px-3 py-2 text-foreground">{concept.name}</td>
                {scoped ? (
                  <td className="px-2 py-2 text-muted-foreground">
                    {concept.inScope ? t('study.review.concepts.inScope') : '—'}
                  </td>
                ) : null}
                {EVIDENCE_STATES.map((state) => (
                  <td
                    key={state}
                    className={cn(
                      'px-2 py-2 text-center tabular-nums',
                      concept.states[state] ? 'text-foreground' : 'text-muted-foreground/50',
                    )}
                  >
                    {concept.states[state] || '·'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
