'use client';

/**
 * /study/[spaceId]/attempts/[attemptId] — answer a paper and read its report
 * (learning plan B07).
 *
 * - Answers save to the server as the student works (debounced, one save at
 *   a time, revision-checked). If another tab or device saved meanwhile the
 *   server refuses the stale save and the page loads the newer answers, so
 *   nothing is silently overwritten; coming back to the page picks up answers
 *   given elsewhere. A pending save is also sent when the page is left.
 * - Submitting sends the final answers with a per-attempt key; repeating it
 *   (double click, retry, a second device) returns the one stored result.
 * - Until submitted, the page never receives keys or explanations. The report
 *   shows every item with the correct answer, the student's answer and the
 *   explanation, so wrong answers can be reviewed right away.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  ChevronLeft,
  CircleSlash,
  CloudCheck,
  CloudOff,
  LoaderCircle,
  RotateCcw,
  Send,
  XCircle,
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
import { QuizMathText } from '@/components/quiz/QuizMathText';
import { TypeChip, newRequestKey } from '@/components/study/exams/exam-format';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { useI18n } from '@/lib/hooks/use-i18n';
import { examsApi } from '@/lib/study/assessments/client';
import type {
  AttemptAnswers,
  AttemptView,
  PaperItemView,
  ReportItem,
} from '@/lib/study/assessments/contracts';
import { StudyApiError, fetchStudyCapabilities } from '@/lib/study/spaces/client';
import { cn } from '@/lib/utils';

const SAVE_DELAY_MS = 600;

type SaveState = 'saved' | 'pending' | 'saving' | 'error';

function submitKeyFor(attemptId: string): string {
  const name = `zhiyu-submit-${attemptId}`;
  try {
    const stored = sessionStorage.getItem(name);
    if (stored) return stored;
    const key = newRequestKey();
    sessionStorage.setItem(name, key);
    return key;
  } catch {
    return newRequestKey();
  }
}

export function AttemptPage({ spaceId, attemptId }: { spaceId: string; attemptId: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      if (!(await fetchStudyCapabilities()).exams) {
        throw Object.assign(new Error('unavailable'), { status: 404 });
      }
      return examsApi.attempt(attemptId);
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') setAttempt(result.data);
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [attemptId, loadKey]);

  if (state !== 'ready' || !attempt) {
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

  const back = `/study/${encodeURIComponent(spaceId)}/practice?tab=papers`;
  return (
    <StudyShell>
      <Link
        href={back}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t('study.practice.attempt.back')}
      </Link>
      {attempt.status === 'submitted' && attempt.report ? (
        <AttemptReport attempt={attempt} spaceId={spaceId} />
      ) : (
        <AnswerSheet key={attempt.id} initial={attempt} onSubmitted={setAttempt} />
      )}
    </StudyShell>
  );
}

// ── answering ───────────────────────────────────────────────────────────────

function AnswerSheet({
  initial,
  onSubmitted,
}: {
  initial: AttemptView;
  onSubmitted: (attempt: AttemptView) => void;
}) {
  const { t } = useI18n();
  const [answers, setAnswersState] = useState<AttemptAnswers>(initial.answers);
  const answersRef = useRef(initial.answers);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const revision = useRef(initial.revision);
  const pending = useRef<AttemptAnswers | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set when a save found newer answers from elsewhere (submitting then stops for review). */
  const replaced = useRef(false);
  const items = initial.items;

  const setAnswers = useCallback((next: AttemptAnswers) => {
    answersRef.current = next;
    setAnswersState(next);
  }, []);

  /** Take the server's draft (saved from another tab or device). */
  const adoptServer = useCallback(
    (stored: AttemptAnswers | undefined, storedRevision: number | undefined) => {
      if (typeof storedRevision === 'number') revision.current = storedRevision;
      if (stored) setAnswers(stored);
      replaced.current = true;
      pending.current = null;
      setSaveState('saved');
    },
    [setAnswers],
  );

  const reloadSubmitted = useCallback(async () => {
    try {
      onSubmitted(await examsApi.attempt(initial.id));
    } catch {
      setSaveState('error');
    }
  }, [initial.id, onSubmitted]);

  /** Send the newest pending answers (one save at a time). */
  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    while (inFlight.current) await inFlight.current;
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setSaveState('saving');
    const run = examsApi
      .saveDraft(initial.id, next, revision.current)
      .then((saved) => {
        revision.current = saved.revision;
        setSaveState(pending.current ? 'pending' : 'saved');
      })
      .catch((error: unknown) => {
        if (error instanceof StudyApiError && error.code === 'STUDY_REVISION_CONFLICT') {
          adoptServer(
            error.body?.answers as AttemptAnswers | undefined,
            error.body?.revision as number | undefined,
          );
          toast.info(t('study.practice.attempt.updatedElsewhere'));
          return;
        }
        if (error instanceof StudyApiError && error.code === 'STUDY_ATTEMPT_SUBMITTED') {
          void reloadSubmitted();
          return;
        }
        pending.current ??= next;
        setSaveState('error');
      });
    inFlight.current = run.finally(() => {
      inFlight.current = null;
    });
    await inFlight.current;
  }, [adoptServer, initial.id, reloadSubmitted, t]);

  function choose(item: PaperItemView, value: string) {
    const current = answersRef.current;
    const key = String(item.position);
    const selected = current[key] ?? [];
    const nextValues =
      item.type === 'single'
        ? selected[0] === value
          ? []
          : [value]
        : selected.includes(value)
          ? selected.filter((entry) => entry !== value)
          : [...selected, value].sort();
    const next = { ...current };
    if (nextValues.length) next[key] = nextValues;
    else delete next[key];
    setAnswers(next);
    pending.current = next;
    setSaveState('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  // Leaving the page: send what is pending; coming back: pick up answers saved elsewhere.
  useEffect(() => {
    const sendPending = () => {
      const next = pending.current;
      if (!next) return;
      void fetch(`/api/study/attempts/${encodeURIComponent(initial.id)}/answers`, {
        method: 'PUT',
        keepalive: true,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: next, baseRevision: revision.current }),
      }).catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void flush();
        return;
      }
      if (pending.current || inFlight.current) return;
      void examsApi
        .attempt(initial.id)
        .then((latest) => {
          if (latest.status === 'submitted') onSubmitted(latest);
          else if (latest.revision !== revision.current && !pending.current) {
            adoptServer(latest.answers, latest.revision);
          }
        })
        .catch(() => undefined);
    };
    window.addEventListener('pagehide', sendPending);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', sendPending);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [adoptServer, flush, initial.id, onSubmitted]);

  async function submit() {
    setSubmitting(true);
    replaced.current = false;
    try {
      await flush();
      if (replaced.current) {
        toast.warning(t('study.practice.attempt.conflictBeforeSubmit'));
        setSubmitting(false);
        return;
      }
      const result = await examsApi.submit(
        initial.id,
        submitKeyFor(initial.id),
        answersRef.current,
        revision.current,
      );
      if (result.alreadySubmitted) toast.info(t('study.practice.attempt.submittedElsewhere'));
      onSubmitted(result.attempt);
    } catch (error) {
      if (error instanceof StudyApiError && error.code === 'STUDY_REVISION_CONFLICT') {
        adoptServer(
          error.body?.answers as AttemptAnswers | undefined,
          error.body?.revision as number | undefined,
        );
        toast.warning(t('study.practice.attempt.conflictBeforeSubmit'));
      } else {
        toast.error(t('study.errors.generic'));
      }
      setSubmitting(false);
    }
  }

  const answered = items.filter((item) => answers[String(item.position)]?.length).length;

  return (
    <div data-testid="attempt-sheet">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-[-0.02em] text-foreground">
            {initial.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="attempt-progress">
            {t('study.practice.attempt.progress', { answered, total: items.length })}
          </p>
        </div>
        <SaveIndicator state={saveState} onRetry={() => void flush()} />
      </header>

      <ol className="space-y-4">
        {items.map((item) => {
          const selected = answers[String(item.position)] ?? [];
          return (
            <li
              key={item.position}
              data-testid="attempt-item"
              className="rounded-2xl border border-border bg-card p-4 md:p-5"
            >
              <div className="mb-3 flex items-start gap-2">
                <span className="mt-0.5 text-sm font-semibold text-muted-foreground">
                  {item.position}.
                </span>
                <div className="min-w-0 flex-1 text-sm leading-6 text-foreground">
                  <QuizMathText text={item.stem} allowDisplayMode />
                </div>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-1.5 pl-6">
                <TypeChip type={item.type} />
                <span className="text-[11px] text-muted-foreground">
                  {t('study.practice.attempt.points', { points: item.points })}
                </span>
              </div>
              <div className="grid gap-2 pl-6">
                {item.options.map((option) => {
                  const on = selected.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role={item.type === 'single' ? 'radio' : 'checkbox'}
                      aria-checked={on}
                      data-testid="attempt-option"
                      data-value={option.value}
                      onClick={() => choose(item, option.value)}
                      className={cn(
                        'flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left text-sm transition-colors',
                        on
                          ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                          : 'border-border hover:border-primary/40 hover:bg-muted/40',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-7 shrink-0 items-center justify-center text-xs font-semibold',
                          item.type === 'single' ? 'rounded-full' : 'rounded-md',
                          on
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {option.value}
                      </span>
                      <span className="flex-1">
                        <QuizMathText text={option.label} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="sticky bottom-0 mt-6 flex items-center justify-between gap-3 border-t border-border bg-background/90 py-4 backdrop-blur">
        <p className="text-sm text-muted-foreground">
          {t('study.practice.attempt.progress', { answered, total: items.length })}
        </p>
        <Button
          disabled={submitting}
          onClick={() => setConfirming(true)}
          data-testid="attempt-submit"
        >
          {submitting ? (
            <LoaderCircle className="mr-1 size-4 animate-spin" />
          ) : (
            <Send className="mr-1 size-4" />
          )}
          {t('study.practice.attempt.submit')}
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('study.practice.attempt.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {answered < items.length
                ? t('study.practice.attempt.confirmUnanswered', {
                    count: items.length - answered,
                    numbers: items
                      .filter((item) => !answers[String(item.position)]?.length)
                      .map((item) => item.position)
                      .join(t('study.practice.separator')),
                  })
                : t('study.practice.attempt.confirmAll')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('study.practice.attempt.keepAnswering')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="attempt-submit-confirm"
              onClick={() => {
                setConfirming(false);
                void submit();
              }}
            >
              {t('study.practice.attempt.submit')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const { t } = useI18n();
  if (state === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1 text-xs text-destructive"
        data-testid="attempt-save-state"
        data-state={state}
      >
        <CloudOff className="size-3.5" />
        {t('study.practice.attempt.saveFailed')}
      </button>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      data-testid="attempt-save-state"
      data-state={state}
    >
      {state === 'saved' ? (
        <CloudCheck className="size-3.5" />
      ) : (
        <LoaderCircle className="size-3.5 animate-spin" />
      )}
      {state === 'saved' ? t('study.practice.attempt.saved') : t('study.practice.attempt.saving')}
    </span>
  );
}

// ── report ──────────────────────────────────────────────────────────────────

const OUTCOME_ICON = {
  correct: CheckCircle2,
  incorrect: XCircle,
  unanswered: CircleSlash,
  ungradable: CircleSlash,
} as const;

function AttemptReport({ attempt, spaceId }: { attempt: AttemptView; spaceId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [onlyMistakes, setOnlyMistakes] = useState(false);
  const [starting, setStarting] = useState(false);
  const report = attempt.report!;
  const shown = useMemo(
    () =>
      onlyMistakes
        ? report.items.filter(
            (item) => item.outcome === 'incorrect' || item.outcome === 'unanswered',
          )
        : report.items,
    [onlyMistakes, report.items],
  );

  async function again() {
    setStarting(true);
    try {
      const next = await examsApi.start(attempt.paperId);
      router.push(`/study/${encodeURIComponent(spaceId)}/attempts/${encodeURIComponent(next.id)}`);
    } catch {
      toast.error(t('study.errors.generic'));
      setStarting(false);
    }
  }

  const grading = report.grading;
  return (
    <div data-testid="attempt-report">
      <header className="mb-6 rounded-2xl border border-primary/20 bg-primary/5 p-5">
        <h1 className="text-xl font-semibold text-foreground">{attempt.title}</h1>
        <p className="mt-3 text-3xl font-semibold text-primary" data-testid="attempt-score">
          {t('study.practice.report.score', {
            earned: grading.earned,
            total: grading.totalPoints,
          })}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('study.practice.report.summary', {
            correct: grading.correct,
            count: report.items.length,
            unanswered: grading.unanswered,
          })}
          {grading.ungradable
            ? ` · ${t('study.practice.report.ungradable', { count: grading.ungradable })}`
            : ''}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{t('study.practice.report.gradedBy')}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" disabled={starting} onClick={() => void again()}>
            <RotateCcw className="mr-1 size-4" />
            {t('study.practice.papers.again')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-pressed={onlyMistakes}
            onClick={() => setOnlyMistakes((value) => !value)}
            data-testid="report-only-mistakes"
          >
            {onlyMistakes
              ? t('study.practice.report.showAll')
              : t('study.practice.report.onlyMistakes')}
          </Button>
        </div>
      </header>

      {shown.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
          {t('study.practice.report.noMistakes')}
        </p>
      ) : (
        <ol className="space-y-4">
          {shown.map((item) => (
            <ReportCard key={item.position} item={item} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ReportCard({ item }: { item: ReportItem }) {
  const { t } = useI18n();
  const Icon = OUTCOME_ICON[item.outcome];
  const sourceLine = [
    item.source.packTitle ?? item.source.title,
    item.source.page,
    item.source.attribution,
    item.source.license,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li
      className="rounded-2xl border border-border bg-card p-4 md:p-5"
      data-testid="report-item"
      data-outcome={item.outcome}
    >
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 text-sm font-semibold text-muted-foreground">{item.position}.</span>
        <div className="min-w-0 flex-1 text-sm leading-6 text-foreground">
          <QuizMathText text={item.stem} allowDisplayMode />
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs',
            item.outcome === 'correct' &&
              'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
            item.outcome === 'incorrect' && 'bg-red-500/10 text-red-600 dark:text-red-400',
            (item.outcome === 'unanswered' || item.outcome === 'ungradable') &&
              'bg-muted text-muted-foreground',
          )}
        >
          <Icon className="size-3.5" />
          {t(`study.practice.report.outcome.${item.outcome}`)}
          {item.outcome !== 'ungradable' ? ` · ${item.earned}/${item.points}` : ''}
        </span>
      </div>
      <div className="grid gap-2 pl-6">
        {item.options.map((option) => {
          const isKey = item.answer.includes(option.value);
          const chosen = item.response.includes(option.value);
          return (
            <div
              key={option.value}
              className={cn(
                'flex items-center gap-3 rounded-xl border px-3.5 py-2 text-sm',
                isKey && 'border-emerald-400/70 bg-emerald-500/5',
                chosen && !isKey && 'border-red-300 bg-red-500/5',
                !isKey && !chosen && 'border-border text-muted-foreground',
              )}
            >
              <span className="w-5 text-xs font-semibold">{option.value}</span>
              <span className="flex-1">
                <QuizMathText text={option.label} />
              </span>
              {chosen ? (
                <span className="text-[11px] text-muted-foreground">
                  {t('study.practice.report.yourChoice')}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="mt-3 space-y-1 pl-6 text-sm">
        <p className="text-muted-foreground">
          {t('study.practice.report.key', { answer: item.answer.join(', ') || '—' })}
        </p>
        {item.explanation ? (
          <div className="rounded-xl bg-muted/50 px-3 py-2 text-foreground">
            <QuizMathText text={item.explanation} allowDisplayMode />
          </div>
        ) : null}
        {sourceLine ? <p className="text-xs text-muted-foreground">{sourceLine}</p> : null}
      </div>
    </li>
  );
}
