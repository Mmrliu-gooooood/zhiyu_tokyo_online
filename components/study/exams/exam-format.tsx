'use client';

/**
 * Small shared pieces of the question bank and paper pages (learning plan
 * B07): type, origin and verification chips, and readable issue messages.
 */
import type { ComponentProps } from 'react';
import { BadgeCheck, CircleDashed, ShieldCheck } from 'lucide-react';

import { QuizMathText } from '@/components/quiz/QuizMathText';

import { useI18n } from '@/lib/hooks/use-i18n';
import type {
  QuestionIssue,
  QuestionOrigin,
  QuestionType,
  VerificationState,
} from '@/lib/study/questions/contracts';
import { cn } from '@/lib/utils';

/**
 * Question-bank text: authors are told `$…$` is a formula, so every such span
 * renders (unlike model-written classroom quizzes, where `$` may be money).
 */
export function MathText(props: Omit<ComponentProps<typeof QuizMathText>, 'trustDelimiters'>) {
  return <QuizMathText {...props} trustDelimiters />;
}

const CHIP = 'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px]';

export function TypeChip({ type }: { type: QuestionType }) {
  const { t } = useI18n();
  return (
    <span className={cn(CHIP, 'bg-muted text-muted-foreground')}>
      {t(`study.practice.type.${type}`)}
    </span>
  );
}

export function OriginChip({ origin }: { origin: QuestionOrigin }) {
  const { t } = useI18n();
  return (
    <span className={cn(CHIP, 'border border-border text-muted-foreground')}>
      {t(`study.practice.origin.${origin}`)}
    </span>
  );
}

export function VerificationChip({ state }: { state: VerificationState }) {
  const { t } = useI18n();
  if (state === 'unverified') {
    return (
      <span className={cn(CHIP, 'bg-amber-500/10 text-amber-700 dark:text-amber-400')}>
        <CircleDashed className="size-3" />
        {t('study.practice.verification.unverified')}
      </span>
    );
  }
  const Icon = state === 'official_verified' ? ShieldCheck : BadgeCheck;
  return (
    <span className={cn(CHIP, 'bg-primary/10 text-primary')}>
      <Icon className="size-3" />
      {t(`study.practice.verification.${state}`)}
    </span>
  );
}

/** "选项 3：选项内容为空" — the path made readable, then the problem. */
export function useIssueText() {
  const { t } = useI18n();
  return (issue: QuestionIssue): string => {
    const option = /^options\[(\d+)\]/.exec(issue.path);
    const where = option
      ? t('study.practice.issue.atOption', { n: Number(option[1]) + 1 })
      : issue.path
        ? t(`study.practice.issue.field.${issue.path.split('.')[0]}`)
        : '';
    const what = t(`study.practice.issue.${issue.code}`);
    return where ? t('study.practice.issue.located', { where, what }) : what;
  };
}

export function newRequestKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
