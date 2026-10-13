'use client';

/**
 * Small shared pieces of the question bank and paper pages (learning plan
 * B07): type, origin and verification chips, readable issue messages, and
 * (B08) the source line and figures of extracted or public-source questions.
 */
import { useState, type ComponentProps } from 'react';
import Link from 'next/link';
import { BadgeCheck, CircleDashed, FileText, ShieldCheck } from 'lucide-react';

import { QuizMathText } from '@/components/quiz/QuizMathText';

import { useI18n } from '@/lib/hooks/use-i18n';
import { materialsApi, readerHref } from '@/lib/study/materials/client';
import type {
  GradingGuide,
  MaterialSourceRef,
  OpenSubtype,
  QuestionFigure,
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

/** The question type; open questions show their kind (short answer, calculation, proof). */
export function TypeChip({ type, subtype }: { type: QuestionType; subtype?: OpenSubtype }) {
  const { t } = useI18n();
  return (
    <span className={cn(CHIP, 'bg-muted text-muted-foreground')}>
      {type === 'short_answer'
        ? t(`study.practice.subtype.${subtype ?? 'short'}`)
        : t(`study.practice.type.${type}`)}
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

/** Where a question came from, as stored on it or frozen into a paper. */
export interface SourceDetailsValue {
  title?: string;
  packTitle?: string;
  page?: string;
  url?: string;
  license?: string;
  attribution?: string;
  retrievedAt?: string;
  version?: string;
  licenseStatus?: 'clear' | 'unclear';
  answerBasis?: 'source' | 'model';
  material?: MaterialSourceRef;
}

/**
 * The source line under a question: title and printed page, the material
 * version and file page it was extracted from (with a link to the original
 * page), the public source's link, date and version, its licence, and where
 * the answer came from when the student did not write it.
 */
export function SourceDetails({ source }: { source: SourceDetailsValue | null | undefined }) {
  const { t } = useI18n();
  if (!source) return null;
  const material = source.material;
  const text = [
    source.packTitle ?? source.title,
    material ? t('study.practice.source.version', { n: material.versionNo }) : null,
    material?.pages.length
      ? t('study.practice.source.pages', { pages: material.pages.join('–') })
      : null,
    material?.label ? t('study.practice.source.number', { label: material.label }) : null,
    source.page,
    source.version ? t('study.practice.source.edition', { version: source.version }) : null,
    source.retrievedAt
      ? t('study.practice.source.retrievedAt', { date: source.retrievedAt })
      : null,
    source.attribution,
    source.license,
  ]
    .filter(Boolean)
    .join(' · ');
  const chips = [
    source.answerBasis ? t(`study.practice.source.answerBasis.${source.answerBasis}`) : null,
    source.licenseStatus === 'unclear' ? t('study.practice.source.licenseUnclear') : null,
  ].filter(Boolean);
  if (!text && chips.length === 0 && !source.url) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {text ? <span>{text}</span> : null}
      {material ? (
        <Link
          href={readerHref(material.materialId, material.versionId, material.pages[0] ?? null)}
          className="inline-flex items-center gap-0.5 text-primary hover:underline"
        >
          <FileText className="size-3" />
          {t('study.practice.source.openOriginal')}
        </Link>
      ) : null}
      {source.url ? (
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer noopener"
          className="max-w-full truncate text-primary hover:underline"
        >
          {source.url}
        </a>
      ) : null}
      {chips.map((chip) => (
        <span key={chip} className={cn(CHIP, 'bg-amber-500/10 text-amber-700 dark:text-amber-400')}>
          {chip}
        </span>
      ))}
    </p>
  );
}

/** A scoring point's label: its text, or what the server-made points stand for. */
export function useCriterionLabel() {
  const { t } = useI18n();
  return (criterion: { id: string; text?: string; final?: boolean }): string =>
    criterion.text ||
    (criterion.final || criterion.id === 'final'
      ? t('study.practice.guide.finalCriterion')
      : t('study.practice.guide.overallCriterion'));
}

/** What an open question is graded against: reference answer, final answer, scoring points. */
export function GuideDetails({
  guide,
  points,
}: {
  guide: GradingGuide | null | undefined;
  points: number;
}) {
  const { t } = useI18n();
  const label = useCriterionLabel();
  if (!guide) return null;
  const empty = !guide.referenceAnswer && !guide.finalAnswer && guide.rubric.length === 0;
  return (
    <div className="space-y-1.5 text-sm" data-testid="guide-details">
      {empty ? <p className="text-muted-foreground">{t('study.practice.guide.none')}</p> : null}
      {guide.referenceAnswer ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            {t('study.practice.guide.reference')}
          </p>
          <div className="whitespace-pre-wrap text-foreground">
            <MathText text={guide.referenceAnswer} allowDisplayMode />
          </div>
        </div>
      ) : null}
      {guide.finalAnswer ? (
        <p className="text-foreground">
          <span className="text-xs font-medium text-muted-foreground">
            {t('study.practice.guide.final')}
          </span>{' '}
          <MathText
            text={guide.finalAnswer.includes('$') ? guide.finalAnswer : `$${guide.finalAnswer}$`}
          />
        </p>
      ) : null}
      {guide.rubric.length ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            {t('study.practice.guide.rubric', { points })}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-foreground">
            {guide.rubric.map((criterion) => (
              <li key={criterion.id}>
                {label(criterion)}
                <span className="ml-1 text-xs text-muted-foreground">
                  {t('study.practice.guide.criterionPoints', { points: criterion.points })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Figures of an extracted question, read through the material image API. */
export function QuestionFigures({ figures }: { figures: readonly QuestionFigure[] | undefined }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  if (!figures?.length) return null;
  return (
    <div className="flex flex-wrap gap-2 py-1">
      {figures.map((figure) => {
        const key = `${figure.versionId}/${figure.imageId}`;
        return failed.has(key) ? (
          <span
            key={key}
            className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
          >
            {t('study.practice.figureMissing')}
          </span>
        ) : (
          <img
            key={key}
            src={materialsApi.imageUrl(
              figure.materialId,
              figure.versionId,
              figure.imageId,
              figure.artifactId,
            )}
            alt={t('study.practice.figureAlt')}
            className="max-h-56 max-w-full rounded-md border border-border bg-white object-contain"
            onError={() => setFailed((current) => new Set([...current, key]))}
          />
        );
      })}
    </div>
  );
}
