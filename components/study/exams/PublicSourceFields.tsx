'use client';

/**
 * "These questions come from a public resource" (learning plan B08): the
 * link the student took them from, when, the resource's own version or
 * edition, its licence and the attribution it asks for. When the student is
 * not sure the licence allows it, the questions stay marked "licence to be
 * confirmed" — being publicly reachable does not make them free to reuse.
 */
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/hooks/use-i18n';
import { QUESTION_LIMITS, type QuestionSource } from '@/lib/study/questions/contracts';

export interface PublicSourceForm {
  title: string;
  url: string;
  retrievedAt: string;
  version: string;
  license: string;
  attribution: string;
  licenseClear: boolean;
}

const EMPTY: PublicSourceForm = {
  title: '',
  url: '',
  retrievedAt: '',
  version: '',
  license: '',
  attribution: '',
  licenseClear: false,
};

/** The details sent with the import (blank fields left out). */
export function publicSourceDetails(form: PublicSourceForm): QuestionSource {
  const source: QuestionSource = { licenseStatus: form.licenseClear ? 'clear' : 'unclear' };
  for (const key of ['title', 'url', 'retrievedAt', 'version', 'license', 'attribution'] as const) {
    const value = form[key].trim();
    if (value) source[key] = value;
  }
  return source;
}

export function publicSourceValid(form: PublicSourceForm | null): boolean {
  if (!form) return true;
  const url = form.url.trim();
  return !url || (/^https?:\/\//i.test(url) && url.length <= QUESTION_LIMITS.sourceUrl);
}

export function PublicSourceFields({
  value,
  onChange,
}: {
  value: PublicSourceForm | null;
  onChange: (value: PublicSourceForm | null) => void;
}) {
  const { t } = useI18n();
  const set = (key: keyof PublicSourceForm, next: string | boolean) =>
    value && onChange({ ...value, [key]: next });
  return (
    <div className="space-y-3 rounded-xl border border-border p-3">
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={value !== null}
          onCheckedChange={(checked) => onChange(checked === true ? { ...EMPTY } : null)}
          data-testid="import-public-source"
        />
        <span>
          {t('study.practice.publicSource.toggle')}
          <span className="block text-xs text-muted-foreground">
            {t('study.practice.publicSource.hint')}
          </span>
        </span>
      </label>
      {value ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('study.practice.publicSource.title')}>
            <Input
              value={value.title}
              maxLength={QUESTION_LIMITS.sourceText}
              onChange={(event) => set('title', event.target.value)}
            />
          </Field>
          <Field label={t('study.practice.publicSource.url')}>
            <Input
              value={value.url}
              maxLength={QUESTION_LIMITS.sourceUrl}
              placeholder="https://"
              onChange={(event) => set('url', event.target.value)}
              data-testid="import-public-url"
            />
          </Field>
          <Field label={t('study.practice.publicSource.retrievedAt')}>
            <Input
              type="date"
              value={value.retrievedAt}
              onChange={(event) => set('retrievedAt', event.target.value)}
            />
          </Field>
          <Field label={t('study.practice.publicSource.version')}>
            <Input
              value={value.version}
              maxLength={QUESTION_LIMITS.sourceText}
              onChange={(event) => set('version', event.target.value)}
            />
          </Field>
          <Field label={t('study.practice.publicSource.license')}>
            <Input
              value={value.license}
              maxLength={QUESTION_LIMITS.sourceText}
              placeholder="CC BY 4.0"
              onChange={(event) => set('license', event.target.value)}
            />
          </Field>
          <Field label={t('study.practice.publicSource.attribution')}>
            <Input
              value={value.attribution}
              maxLength={QUESTION_LIMITS.sourceText}
              onChange={(event) => set('attribution', event.target.value)}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <Checkbox
              checked={value.licenseClear}
              onCheckedChange={(checked) => set('licenseClear', checked === true)}
            />
            <span>
              {t('study.practice.publicSource.licenseClear')}
              <span className="block text-xs text-muted-foreground">
                {t('study.practice.publicSource.licenseHint')}
              </span>
            </span>
          </label>
          {!publicSourceValid(value) ? (
            <p className="text-xs text-destructive sm:col-span-2">
              {t('study.practice.issue.source_invalid')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
