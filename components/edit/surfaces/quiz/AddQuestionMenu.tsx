'use client';

import { CircleDot, ListChecks, PencilLine, type LucideIcon } from 'lucide-react';
import { PopoverClose } from '@/components/ui/popover';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { QuizQuestionType } from '@/lib/types/stage';
import { addQuizQuestion } from './use-quiz-surface';

const TYPES: { type: QuizQuestionType; labelKey: string; Icon: LucideIcon; tint: string }[] = [
  {
    type: 'single',
    labelKey: 'edit.quiz.type.single',
    Icon: CircleDot,
    tint: 'bg-primary-soft text-primary-ink',
  },
  {
    type: 'multiple',
    labelKey: 'edit.quiz.type.multiple',
    Icon: ListChecks,
    tint: 'bg-ai-soft text-ai-ink',
  },
  {
    type: 'short_answer',
    labelKey: 'edit.quiz.type.short_answer',
    Icon: PencilLine,
    tint: 'bg-review-soft text-review-ink',
  },
];

/**
 * Popover body for the inline "Add question" button — a small menu of the
 * three question types, each with its accent colour. Each entry appends a blank
 * question of that type (one undo step) and closes the popover via Radix's
 * PopoverClose.
 */
export function AddQuestionMenu() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t('edit.quiz.addQuestion')}
      </p>
      {TYPES.map(({ type, labelKey, Icon, tint }) => (
        <PopoverClose asChild key={type}>
          <button
            type="button"
            onClick={() => addQuizQuestion(type)}
            className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tint}`}
            >
              <Icon className="h-4 w-4" strokeWidth={2} />
            </span>
            <span>{t(labelKey)}</span>
          </button>
        </PopoverClose>
      ))}
    </div>
  );
}
