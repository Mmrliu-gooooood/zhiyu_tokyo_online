'use client';

/**
 * Practice help and its record (learning plan B11): the hint and solution
 * buttons of a practice paper's item while the attempt is open, and the
 * chips that say afterwards whether an answer was an independent check
 * (a new question, answered right without help) or practice.
 */
import { useState } from 'react';
import { BadgeCheck, Eye, Lightbulb, LoaderCircle, Repeat2, Shuffle } from 'lucide-react';
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
import { MathText } from '@/components/study/exams/exam-format';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { AttemptView } from '@/lib/study/assessments/contracts';
import { practiceApi } from '@/lib/study/practice/client';
import type { AssistanceLevel, ItemAssistanceView } from '@/lib/study/practice/contracts';
import { cn } from '@/lib/utils';

const CHIP = 'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px]';

/** Hint and solution of one practice item (recorded on the server when shown). */
export function PracticeHelp({
  attemptId,
  position,
  view,
  onAttempt,
}: {
  attemptId: string;
  position: number;
  view: ItemAssistanceView | undefined;
  onAttempt: (attempt: AttemptView) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<'hint' | 'solution' | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function show(level: 'hint' | 'solution') {
    setBusy(level);
    try {
      onAttempt(await practiceApi.assist(attemptId, position, level));
    } catch {
      toast.error(t('study.errors.generic'));
    } finally {
      setBusy(null);
    }
  }

  const solution = view?.solution ?? null;
  return (
    <div className="mt-3 space-y-2 pl-6" data-testid="practice-help">
      <div className="flex flex-wrap gap-2">
        {view?.hintAvailable && !view.hint ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void show('hint')}
            data-testid="practice-hint"
          >
            {busy === 'hint' ? (
              <LoaderCircle className="mr-1 size-4 animate-spin" />
            ) : (
              <Lightbulb className="mr-1 size-4" />
            )}
            {t('study.practice.help.hint')}
          </Button>
        ) : null}
        {!solution ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setConfirming(true)}
            data-testid="practice-solution"
          >
            {busy === 'solution' ? (
              <LoaderCircle className="mr-1 size-4 animate-spin" />
            ) : (
              <Eye className="mr-1 size-4" />
            )}
            {t('study.practice.help.solution')}
          </Button>
        ) : null}
      </div>
      {view?.hint ? (
        <div
          className="rounded-xl bg-review-soft px-3 py-2 text-sm text-foreground"
          data-testid="practice-hint-text"
        >
          <span className="mr-1 text-xs font-medium text-review-ink">
            {t('study.practice.help.hintLabel')}
          </span>
          <MathText text={view.hint} />
        </div>
      ) : null}
      {solution ? (
        <div
          className="space-y-1 rounded-xl bg-muted/60 px-3 py-2 text-sm text-foreground"
          data-testid="practice-solution-text"
        >
          <p className="text-xs font-medium text-muted-foreground">
            {t('study.practice.help.solutionLabel')}
          </p>
          {solution.answer.length ? (
            <p>{t('study.practice.report.key', { answer: solution.answer.join(', ') })}</p>
          ) : null}
          {solution.referenceAnswer ? (
            <div className="whitespace-pre-wrap">
              <MathText text={solution.referenceAnswer} allowDisplayMode />
            </div>
          ) : null}
          {solution.finalAnswer ? (
            <p>
              {t('study.practice.guide.final')}{' '}
              <MathText
                text={
                  solution.finalAnswer.includes('$')
                    ? solution.finalAnswer
                    : `$${solution.finalAnswer}$`
                }
              />
            </p>
          ) : null}
          {solution.explanation ? <MathText text={solution.explanation} allowDisplayMode /> : null}
          <p className="text-xs text-muted-foreground">{t('study.practice.help.recorded')}</p>
        </div>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('study.practice.help.solutionTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('study.practice.help.solutionConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('study.practice.help.keepTrying')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="practice-solution-confirm"
              onClick={() => {
                setConfirming(false);
                void show('solution');
              }}
            >
              {t('study.practice.help.solution')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Whether an answer was an independent check: new, right, no help. Shown on
 * the report and in the wrong-answer book. Nothing is shown for answers that
 * recorded neither novelty nor help (papers before B11).
 */
export function PracticeChips({
  novelty,
  level,
  correct,
  variant = false,
}: {
  novelty: 'new' | 'seen' | 'unknown' | null;
  level: AssistanceLevel;
  correct: boolean;
  variant?: boolean;
}) {
  const { t } = useI18n();
  const independent = correct && novelty === 'new' && level === 'unassisted';
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="practice-chips">
      {variant ? (
        <span className={cn(CHIP, 'border border-border text-muted-foreground')}>
          <Shuffle className="size-3" />
          {t('study.practice.help.chip.variant')}
        </span>
      ) : null}
      {independent ? (
        <span className={cn(CHIP, 'bg-correct-soft text-correct-ink')}>
          <BadgeCheck className="size-3" />
          {t('study.practice.help.chip.independent')}
        </span>
      ) : null}
      {level !== 'unassisted' ? (
        <span className={cn(CHIP, 'bg-review-soft text-review-ink')}>
          {level === 'hinted' ? <Lightbulb className="size-3" /> : <Eye className="size-3" />}
          {t(`study.practice.help.chip.${level}`)}
        </span>
      ) : null}
      {novelty === 'seen' ? (
        <span className={cn(CHIP, 'bg-muted text-muted-foreground')}>
          <Repeat2 className="size-3" />
          {t('study.practice.help.chip.seen')}
        </span>
      ) : null}
    </span>
  );
}
