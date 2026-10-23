'use client';

import { Reorder, motion, useDragControls } from 'motion/react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GripVertical,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { QuizQuestion, QuizQuestionType } from '@/lib/types/stage';
import { MAX_OPTIONS, isChoice, optionLetter } from './quiz-edit-ops';
import {
  addQuizOption,
  deleteQuizOption,
  deleteQuizQuestion,
  reorderQuizOptions,
  setQuizQuestionType,
  toggleQuizCorrect,
  typeQuizOptionLabel,
  typeQuizQuestion,
} from './use-quiz-surface';

const TYPES: QuizQuestionType[] = ['single', 'multiple', 'short_answer'];

/** Per-type accent: a quiz scene's question types read at a glance by colour. */
const TYPE_ACCENT: Record<QuizQuestionType, { badge: string; rail: string }> = {
  single: {
    badge: 'bg-primary-soft text-primary-ink',
    rail: 'from-primary to-primary',
  },
  multiple: {
    badge: 'bg-ai-soft text-ai-ink',
    rail: 'from-ai to-ai',
  },
  short_answer: {
    badge: 'bg-review-soft text-review-ink',
    rail: 'from-review to-review',
  },
};

/** ZHIYU focus treatment shared by every text input in the form. */
const FOCUS = 'focus-visible:border-primary/60 focus-visible:ring-primary/20';

/** Stop a pointer event from reaching the Reorder.Item drag listener. */
const stopDrag = (e: React.PointerEvent) => e.stopPropagation();

interface Props {
  readonly question: QuizQuestion;
  readonly index: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

export function QuestionCard({ question: q, index, expanded, onToggle }: Props) {
  const { t } = useI18n();
  const controls = useDragControls();
  const choice = isChoice(q.type);
  const accent = TYPE_ACCENT[q.type];

  return (
    <Reorder.Item
      value={q.id}
      data-testid="quiz-question"
      data-question-type={q.type}
      dragListener={false}
      dragControls={controls}
      layout="position"
      whileDrag={{ scale: 1.01, boxShadow: '0 18px 40px -12px rgba(24,24,27,0.25)', zIndex: 30 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        'group/card relative overflow-hidden rounded-2xl border bg-card transition-shadow',
        expanded
          ? 'border-primary/25 shadow-[0_12px_32px_-16px_color-mix(in_srgb,var(--primary)_24%,transparent)]'
          : 'border-border/80 hover:border-border-strong hover:shadow-[0_8px_24px_-16px_rgba(24,24,27,0.25)]',
      )}
    >
      {/* Left accent rail — colours the active question by its type. */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 w-1 bg-gradient-to-b transition-opacity',
          accent.rail,
          expanded ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* Header — caret + summary toggles expansion; grip drags; trash deletes. */}
      <div
        className={cn(
          'flex items-center gap-2 py-2 pr-2.5 pl-3 transition-colors',
          expanded && 'bg-secondary/55',
        )}
      >
        <button
          type="button"
          aria-label={t('edit.quiz.reorder')}
          onPointerDown={(e) => controls.start(e)}
          className="cursor-grab touch-none text-subtle-foreground opacity-0 transition-opacity group-hover/card:opacity-100 hover:text-muted-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          onPointerDown={stopDrag}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              expanded && 'rotate-90 text-primary',
            )}
          />
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-xs font-semibold text-muted-foreground">
            {index + 1}
          </span>
          <span
            className={cn(
              'shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
              accent.badge,
            )}
          >
            {t(`edit.quiz.type.${q.type}`)}
          </span>
          <span
            className={cn(
              'truncate text-sm',
              q.question ? 'font-medium text-foreground' : 'italic text-muted-foreground',
            )}
          >
            {q.question || t('edit.quiz.untitledQuestion')}
          </span>
        </button>
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground tabular-nums">
          {q.points ?? 1}
        </span>
        <button
          type="button"
          aria-label={t('edit.quiz.deleteQuestion')}
          onPointerDown={stopDrag}
          onClick={() => deleteQuizQuestion(q.id)}
          className="shrink-0 rounded-lg p-1.5 text-subtle-foreground transition-colors hover:bg-mistake-soft hover:text-mistake"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {expanded && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-4 border-t border-border px-4 pb-4 pt-3.5"
        >
          {/* Question text */}
          <Field label={t('edit.quiz.questionLabel')}>
            <Textarea
              value={q.question}
              onPointerDown={stopDrag}
              onChange={(e) =>
                typeQuizQuestion(q.id, { question: e.target.value }, `${q.id}:question`)
              }
              placeholder={t('edit.quiz.questionPlaceholder')}
              rows={2}
              className={cn('resize-none', FOCUS)}
            />
          </Field>

          {/* Type + points row */}
          <div className="flex gap-3">
            <Field label={t('edit.quiz.typeLabel')} className="flex-1">
              <Select
                value={q.type}
                onValueChange={(v) => setQuizQuestionType(q.id, v as QuizQuestionType)}
              >
                <SelectTrigger onPointerDown={stopDrag} className={cn('w-full', FOCUS)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`edit.quiz.type.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('edit.quiz.pointsLabel')} className="w-24">
              <Input
                type="number"
                min={0}
                value={q.points ?? 1}
                onPointerDown={stopDrag}
                onChange={(e) => {
                  const n = e.target.value === '' ? 0 : Number(e.target.value);
                  if (Number.isNaN(n)) return;
                  typeQuizQuestion(q.id, { points: n }, `${q.id}:points`);
                }}
                className={cn('font-mono tabular-nums', FOCUS)}
              />
            </Field>
          </div>

          {/* Options (choice questions only) */}
          {choice && (
            <Field label={t('edit.quiz.optionsLabel')}>
              <div className="flex flex-col gap-1.5">
                {(q.options ?? []).map((opt, i) => {
                  const correct = q.answer?.includes(opt.value) ?? false;
                  // `opt.value` is the positional letter (A/B/C…), so this key
                  // is positional, not identity-stable. That's intentional:
                  // QuizOption has no id, and reorder is driven by the up/down
                  // buttons (focus stays on the button), so React reconciling
                  // the label inputs by position is invisible in practice.
                  return (
                    <div
                      key={opt.value}
                      className={cn(
                        'group/opt flex items-center gap-2 rounded-xl border p-1 transition-colors',
                        correct
                          ? 'border-correct/30 bg-correct-soft/70'
                          : 'border-transparent hover:bg-muted',
                      )}
                    >
                      <button
                        type="button"
                        aria-label={t('edit.quiz.markCorrect')}
                        aria-pressed={correct}
                        onPointerDown={stopDrag}
                        onClick={() => toggleQuizCorrect(q.id, i)}
                        className={cn(
                          'relative flex h-8 w-8 shrink-0 items-center justify-center border font-mono text-xs font-bold transition-all',
                          q.type === 'single' ? 'rounded-full' : 'rounded-lg',
                          correct
                            ? 'border-correct/60 bg-correct text-primary-foreground shadow-sm shadow-correct/30'
                            : 'border-border-strong bg-card text-muted-foreground hover:border-correct/60 hover:text-correct',
                        )}
                      >
                        {correct ? <Check className="h-4 w-4" strokeWidth={3} /> : optionLetter(i)}
                      </button>
                      <Input
                        value={opt.label}
                        onPointerDown={stopDrag}
                        onChange={(e) => typeQuizOptionLabel(q.id, i, e.target.value)}
                        placeholder={t('edit.quiz.optionPlaceholder')}
                        className={cn(
                          'flex-1 border-transparent bg-transparent shadow-none',
                          FOCUS,
                        )}
                      />
                      <div className="flex shrink-0 items-center opacity-60 transition-opacity group-hover/opt:opacity-100">
                        <IconButton
                          label={t('edit.quiz.moveUp')}
                          disabled={i === 0}
                          onClick={() => reorderQuizOptions(q.id, i, i - 1)}
                        >
                          <ChevronUp className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          label={t('edit.quiz.moveDown')}
                          disabled={i === (q.options?.length ?? 0) - 1}
                          onClick={() => reorderQuizOptions(q.id, i, i + 1)}
                        >
                          <ChevronDown className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          label={t('edit.quiz.deleteOption')}
                          disabled={(q.options?.length ?? 0) <= 1}
                          onClick={() => deleteQuizOption(q.id, i)}
                          danger
                        >
                          <X className="h-4 w-4" />
                        </IconButton>
                      </div>
                    </div>
                  );
                })}
                <button
                  type="button"
                  disabled={(q.options?.length ?? 0) >= MAX_OPTIONS}
                  onPointerDown={stopDrag}
                  onClick={() => addQuizOption(q.id)}
                  className="mt-0.5 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-secondary hover:text-primary disabled:pointer-events-none disabled:opacity-40"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('edit.quiz.addOption')}
                </button>
              </div>
            </Field>
          )}

          {/* Short-answer grading fields. Short answers are always AI-graded
              from the guidance below (see lib/quiz/grading.ts isShortAnswer),
              so there is no auto-grade toggle — an info note explains the
              scoring model instead. */}
          {!choice && (
            <>
              <div className="flex items-start gap-2.5 rounded-xl border border-primary/20 bg-secondary/55 px-3 py-2.5 text-xs leading-relaxed text-primary">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
                <span>{t('edit.quiz.shortAnswerGradingNote')}</span>
              </div>
              <Field label={t('edit.quiz.commentPromptLabel')}>
                <Textarea
                  value={q.commentPrompt ?? ''}
                  onPointerDown={stopDrag}
                  onChange={(e) =>
                    typeQuizQuestion(
                      q.id,
                      { commentPrompt: e.target.value },
                      `${q.id}:commentPrompt`,
                    )
                  }
                  placeholder={t('edit.quiz.commentPromptPlaceholder')}
                  rows={2}
                  className={cn('resize-none', FOCUS)}
                />
              </Field>
            </>
          )}

          {/* Analysis (all types) */}
          <Field label={t('edit.quiz.analysisLabel')}>
            <Textarea
              value={q.analysis ?? ''}
              onPointerDown={stopDrag}
              onChange={(e) =>
                typeQuizQuestion(q.id, { analysis: e.target.value }, `${q.id}:analysis`)
              }
              placeholder={t('edit.quiz.analysisPlaceholder')}
              rows={2}
              className={cn('resize-none', FOCUS)}
            />
          </Field>
        </motion.div>
      )}
    </Reorder.Item>
  );
}

function Field({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  danger,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onPointerDown={stopDrag}
      onClick={onClick}
      className={cn(
        'rounded-lg p-1 text-muted-foreground transition-colors disabled:pointer-events-none disabled:opacity-30',
        danger
          ? 'hover:bg-mistake-soft hover:text-mistake'
          : 'hover:bg-muted hover:text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}
