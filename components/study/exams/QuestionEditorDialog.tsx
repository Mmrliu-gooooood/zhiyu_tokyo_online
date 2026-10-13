'use client';

/**
 * Write or correct one question (learning plan B07): stem, 2–8 options, the
 * answer key, explanation, knowledge points, difficulty, points, the course
 * it belongs to and whether the student checked the answer. The same
 * validation as the server runs as the student types; a question without an
 * answer can be saved as a draft but is never marked checked.
 *
 * Open questions (B09) — short answer, calculation, proof — take a reference
 * answer, a calculation's final answer and optional scoring points instead
 * of options; without any of them the question is a draft for self-checking.
 */
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
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
  hasAnswerKey,
  parseQuestion,
  type OpenSubtype,
  type QuestionContent,
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

/** The type menu: the two choice types and the three kinds of open question. */
type FormType = 'single' | 'multiple' | OpenSubtype;

const OPEN_FORM_TYPES: readonly FormType[] = ['short', 'calculation', 'proof'];

function isOpenForm(type: FormType): type is OpenSubtype {
  return OPEN_FORM_TYPES.includes(type);
}

interface RubricRow {
  text: string;
  points: string;
}

interface FormState {
  type: FormType;
  stem: string;
  options: string[];
  answer: Set<number>;
  referenceAnswer: string;
  finalAnswer: string;
  /** Points of the final answer when there are also written scoring points. */
  finalPoints: string;
  rubric: RubricRow[];
  explanation: string;
  concepts: string;
  difficulty: string;
  points: string;
  verified: boolean;
  stageId: string;
}

function toForm(value: EditorValue | null): FormState {
  const content = value?.content;
  const open = content?.type === 'short_answer';
  const guide = content?.guide;
  const finalCriterion = guide?.rubric.find((criterion) => criterion.final);
  return {
    type: open ? (content?.subtype ?? 'short') : ((content?.type ?? 'single') as FormType),
    stem: content?.stem ?? '',
    options:
      open || !content
        ? ['', '', '', '']
        : content.options.length
          ? content.options.map((option) => option.label)
          : ['', '', '', ''],
    referenceAnswer: guide?.referenceAnswer ?? '',
    finalAnswer: guide?.finalAnswer ?? '',
    finalPoints: finalCriterion ? String(finalCriterion.points) : '',
    rubric:
      guide?.rubric
        .filter((criterion) => !criterion.final)
        .map((criterion) => ({ text: criterion.text, points: String(criterion.points) })) ?? [],
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

function openGuide(form: FormState) {
  const finalAnswer = form.type === 'calculation' ? form.finalAnswer.trim() : '';
  const rows = form.rubric.filter((row) => row.text.trim() || row.points.trim());
  const rubric: Array<Record<string, unknown>> = rows.map((row, index) => ({
    id: `c${index + 1}`,
    text: row.text,
    points: row.points.trim() === '' ? Number.NaN : Number(row.points),
  }));
  // With written points, the final answer is one more point of its own.
  if (finalAnswer && rubric.length) {
    rubric.push({
      id: 'final',
      text: '',
      points: form.finalPoints.trim() === '' ? Number.NaN : Number(form.finalPoints),
      final: true,
    });
  }
  return { referenceAnswer: form.referenceAnswer, finalAnswer: finalAnswer || null, rubric };
}

function toContent(form: FormState, source: QuestionContent['source']) {
  const openType = isOpenForm(form.type);
  return parseQuestion({
    type: openType ? 'short_answer' : form.type,
    ...(openType ? { subtype: form.type, guide: openGuide(form) } : {}),
    stem: form.stem,
    options: openType ? [] : form.options.map((label, index) => ({ value: LETTERS[index], label })),
    answer: openType ? [] : [...form.answer].sort((a, b) => a - b).map((index) => LETTERS[index]),
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
  const draft = errors.length === 0 && !!parsed.content && !hasAnswerKey(parsed.content);
  const openType = isOpenForm(form.type);

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
                    type: value as FormType,
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
                  {OPEN_FORM_TYPES.map((subtype) => (
                    <SelectItem key={subtype} value={subtype}>
                      {t(`study.practice.subtype.${subtype}`)}
                    </SelectItem>
                  ))}
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

          {openType ? (
            <OpenFields form={form} setForm={setForm} />
          ) : (
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
          )}

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
                  ? openType
                    ? t('study.practice.editor.openDraftHint')
                    : t('study.practice.editor.draftHint')
                  : openType
                    ? t('study.practice.editor.openVerifiedHint')
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

/** Reference answer, a calculation's final answer and the scoring points of an open question. */
function OpenFields({
  form,
  setForm,
}: {
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
}) {
  const { t } = useI18n();
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const setRow = (index: number, row: Partial<RubricRow>) =>
    setForm((current) => ({
      ...current,
      rubric: current.rubric.map((entry, position) =>
        position === index ? { ...entry, ...row } : entry,
      ),
    }));
  const calculation = form.type === 'calculation';
  return (
    <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-3">
      <div className="space-y-1.5">
        <Label htmlFor="question-reference">{t('study.practice.editor.referenceAnswer')}</Label>
        <Textarea
          id="question-reference"
          data-testid="question-reference"
          rows={4}
          maxLength={QUESTION_LIMITS.referenceAnswer}
          value={form.referenceAnswer}
          placeholder={t('study.practice.editor.referencePlaceholder')}
          onChange={(event) => set('referenceAnswer', event.target.value)}
        />
        {form.referenceAnswer.includes('$') ? (
          <p className="rounded-md bg-muted/60 px-3 py-2 text-sm">
            <MathText text={form.referenceAnswer} allowDisplayMode />
          </p>
        ) : null}
      </div>
      {calculation ? (
        <div className="space-y-1.5">
          <Label htmlFor="question-final">{t('study.practice.editor.finalAnswer')}</Label>
          <Input
            id="question-final"
            data-testid="question-final"
            maxLength={QUESTION_LIMITS.finalAnswer}
            value={form.finalAnswer}
            placeholder={t('study.practice.editor.finalPlaceholder')}
            onChange={(event) => set('finalAnswer', event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('study.practice.editor.finalHint')}</p>
        </div>
      ) : null}
      <div className="space-y-2">
        <Label>{t('study.practice.editor.rubric')}</Label>
        <p className="text-xs text-muted-foreground">{t('study.practice.editor.rubricHint')}</p>
        {form.rubric.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={row.text}
              maxLength={QUESTION_LIMITS.criterionText}
              data-testid={`question-rubric-text-${index}`}
              placeholder={t('study.practice.editor.rubricPlaceholder', { n: index + 1 })}
              onChange={(event) => setRow(index, { text: event.target.value })}
            />
            <Input
              type="number"
              className="w-20"
              min={1}
              max={QUESTION_LIMITS.maxPoints}
              value={row.points}
              data-testid={`question-rubric-points-${index}`}
              aria-label={t('study.practice.editor.rubricPoints')}
              onChange={(event) => setRow(index, { points: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('study.practice.editor.removeRubric')}
              onClick={() =>
                set(
                  'rubric',
                  form.rubric.filter((_, position) => position !== index),
                )
              }
            >
              <X className="size-4" />
            </Button>
          </div>
        ))}
        {calculation && form.finalAnswer.trim() && form.rubric.length ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-sm text-foreground">
              {t('study.practice.editor.finalPoints')}
            </span>
            <Input
              type="number"
              className="w-20"
              min={1}
              max={QUESTION_LIMITS.maxPoints}
              value={form.finalPoints}
              data-testid="question-final-points"
              aria-label={t('study.practice.editor.rubricPoints')}
              onChange={(event) => set('finalPoints', event.target.value)}
            />
            <span className="w-9" />
          </div>
        ) : null}
        {form.rubric.length < QUESTION_LIMITS.rubricCriteria ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="question-rubric-add"
            onClick={() => set('rubric', [...form.rubric, { text: '', points: '1' }])}
          >
            <Plus className="mr-1 size-4" />
            {t('study.practice.editor.addRubric')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
