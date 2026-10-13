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
 * - Open items (B09) are answered in text (calculations also take a final
 *   answer). After submission choice items are scored at once; the report
 *   then asks the server to grade the open items one at a time, shows each
 *   result as it arrives (points per scoring point, feedback, what was
 *   missing), lets a failed one be retried, and lets the student ask for
 *   another review or record their own score — earlier results stay visible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  ChevronLeft,
  CircleDot,
  CircleSlash,
  CloudCheck,
  CloudOff,
  Hourglass,
  LoaderCircle,
  RotateCcw,
  Send,
  Sparkles,
  UserPen,
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  GuideDetails,
  QuestionFigures,
  SourceDetails,
  TypeChip,
  newRequestKey,
  MathText,
  useCriterionLabel,
} from '@/components/study/exams/exam-format';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { useI18n } from '@/lib/hooks/use-i18n';
import { examsApi } from '@/lib/study/assessments/client';
import {
  ATTEMPT_LIMITS,
  answersByteLength,
  hasAnswer,
  isOpenAnswer,
  latestSelfGrading,
  officialGrading,
  scoredGrading,
  type AttemptAnswers,
  type AttemptView,
  type ItemGradingView,
  type ItemOutcome,
  type OpenAnswer,
  type PaperItemView,
  type ReportItem,
} from '@/lib/study/assessments/contracts';
import type { RubricCriterion } from '@/lib/study/questions/contracts';
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
  const [canGrade, setCanGrade] = useState(false);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      const capabilities = await fetchStudyCapabilities();
      if (!capabilities.exams) {
        throw Object.assign(new Error('unavailable'), { status: 404 });
      }
      if (!cancelled) setCanGrade(capabilities.grading);
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
        <AttemptReport attempt={attempt} spaceId={spaceId} canGrade={canGrade} />
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

  /** Store a changed answer set and save it after a short pause. */
  function change(next: AttemptAnswers) {
    setAnswers(next);
    if (answersByteLength(next) > ATTEMPT_LIMITS.answersBytes) {
      setSaveState('error');
      toast.error(t('study.practice.attempt.tooLong'));
      return;
    }
    pending.current = next;
    setSaveState('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  function writeOpen(item: PaperItemView, patch: Partial<OpenAnswer>) {
    const current = answersRef.current;
    const key = String(item.position);
    const previous = current[key];
    const merged: OpenAnswer = { text: '', ...(isOpenAnswer(previous) ? previous : {}), ...patch };
    const next = { ...current };
    if (merged.text || merged.final) {
      next[key] = merged.final ? merged : { text: merged.text };
    } else {
      delete next[key];
    }
    change(next);
  }

  function choose(item: PaperItemView, value: string) {
    const current = answersRef.current;
    const key = String(item.position);
    const stored = current[key];
    const selected = Array.isArray(stored) ? stored : [];
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
    change(next);
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

  const answered = items.filter((item) => hasAnswer(answers[String(item.position)])).length;
  const hasOpen = items.some((item) => item.type === 'short_answer');

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
      {hasOpen ? (
        <p className="mb-4 rounded-xl bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
          {t('study.practice.attempt.openNotice')}
        </p>
      ) : null}

      <ol className="space-y-4">
        {items.map((item) => {
          const stored = answers[String(item.position)];
          const selected = Array.isArray(stored) ? stored : [];
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
                  <MathText text={item.stem} allowDisplayMode />
                  <QuestionFigures figures={item.figures} />
                </div>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-1.5 pl-6">
                <TypeChip type={item.type} subtype={item.subtype} />
                <span className="text-[11px] text-muted-foreground">
                  {t('study.practice.attempt.points', { points: item.points })}
                </span>
              </div>
              {item.type === 'short_answer' ? (
                <OpenAnswerInput
                  item={item}
                  value={isOpenAnswer(stored) ? stored : null}
                  onChange={(patch) => writeOpen(item, patch)}
                />
              ) : (
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
                          <MathText text={option.label} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
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
                      .filter((item) => !hasAnswer(answers[String(item.position)]))
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

/** Working (and a calculation's final answer) for one open item. */
function OpenAnswerInput({
  item,
  value,
  onChange,
}: {
  item: PaperItemView;
  value: OpenAnswer | null;
  onChange: (patch: Partial<OpenAnswer>) => void;
}) {
  const { t } = useI18n();
  const text = value?.text ?? '';
  return (
    <div className="space-y-2 pl-6">
      <Textarea
        rows={6}
        maxLength={ATTEMPT_LIMITS.openText}
        value={text}
        data-testid="attempt-open-text"
        placeholder={t(`study.practice.attempt.openPlaceholder.${item.subtype ?? 'short'}`)}
        onChange={(event) => onChange({ text: event.target.value })}
      />
      {text.includes('$') ? (
        <div className="whitespace-pre-wrap rounded-md bg-muted/50 px-3 py-2 text-sm">
          <MathText text={text} allowDisplayMode />
        </div>
      ) : null}
      {item.subtype === 'calculation' ? (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="shrink-0 text-muted-foreground">
            {t('study.practice.attempt.finalLabel')}
          </span>
          <Input
            className="max-w-xs flex-1"
            maxLength={ATTEMPT_LIMITS.finalText}
            value={value?.final ?? ''}
            data-testid="attempt-open-final"
            placeholder={t('study.practice.attempt.finalPlaceholder')}
            onChange={(event) => onChange({ final: event.target.value })}
          />
        </label>
      ) : null}
      <p className="text-right text-[11px] text-muted-foreground">
        {text.length}/{ATTEMPT_LIMITS.openText}
      </p>
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

const OUTCOME_ICON: Record<ItemOutcome, typeof CheckCircle2> = {
  correct: CheckCircle2,
  incorrect: XCircle,
  partial: CircleDot,
  unanswered: CircleSlash,
  ungradable: CircleSlash,
  pending: Hourglass,
};

const POLL_MS = 4000;

/**
 * Grades the open items of a submitted attempt one request at a time while
 * any is waiting; when another tab or device holds an item it polls instead.
 * Stops on unmount and on errors (shown with a retry).
 */
function useOpenGrading(
  attempt: AttemptView,
  setAttempt: (attempt: AttemptView) => void,
  enabled: boolean,
) {
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const waiting = attempt.report?.summary.pending ?? 0;
  useEffect(() => {
    if (!enabled || waiting === 0 || error) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      try {
        const result = await examsApi.grade(attempt.id, null, controller.signal);
        if (controller.signal.aborted) return;
        setAttempt(result.attempt);
        if (!result.graded && result.waiting > 0) {
          // Another request holds the waiting item: check back shortly.
          timer = setTimeout(() => {
            void examsApi
              .attempt(attempt.id)
              .then((latest) => {
                if (!controller.signal.aborted) setAttempt(latest);
              })
              .catch(() => undefined)
              .finally(() => setRound((value) => value + 1));
          }, POLL_MS);
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure instanceof StudyApiError ? failure.code : 'generic');
      }
    };
    void run();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // `attempt` changes with every result; the loop continues through it.
  }, [attempt, waiting, error, round, setAttempt, enabled]);
  return { error, retry: () => setError(null) };
}

function AttemptReport({
  attempt: initial,
  spaceId,
  canGrade,
}: {
  attempt: AttemptView;
  spaceId: string;
  /** Assisted grading switched on (otherwise waiting items stay waiting). */
  canGrade: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [attempt, setAttempt] = useState(initial);
  const [onlyMistakes, setOnlyMistakes] = useState(false);
  const [starting, setStarting] = useState(false);
  const grading = useOpenGrading(attempt, setAttempt, canGrade);
  const report = attempt.report!;
  const shown = useMemo(
    () =>
      onlyMistakes
        ? report.items.filter(
            (item) =>
              item.outcome === 'incorrect' ||
              item.outcome === 'partial' ||
              item.outcome === 'unanswered',
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

  const summary = report.summary;
  const mixed = report.items.some((item) => item.type === 'short_answer');
  return (
    <div data-testid="attempt-report" data-state={summary.state}>
      <header className="mb-6 rounded-2xl border border-primary/20 bg-primary/5 p-5">
        <h1 className="text-xl font-semibold text-foreground">{attempt.title}</h1>
        <p className="mt-3 text-3xl font-semibold text-primary" data-testid="attempt-score">
          {t('study.practice.report.score', {
            earned: summary.earned,
            total: summary.totalPoints,
          })}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('study.practice.report.summary', {
            correct: summary.correct,
            count: report.items.length,
            unanswered: summary.unanswered,
          })}
          {summary.ungradable
            ? ` · ${t('study.practice.report.ungradable', { count: summary.ungradable })}`
            : ''}
        </p>
        {summary.state === 'grading' && canGrade ? (
          <p
            className="mt-2 inline-flex items-center gap-1.5 text-sm text-foreground"
            data-testid="attempt-grading-state"
          >
            <LoaderCircle className="size-4 animate-spin" />
            {t('study.practice.report.grading', { count: summary.pending })}
          </p>
        ) : null}
        {(summary.pending || summary.failed) && !canGrade ? (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="attempt-grading-off">
            {t('study.practice.report.gradingOff', { count: summary.pending + summary.failed })}
          </p>
        ) : null}
        {summary.state === 'partial' && canGrade ? (
          <p
            className="mt-2 text-sm text-amber-700 dark:text-amber-400"
            data-testid="attempt-grading-state"
          >
            {t('study.practice.report.partial', { count: summary.failed })}
          </p>
        ) : null}
        {grading.error ? (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-destructive">
            {t(`study.practice.report.gradingError.${errorKey(grading.error)}`)}
            <Button size="sm" variant="outline" onClick={grading.retry}>
              {t('study.practice.report.retryGrading')}
            </Button>
          </p>
        ) : null}
        {summary.selfEarned !== null ? (
          <p className="mt-1 text-sm text-muted-foreground" data-testid="attempt-self-total">
            {t('study.practice.report.selfTotal', {
              earned: summary.selfEarned,
              total: summary.totalPoints,
            })}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {mixed ? t('study.practice.report.gradedByMixed') : t('study.practice.report.gradedBy')}
        </p>
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
          {shown.map((item) =>
            item.type === 'short_answer' ? (
              <OpenReportCard
                key={item.position}
                attemptId={attempt.id}
                item={item}
                canGrade={canGrade}
                onAttempt={setAttempt}
              />
            ) : (
              <ReportCard key={item.position} item={item} />
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function OutcomeChip({ item }: { item: ReportItem }) {
  const { t } = useI18n();
  const Icon = OUTCOME_ICON[item.outcome];
  return (
    <span
      data-testid="report-outcome"
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs',
        item.outcome === 'correct' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        item.outcome === 'incorrect' && 'bg-red-500/10 text-red-600 dark:text-red-400',
        item.outcome === 'partial' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
        (item.outcome === 'unanswered' ||
          item.outcome === 'ungradable' ||
          item.outcome === 'pending') &&
          'bg-muted text-muted-foreground',
      )}
    >
      <Icon className="size-3.5" />
      {t(`study.practice.report.outcome.${item.outcome}`)}
      {item.outcome !== 'ungradable' && item.outcome !== 'pending'
        ? ` · ${item.earned}/${item.points}`
        : ''}
    </span>
  );
}

/** Known error codes get their own text; anything else is generic. */
function errorKey(code: string): string {
  if (code === 'personal_limit' || code === 'site_limit') return 'capacity';
  return ['STUDY_GRADING_MODEL_UNAVAILABLE', 'STUDY_GRADING_LIMIT', 'STUDY_GRADING_BUSY'].includes(
    code,
  )
    ? code
    : 'generic';
}

function ReportCard({ item }: { item: ReportItem }) {
  const { t } = useI18n();
  return (
    <li
      className="rounded-2xl border border-border bg-card p-4 md:p-5"
      data-testid="report-item"
      data-outcome={item.outcome}
    >
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 text-sm font-semibold text-muted-foreground">{item.position}.</span>
        <div className="min-w-0 flex-1 text-sm leading-6 text-foreground">
          <MathText text={item.stem} allowDisplayMode />
          <QuestionFigures figures={item.figures} />
        </div>
        <OutcomeChip item={item} />
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
                <MathText text={option.label} />
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
            <MathText text={item.explanation} allowDisplayMode />
          </div>
        ) : null}
        <SourceDetails source={item.source} />
      </div>
    </li>
  );
}

/** An open item of the report: the answer, its grading(s), the guide, and what the student can do. */
function OpenReportCard({
  attemptId,
  item,
  canGrade,
  onAttempt,
}: {
  attemptId: string;
  item: ReportItem;
  canGrade: boolean;
  onAttempt: (attempt: AttemptView) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [selfOpen, setSelfOpen] = useState(false);
  const official = officialGrading(item.gradings);
  const scored = scoredGrading(item.gradings);
  const self = latestSelfGrading(item.gradings);
  const earlier = item.gradings.filter(
    (grading) => grading.kind !== 'self' && grading.status === 'succeeded' && grading !== scored,
  );
  const reviewing = official && official !== scored && official.status !== 'failed';
  const failed = official?.status === 'failed' ? official : null;

  async function act(run: () => Promise<AttemptView>) {
    setBusy(true);
    try {
      onAttempt(await run());
    } catch (error) {
      toast.error(
        t(
          `study.practice.report.gradingError.${errorKey(
            error instanceof StudyApiError ? error.code : 'generic',
          )}`,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className="rounded-2xl border border-border bg-card p-4 md:p-5"
      data-testid="report-item"
      data-outcome={item.outcome}
      data-type="open"
    >
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 text-sm font-semibold text-muted-foreground">{item.position}.</span>
        <div className="min-w-0 flex-1 text-sm leading-6 text-foreground">
          <MathText text={item.stem} allowDisplayMode />
          <QuestionFigures figures={item.figures} />
        </div>
        <OutcomeChip item={item} />
      </div>
      <div className="space-y-3 pl-6 text-sm">
        <div className="rounded-xl border border-border px-3 py-2">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t('study.practice.report.yourAnswer')}
          </p>
          {item.openResponse ? (
            <>
              <div className="whitespace-pre-wrap text-foreground">
                <MathText text={item.openResponse.text || '—'} allowDisplayMode />
              </div>
              {item.openResponse.final ? (
                <p className="mt-1 text-foreground">
                  <span className="text-xs text-muted-foreground">
                    {t('study.practice.report.yourFinal')}
                  </span>{' '}
                  {item.openResponse.final}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">{t('study.practice.report.outcome.unanswered')}</p>
          )}
        </div>

        {official && !scored && official.status !== 'failed' && canGrade ? (
          <p
            className="inline-flex items-center gap-1.5 text-muted-foreground"
            data-testid="open-grading-wait"
          >
            <LoaderCircle className="size-4 animate-spin" />
            {official.status === 'running'
              ? t('study.practice.report.gradingRunning')
              : t('study.practice.report.gradingWaiting')}
          </p>
        ) : null}

        {scored ? <GradingDetails grading={scored} rubric={item.guide?.rubric ?? []} /> : null}

        {reviewing && canGrade ? (
          <p className="inline-flex items-center gap-1.5 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {t('study.practice.report.reviewing')}
          </p>
        ) : null}

        {failed && canGrade ? (
          <p
            className="flex flex-wrap items-center gap-2 text-destructive"
            data-testid="open-grading-failed"
          >
            {scored
              ? t('study.practice.report.reviewFailed', {
                  reason: t(`study.practice.report.failure.${failureKey(failed.error)}`),
                })
              : t('study.practice.report.gradingFailed', {
                  reason: t(`study.practice.report.failure.${failureKey(failed.error)}`),
                })}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              data-testid="open-grading-retry"
              onClick={() =>
                void act(async () => (await examsApi.grade(attemptId, item.position)).attempt)
              }
            >
              {busy ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
              {t('study.practice.report.retryItem')}
            </Button>
          </p>
        ) : null}

        {self ? (
          <p
            className="rounded-xl bg-sky-500/5 px-3 py-2 text-foreground"
            data-testid="open-self-grade"
          >
            <UserPen className="mr-1 inline size-3.5 text-sky-600" />
            {t('study.practice.report.selfShown', {
              earned: self.earned ?? 0,
              points: item.points,
            })}
            {self.note ? <span className="text-muted-foreground"> · {self.note}</span> : null}
          </p>
        ) : null}

        {earlier.length ? (
          <details className="rounded-xl border border-dashed border-border px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t('study.practice.report.earlier', { count: earlier.length })}
            </summary>
            <div className="mt-2 space-y-3">
              {earlier.map((grading) => (
                <GradingDetails
                  key={grading.seq}
                  grading={grading}
                  rubric={item.guide?.rubric ?? []}
                  compact
                />
              ))}
            </div>
          </details>
        ) : null}

        <div className="rounded-xl bg-muted/40 px-3 py-2">
          <GuideDetails guide={item.guide} points={item.points} />
          {item.explanation ? (
            <div className="mt-2 text-foreground">
              <MathText text={item.explanation} allowDisplayMode />
            </div>
          ) : null}
        </div>
        <SourceDetails source={item.source} />

        {scored && item.openResponse && canGrade ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || Boolean(reviewing)}
              data-testid="open-review"
              onClick={() => void act(() => examsApi.regrade(attemptId, item.position))}
            >
              <Sparkles className="mr-1 size-3.5" />
              {t('study.practice.report.review')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              data-testid="open-self-open"
              onClick={() => setSelfOpen((value) => !value)}
            >
              <UserPen className="mr-1 size-3.5" />
              {t('study.practice.report.selfGrade')}
            </Button>
          </div>
        ) : null}
        {selfOpen ? (
          <SelfGradeForm
            points={item.points}
            busy={busy}
            onSave={(earned, note) =>
              void act(async () => {
                const next = await examsApi.selfGrade(attemptId, item.position, earned, note);
                setSelfOpen(false);
                return next;
              })
            }
          />
        ) : null}
      </div>
    </li>
  );
}

function failureKey(error: string | null): string {
  return ['timeout', 'invalid_output', 'model_unavailable', 'model_error', 'lease_lost'].includes(
    error ?? '',
  )
    ? (error as string)
    : 'other';
}

/** One grading: points per scoring point (and who decided them), feedback, shortcomings, grader. */
function GradingDetails({
  grading,
  rubric,
  compact = false,
}: {
  grading: ItemGradingView;
  /** The frozen scoring points, for their wording (results keep only ids). */
  rubric: readonly RubricCriterion[];
  compact?: boolean;
}) {
  const { t } = useI18n();
  const criterionLabel = useCriterionLabel();
  const label = (criterion: { id: string }) =>
    criterionLabel(rubric.find((entry) => entry.id === criterion.id) ?? criterion);
  const result = grading.result;
  if (!result) return null;
  return (
    <div
      className={cn(
        'space-y-2',
        !compact && 'rounded-xl border border-primary/20 bg-primary/5 px-3 py-2',
      )}
      data-testid="open-grading-result"
    >
      <p className="text-xs font-medium text-muted-foreground">
        {grading.kind === 'review'
          ? t('study.practice.report.reviewResult', {
              earned: grading.earned ?? 0,
              points: grading.points,
            })
          : t('study.practice.report.gradingResult', {
              earned: grading.earned ?? 0,
              points: grading.points,
            })}
      </p>
      <ul className="space-y-1">
        {result.criteria.map((criterion) => (
          <li key={criterion.id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-foreground">
              {criterion.awarded}/{criterion.points}
            </span>
            <span className="text-foreground">{label(criterion)}</span>
            <span className="text-[11px] text-muted-foreground">
              {criterion.by === 'program'
                ? t('study.practice.report.byProgram')
                : t('study.practice.report.byModel')}
            </span>
            {criterion.comment ? (
              <span className="basis-full text-xs text-muted-foreground">
                <MathText text={criterion.comment} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {result.feedback && !compact ? (
        <div className="text-foreground">
          <MathText text={result.feedback} />
        </div>
      ) : null}
      {result.shortcomings.length && !compact ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            {t('study.practice.report.shortcomings')}
          </p>
          <ul className="list-disc pl-5 text-foreground">
            {result.shortcomings.map((entry) => (
              <li key={entry}>
                <MathText text={entry} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {grading.grader ? (
        <p className="text-[11px] text-muted-foreground">
          {[
            grading.grader.model
              ? t('study.practice.report.graderModel', { model: grading.grader.model })
              : null,
            grading.grader.program ? t('study.practice.report.graderProgram') : null,
            grading.grader.version,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

function SelfGradeForm({
  points,
  busy,
  onSave,
}: {
  points: number;
  busy: boolean;
  onSave: (earned: number, note: string | null) => void;
}) {
  const { t } = useI18n();
  const [earned, setEarned] = useState('');
  const [note, setNote] = useState('');
  const value = Number(earned);
  const valid = earned.trim() !== '' && Number.isInteger(value) && value >= 0 && value <= points;
  return (
    <div
      className="space-y-2 rounded-xl border border-border px-3 py-2"
      data-testid="open-self-form"
    >
      <p className="text-xs text-muted-foreground">{t('study.practice.report.selfHint')}</p>
      <label className="flex items-center gap-2">
        <span className="text-sm">{t('study.practice.report.selfLabel', { points })}</span>
        <Input
          type="number"
          className="w-24"
          min={0}
          max={points}
          value={earned}
          data-testid="open-self-earned"
          onChange={(event) => setEarned(event.target.value)}
        />
      </label>
      <Textarea
        rows={2}
        maxLength={500}
        value={note}
        placeholder={t('study.practice.report.selfNote')}
        onChange={(event) => setNote(event.target.value)}
      />
      <Button
        size="sm"
        disabled={!valid || busy}
        data-testid="open-self-save"
        onClick={() => onSave(value, note.trim() || null)}
      >
        {t('study.practice.report.selfSave')}
      </Button>
    </div>
  );
}
