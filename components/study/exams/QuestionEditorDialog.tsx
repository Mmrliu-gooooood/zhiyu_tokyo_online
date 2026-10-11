'use client';

/**
 * Write or correct one objective question (learning plan B07): stem, 2–8
 * options, the answer key, explanation, knowledge points, difficulty, points,
 * the course it belongs to and whether the student checked the answer. The
 * same validation as the server runs as the student types; a question without
 * an answer can be saved as a draft but is never marked checked.
 */
import { useMemo, useState } from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useIssueText, MathText } from '@/components/study/exams/exam-format';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  QUESTION_LIMITS,
  blockingIssues,
  parseQuestion,
  type QuestionContent,
  type QuestionType,
} from '@/lib/study/questions/contracts';
import { cn } from '@/lib/utils';

const LETTERS = 'ABCDEFGH';
const NONE = '__none__';

export interface EditorCourse {
  stageId: string;
  name: string;
}

export interface EditorValue {
  content: QuestionContent;
  verified: boolean;
  stageId: string | null;
}

interface FormState {
  type: QuestionType;
  stem: string;
  options: string[];
  answer: Set<number>;
  explanation: string;
  concepts: string;
  difficulty: string;
  points: string;
  verified: boolean;
  stageId: string;
}

function toForm(value: EditorValue | null): FormState {
  const content = value?.content;
  return {
    type: content?.type ?? 'single',
    stem: content?.stem ?? '',
    options: content?.options.map((option) => option.label) ?? ['', '', '', ''],
    answer: new Set(
      (content?.answer ?? []).flatMap((key) => {
        const index = content?.options.findIndex((option) => option.value === key) ?? -1;
        return index >= 0 ? [index] : [];
      }),
    ),
    explanation: content?.explanation ?? '',
    concepts: content?.concepts.join('、') ?? '',
    difficulty: content?.difficulty ? String(content.difficulty) : NONE,
    points: String(content?.points ?? 1),
    verified: value?.verified ?? true,
    stageId: value?.stageId ?? NONE,
  };
}

function toContent(form: FormState, source: QuestionContent['source']) {
  return parseQuestion({
    type: form.type,
    stem: form.stem,
    options: form.options.map((label, index) => ({ value: LETTERS[index], label })),
    answer: [...form.answer].sort((a, b) => a - b).map((index) => LETTERS[index]),
    explanation: form.explanation,
    concepts: form.concepts
      .split(/[,，、;；\n]/)
      .map((name) => name.trim())
      .filter(Boolean),
    difficulty: form.difficulty === NONE ? null : Number(form.difficulty),
    points: Number(form.points),
    ...(source ? { source } : {}),
  });
}

export function QuestionEditorDialog({
  open,
  onOpenChange,
  title,
  initial,
  courses,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** null: a new question. */
  initial: EditorValue | null;
  courses: EditorCourse[];
  /** Throws an Error with a message to show. */
  onSave: (value: EditorValue) => Promise<void>;
}) {
  const { t } = useI18n();
  const issueText = useIssueText();
  const [form, setForm] = useState<FormState>(() => toForm(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => toContent(form, initial?.content.source ?? null), [form, initial]);
  const errors = blockingIssues(parsed.issues);
  const draft = errors.length === 0 && parsed.content?.answer.length === 0;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  function toggleAnswer(index: number) {
    setForm((current) => {
      const answer = new Set(current.type === 'single' ? [] : current.answer);
      if (current.answer.has(index) && current.type === 'multiple') answer.delete(index);
      else answer.add(index);
      return { ...current, answer };
    });
  }

  function removeOption(index: number) {
    setForm((current) => ({
      ...current,
      options: current.options.filter((_, position) => position !== index),
      answer: new Set(
        [...current.answer]
          .filter((position) => position !== index)
          .map((position) => (position > index ? position - 1 : position)),
      ),
    }));
  }

  async function save() {
    if (!parsed.content || errors.length) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        content: parsed.content,
        verified: form.verified && !draft,
        stageId: form.stageId === NONE ? null : form.stageId,
      });
      onOpenChange(false);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message ? failure.message : t('study.errors.generic'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        data-testid="question-editor"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('study.practice.editor.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>{t('study.practice.editor.type')}</Label>
              <Select
                value={form.type}
                onValueChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    type: value as QuestionType,
                    answer:
                      value === 'single'
                        ? new Set([...current.answer].slice(0, 1))
                        : current.answer,
                  }))
                }
              >
                <SelectTrigger className="w-full" data-testid="question-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">{t('study.practice.type.single')}</SelectItem>
                  <SelectItem value="multiple">{t('study.practice.type.multiple')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('study.practice.editor.difficulty')}</Label>
              <Select value={form.difficulty} onValueChange={(value) => set('difficulty', value)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('study.practice.difficulty.unknown')}</SelectItem>
                  {[1, 2, 3, 4, 5].map((level) => (
                    <SelectItem key={level} value={String(level)}>
                      {t(`study.practice.difficulty.level${level}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="question-points">{t('study.practice.editor.points')}</Label>
              <Input
                id="question-points"
                type="number"
                min={QUESTION_LIMITS.minPoints}
                max={QUESTION_LIMITS.maxPoints}
                value={form.points}
                onChange={(event) => set('points', event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="question-stem">{t('study.practice.editor.stem')}</Label>
            <Textarea
              id="question-stem"
              data-testid="question-stem"
              rows={3}
              maxLength={QUESTION_LIMITS.stem}
              value={form.stem}
              placeholder={t('study.practice.editor.stemPlaceholder')}
              onChange={(event) => set('stem', event.target.value)}
            />
            {form.stem.includes('$') ? (
              <p className="rounded-md bg-muted/60 px-3 py-2 text-sm">
                <MathText text={form.stem} allowDisplayMode />
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label>{t('study.practice.editor.options')}</Label>
            <p className="text-xs text-muted-foreground">
              {form.type === 'single'
                ? t('study.practice.editor.pickOne')
                : t('study.practice.editor.pickMany')}
            </p>
            {form.options.map((label, index) => (
              <div key={index} className="flex items-center gap-2">
                <button
                  type="button"
                  aria-pressed={form.answer.has(index)}
                  aria-label={t('study.practice.editor.markCorrect', { letter: LETTERS[index] })}
                  data-testid={`question-answer-${LETTERS[index]}`}
                  onClick={() => toggleAnswer(index)}
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors',
                    form.answer.has(index)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:border-primary/60',
                  )}
                >
                  {LETTERS[index]}
                </button>
                <Input
                  value={label}
                  maxLength={QUESTION_LIMITS.optionLabel}
                  data-testid={`question-option-${LETTERS[index]}`}
                  placeholder={t('study.practice.editor.optionPlaceholder', {
                    letter: LETTERS[index],
                  })}
                  onChange={(event) =>
                    set(
                      'options',
                      form.options.map((value, position) =>
                        position === index ? event.target.value : value,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={form.options.length <= QUESTION_LIMITS.minOptions}
                  aria-label={t('study.practice.editor.removeOption')}
                  onClick={() => removeOption(index)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            {form.options.length < QUESTION_LIMITS.maxOptions ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => set('options', [...form.options, ''])}
              >
                <Plus className="mr-1 size-4" />
                {t('study.practice.editor.addOption')}
              </Button>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="question-explanation">{t('study.practice.editor.explanation')}</Label>
            <Textarea
              id="question-explanation"
              rows={2}
              maxLength={QUESTION_LIMITS.explanation}
              value={form.explanation}
              onChange={(event) => set('explanation', event.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="question-concepts">{t('study.practice.editor.concepts')}</Label>
              <Input
                id="question-concepts"
                value={form.concepts}
                placeholder={t('study.practice.editor.conceptsPlaceholder')}
                onChange={(event) => set('concepts', event.target.value)}
              />
            </div>
            {courses.length ? (
              <div className="space-y-1.5">
                <Label>{t('study.practice.editor.course')}</Label>
                <Select value={form.stageId} onValueChange={(value) => set('stageId', value)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('study.practice.editor.noCourse')}</SelectItem>
                    {courses.map((course) => (
                      <SelectItem key={course.stageId} value={course.stageId}>
                        {course.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={form.verified && !draft}
              disabled={draft}
              onCheckedChange={(checked) => set('verified', checked === true)}
              data-testid="question-verified"
            />
            <span>
              {t('study.practice.editor.verified')}
              <span className="block text-xs text-muted-foreground">
                {draft
                  ? t('study.practice.editor.draftHint')
                  : t('study.practice.editor.verifiedHint')}
              </span>
            </span>
          </label>

          {errors.length ? (
            <ul className="space-y-1 rounded-md bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {errors.map((issue) => (
                <li key={`${issue.path}-${issue.code}`}>{issueText(issue)}</li>
              ))}
            </ul>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={saving || errors.length > 0}
            onClick={() => void save()}
            data-testid="question-save"
          >
            {saving ? <LoaderCircle className="mr-1.5 size-4 animate-spin" /> : null}
            {draft ? t('study.practice.editor.saveDraft') : t('study.practice.editor.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
