'use client';

import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
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
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  EDUCATION_LEVELS,
  STUDY_SPACE_LIMITS,
  parseStudySpaceInput,
  type EducationLevel,
  type StudySpaceInput,
  type StudySpaceSummary,
} from '@/lib/study/spaces/contracts';

const NO_LEVEL = 'none';

interface FormValues {
  name: string;
  educationLevel: EducationLevel | typeof NO_LEVEL;
  subject: string;
  examDate: string;
  goal: string;
  examScope: string;
}

function valuesFrom(space?: StudySpaceSummary | null): FormValues {
  return {
    name: space?.name ?? '',
    educationLevel: space?.educationLevel ?? NO_LEVEL,
    subject: space?.subject ?? '',
    examDate: space?.examDate ?? '',
    goal: space?.goal ?? '',
    examScope: space?.examScope ?? '',
  };
}

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function StudySpaceFormDialog({
  open,
  onOpenChange,
  space,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing. */
  space?: StudySpaceSummary | null;
  /**
   * Resolves when saved; a rejection keeps the dialog open with its message
   * and the learner's input. `changed` holds only the fields the learner
   * edited since the dialog opened, so an edit never re-sends values another
   * tab may have changed meanwhile.
   */
  onSubmit: (input: StudySpaceInput, changed: Partial<StudySpaceInput>) => Promise<void>;
}) {
  const { t } = useI18n();
  // Mounted while open: the form starts from the space as it was when opened.
  const [initial] = useState<FormValues>(() => valuesFrom(space));
  const [values, setValues] = useState<FormValues>(initial);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = parseStudySpaceInput({
      ...values,
      educationLevel: values.educationLevel === NO_LEVEL ? null : values.educationLevel,
      timezone: space?.timezone ?? browserTimeZone(),
    });
    if (!parsed.ok) {
      setError(
        t(
          `study.form.invalid.${parsed.field === 'name' ? 'name' : parsed.field === 'examDate' ? 'examDate' : 'other'}`,
        ),
      );
      return;
    }
    const before = parseStudySpaceInput({
      ...initial,
      educationLevel: initial.educationLevel === NO_LEVEL ? null : initial.educationLevel,
      timezone: space?.timezone ?? browserTimeZone(),
    });
    const changed = Object.fromEntries(
      Object.entries(parsed.value).filter(
        ([key, value]) => !before.ok || before.value[key as keyof StudySpaceInput] !== value,
      ),
    ) as Partial<StudySpaceInput>;
    setSaving(true);
    setError('');
    try {
      await onSubmit(parsed.value, changed);
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4" data-testid="study-space-form">
          <DialogHeader>
            <DialogTitle>
              {space ? t('study.form.editTitle') : t('study.form.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('study.form.description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="study-space-name">{t('study.form.name')}</Label>
            <Input
              id="study-space-name"
              value={values.name}
              maxLength={STUDY_SPACE_LIMITS.name}
              placeholder={t('study.form.namePlaceholder')}
              onChange={(event) => set('name', event.target.value)}
              autoFocus
              required
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="study-space-level">{t('study.form.educationLevel')}</Label>
              <Select
                value={values.educationLevel}
                onValueChange={(value) =>
                  set('educationLevel', value as FormValues['educationLevel'])
                }
              >
                <SelectTrigger id="study-space-level" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_LEVEL}>{t('study.level.none')}</SelectItem>
                  {EDUCATION_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {t(`study.level.${level}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="study-space-subject">{t('study.form.subject')}</Label>
              <Input
                id="study-space-subject"
                value={values.subject}
                maxLength={STUDY_SPACE_LIMITS.subject}
                placeholder={t('study.form.subjectPlaceholder')}
                onChange={(event) => set('subject', event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="study-space-exam-date">{t('study.form.examDate')}</Label>
            <Input
              id="study-space-exam-date"
              type="date"
              value={values.examDate}
              min="2000-01-01"
              max="2100-12-31"
              onChange={(event) => set('examDate', event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="study-space-goal">{t('study.form.goal')}</Label>
            <Textarea
              id="study-space-goal"
              value={values.goal}
              maxLength={STUDY_SPACE_LIMITS.goal}
              placeholder={t('study.form.goalPlaceholder')}
              onChange={(event) => set('goal', event.target.value)}
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="study-space-scope">{t('study.form.examScope')}</Label>
            <Textarea
              id="study-space-scope"
              value={values.examScope}
              maxLength={STUDY_SPACE_LIMITS.examScope}
              placeholder={t('study.form.examScopePlaceholder')}
              onChange={(event) => set('examScope', event.target.value)}
              rows={3}
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <LoaderCircle className="mr-1.5 size-4 animate-spin" /> : null}
              {space ? t('study.form.save') : t('study.form.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
