'use client';

/**
 * AI practice generation (learning plan B11), shared by the paper builder
 * (mixed and AI papers) and the wrong-answer book (variants).
 *
 * Before anything calls a model the student sees the plan — how many new
 * questions of which types, the knowledge points, the materials (current
 * versions) they are written from, the most model calls, text only — and has
 * to agree. Then the page runs the job one batch per request and shows what
 * was written, what the program or the AI review rejected and why, and the
 * calls used. A stopped job can be continued (new allowance, at most twice),
 * published with fewer questions, or cancelled.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bot,
  ChevronDown,
  FileText,
  LoaderCircle,
  Play,
  RotateCw,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { MathText, TypeChip, newRequestKey } from '@/components/study/exams/exam-format';
import { useI18n } from '@/lib/hooks/use-i18n';
import { examsApi } from '@/lib/study/assessments/client';
import { readerHref } from '@/lib/study/materials/client';
import { practiceApi, runPracticeJob } from '@/lib/study/practice/client';
import {
  PRACTICE_LIMITS,
  callCapFor,
  remainingTargets,
  type GenerationPlan,
  type GenerationTarget,
  type PracticeJobView,
  type PracticeMaterial,
} from '@/lib/study/practice/contracts';
import { StudyApiError } from '@/lib/study/spaces/client';
import { cn } from '@/lib/utils';

const CHIP = 'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px]';

export function useTargetsText() {
  const { t } = useI18n();
  return (targets: readonly GenerationTarget[]) =>
    targets
      .map((target) =>
        t('study.practice.ai.typeCount', {
          type: t(`study.practice.type.${target.type}`),
          count: target.count,
        }),
      )
      .join(t('study.practice.separator'));
}

/** A readable message for a practice API error. */
export function usePracticeErrorText() {
  const { t } = useI18n();
  return (error: unknown): string => {
    if (error instanceof StudyApiError) {
      switch (error.code) {
        case 'STUDY_PRACTICE_BANK_CHANGED':
          return t('study.practice.ai.bankChanged');
        case 'STUDY_PRACTICE_MODEL_UNAVAILABLE':
          return t('study.practice.ai.modelUnavailable');
        case 'STUDY_PRACTICE_LIMIT':
          return t('study.practice.ai.limit');
        case 'STUDY_PRACTICE_NO_EVIDENCE':
          return t('study.practice.ai.noEvidence');
        case 'STUDY_PRACTICE_NOTHING_TO_GENERATE':
          return t('study.practice.ai.blocked.nothing_to_generate');
        default:
          break;
      }
    }
    return t('study.errors.generic');
  };
}

interface GenerationPanelProps {
  /** The plan the student confirms (paper builder); variants pass a plan built on the page. */
  plan: GenerationPlan;
  /** Whether the student may narrow the materials (paper jobs). */
  selectableMaterials: boolean;
  /** Extra line under the plan (e.g. the bank questions a mixed paper keeps). */
  note?: string | null;
  createJob: (materialVersionIds: string[] | null) => Promise<PracticeJobView>;
  /** Title of the paper (null: the server names it). */
  paperTitle: string | null;
  spaceId: string;
  archived?: boolean;
}

export function GenerationPanel({
  plan,
  selectableMaterials,
  note,
  createJob,
  paperTitle,
  spaceId,
  archived = false,
}: GenerationPanelProps) {
  const { t } = useI18n();
  const router = useRouter();
  const targetsText = useTargetsText();
  const errorText = usePracticeErrorText();
  const [consent, setConsent] = useState(false);
  const [materials, setMaterials] = useState<string[]>(() =>
    plan.materials.map((material) => material.versionId),
  );
  const [job, setJob] = useState<PracticeJobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const runner = useRef<AbortController | null>(null);
  const publishKey = useRef(newRequestKey());

  useEffect(() => () => runner.current?.abort(), []);

  async function run(current: PracticeJobView) {
    runner.current?.abort();
    const controller = new AbortController();
    runner.current = controller;
    try {
      await runPracticeJob(current, setJob, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) toast.error(errorText(error));
      if (current.id) {
        void practiceApi
          .job(current.id)
          .then(setJob)
          .catch(() => undefined);
      }
    }
  }

  async function start() {
    if (!consent || busy) return;
    setBusy(true);
    try {
      const all = materials.length === plan.materials.length;
      const created = await createJob(selectableMaterials && !all ? materials : null);
      setJob(created);
      setBusy(false);
      await run(created);
    } catch (error) {
      toast.error(errorText(error));
      setBusy(false);
    }
  }

  async function act(action: 'cancel' | 'continue') {
    if (!job) return;
    setBusy(true);
    try {
      const next =
        action === 'cancel' ? await practiceApi.cancel(job.id) : await practiceApi.continue(job.id);
      if (action === 'cancel') runner.current?.abort();
      setJob(next);
      setBusy(false);
      if (next.status === 'pending') await run(next);
    } catch (error) {
      toast.error(errorText(error));
      setBusy(false);
    }
  }

  async function publish(acceptShort: boolean) {
    if (!job) return;
    setBusy(true);
    try {
      const paper = await practiceApi.publish(job.id, {
        ...(paperTitle ? { title: paperTitle } : {}),
        idempotencyKey: publishKey.current,
        acceptShort,
      });
      const attempt = await examsApi.start(paper.id);
      router.push(
        `/study/${encodeURIComponent(spaceId)}/attempts/${encodeURIComponent(attempt.id)}`,
      );
    } catch (error) {
      toast.error(errorText(error));
      setBusy(false);
    }
  }

  if (!job) {
    return (
      <div
        className="space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-4 text-sm"
        data-testid="ai-plan"
      >
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <Sparkles className="size-4 text-primary" />
          {t('study.practice.ai.planTitle')}
        </p>
        {plan.blocked ? (
          <p className="text-muted-foreground" data-testid="ai-plan-blocked">
            {t(`study.practice.ai.blocked.${plan.blocked}`, { max: PRACTICE_LIMITS.maxQuestions })}
          </p>
        ) : (
          <>
            <ul className="space-y-1 text-foreground">
              <li>
                {t('study.practice.ai.planNew', {
                  count: plan.total,
                  types: targetsText(plan.targets),
                })}
              </li>
              {note ? <li className="text-muted-foreground">{note}</li> : null}
              {plan.concepts.length ? (
                <li>
                  {t('study.practice.ai.planConcepts', {
                    names: plan.concepts.join(t('study.practice.separator')),
                  })}
                </li>
              ) : null}
              <li>{t('study.practice.ai.planCalls', { count: plan.maxCalls })}</li>
              <li className="text-muted-foreground">{t('study.practice.ai.planMedia')}</li>
            </ul>
            {plan.materials.length ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('study.practice.ai.planMaterials')}
                </p>
                {plan.materials.map((material) => (
                  <MaterialOption
                    key={material.versionId}
                    material={material}
                    selectable={selectableMaterials}
                    checked={materials.includes(material.versionId)}
                    onToggle={() =>
                      setMaterials((current) =>
                        current.includes(material.versionId)
                          ? current.filter((id) => id !== material.versionId)
                          : [...current, material.versionId],
                      )
                    }
                  />
                ))}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('study.practice.ai.planNote')}</p>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={consent}
                onCheckedChange={(checked) => setConsent(checked === true)}
                data-testid="ai-consent"
              />
              {t('study.practice.ai.consent', { count: plan.total })}
            </label>
            <Button
              disabled={
                !consent || busy || archived || (selectableMaterials && materials.length === 0)
              }
              onClick={() => void start()}
              data-testid="ai-start"
            >
              {busy ? (
                <LoaderCircle className="mr-1 size-4 animate-spin" />
              ) : (
                <Bot className="mr-1 size-4" />
              )}
              {t('study.practice.ai.start', { count: plan.total })}
            </Button>
          </>
        )}
      </div>
    );
  }

  const done = job.produced.length;
  const left = remainingTargets(job.targets, job.produced);
  const leftCount = left.reduce((sum, target) => sum + target.count, 0);
  const pending = job.status === 'pending';
  const atCap = job.calls + 2 > job.callCap;
  return (
    <div
      className="space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-4 text-sm"
      data-testid="ai-job"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          {pending ? (
            <LoaderCircle className="size-4 animate-spin text-primary" />
          ) : (
            <Sparkles className="size-4 text-primary" />
          )}
          {t('study.practice.ai.progress', {
            done,
            total: job.total,
            calls: job.calls,
            cap: job.callCap,
          })}
        </p>
        {job.status !== 'cancelled' && !job.paperId ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('cancel')}>
            <X className="mr-1 size-4" />
            {t('study.practice.ai.cancel')}
          </Button>
        ) : null}
      </div>

      <p className="text-muted-foreground" data-testid="ai-job-status">
        {pending
          ? t('study.practice.ai.running')
          : job.status === 'completed'
            ? t('study.practice.ai.completed', { total: job.total })
            : job.status === 'cancelled'
              ? t('study.practice.ai.cancelled')
              : t(`study.practice.ai.stopped.${job.lastError ?? 'budget'}`, {
                  done,
                  total: job.total,
                })}
      </p>
      {job.uncoveredConcepts.length && !pending ? (
        <p className="text-amber-700 dark:text-amber-400">
          {t('study.practice.ai.uncoveredLeft', {
            names: job.uncoveredConcepts.join(t('study.practice.separator')),
          })}
        </p>
      ) : null}

      {job.produced.length ? (
        <ol className="space-y-2" data-testid="ai-produced">
          {job.produced.map((question, index) => (
            <li
              key={question.questionId}
              className="rounded-lg border border-border bg-background p-3"
            >
              <div className="flex gap-2">
                <span className="w-6 shrink-0 text-xs text-muted-foreground">{index + 1}.</span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="line-clamp-3">
                    <MathText text={question.stem} />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TypeChip type={question.type} subtype={question.subtype} />
                    <span className={cn(CHIP, 'bg-primary/10 text-primary')}>
                      {t('study.practice.ai.reviewed')}
                    </span>
                    {question.concepts.map((name) => (
                      <span key={name} className="text-[11px] text-muted-foreground">
                        #{name}
                      </span>
                    ))}
                    {question.similarity ? (
                      <span className="text-[11px] text-muted-foreground">
                        {t(
                          question.similarity.original
                            ? 'study.practice.ai.similarOriginal'
                            : 'study.practice.ai.similar',
                          { score: question.similarity.score },
                        )}
                      </span>
                    ) : null}
                  </div>
                  <EvidenceLinks job={job} refs={question.refs} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {job.rejectedCount ? (
        <div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowRejected((value) => !value)}
            data-testid="ai-rejected-toggle"
          >
            <ChevronDown
              className={cn('size-3 transition-transform', showRejected && 'rotate-180')}
            />
            {t('study.practice.ai.rejectedSummary', { count: job.rejectedCount })}
          </button>
          {showRejected ? (
            <ul
              className="mt-1.5 space-y-1 text-xs text-muted-foreground"
              data-testid="ai-rejected"
            >
              {job.rejected.map((entry, index) => (
                <li key={index}>
                  <span className="text-foreground">
                    {t(`study.practice.ai.stage.${entry.stage}`)} ·{' '}
                    {t(`study.practice.ai.reason.${entry.reason}`)}
                  </span>
                  {entry.stem ? <span className="ml-1">「{entry.stem}」</span> : null}
                  {entry.note && entry.stage === 'review' ? (
                    <span className="ml-1">— {entry.note}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {!pending && job.status !== 'cancelled' && !job.paperId ? (
        <div className="flex flex-wrap gap-2">
          {job.status === 'completed' || done > 0 || job.bankCount > 0 ? (
            <Button
              disabled={busy || archived || (done === 0 && job.bankCount === 0)}
              onClick={() =>
                void publish(job.status !== 'completed' || job.uncoveredConcepts.length > 0)
              }
              data-testid="ai-publish"
            >
              <Play className="mr-1 size-4" />
              {job.status === 'completed' && job.uncoveredConcepts.length === 0
                ? t(
                    job.kind === 'variant'
                      ? 'study.practice.ai.startPractice'
                      : 'study.practice.ai.publish',
                  )
                : t('study.practice.ai.publishShort', { count: done + job.bankCount })}
            </Button>
          ) : null}
          {job.canContinue ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void act('continue')}
              data-testid="ai-continue"
            >
              <RotateCw className="mr-1 size-4" />
              {atCap
                ? t('study.practice.ai.continue', { count: callCapFor(leftCount) })
                : t('study.practice.ai.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {job.paperId ? (
        <Link
          href={`/study/${encodeURIComponent(spaceId)}/practice?tab=papers`}
          className="text-xs text-primary hover:underline"
        >
          {t('study.practice.ai.published')}
        </Link>
      ) : null}
    </div>
  );
}

function MaterialOption({
  material,
  selectable,
  checked,
  onToggle,
}: {
  material: PracticeMaterial;
  selectable: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const label = (
    <span className="inline-flex items-center gap-1">
      <FileText className="size-3.5 text-muted-foreground" />
      {material.title}
      <span className="text-xs text-muted-foreground">
        {t('study.practice.source.version', { n: material.versionNo })}
      </span>
    </span>
  );
  if (!selectable) return <p>{label}</p>;
  return (
    <label className="flex items-center gap-2">
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      {label}
    </label>
  );
}

/** The material pages a question was written from (linked to the reader), or the original question. */
function EvidenceLinks({ job, refs }: { job: PracticeJobView; refs: readonly string[] }) {
  const { t } = useI18n();
  const byId = new Map(job.evidence.map((piece) => [piece.id, piece]));
  const pieces = refs.flatMap((ref) => (byId.get(ref) ? [byId.get(ref)!] : []));
  if (!pieces.length) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
      <span>{t('study.practice.ai.basedOn')}</span>
      {pieces.map((piece) =>
        piece.kind === 'question' ? (
          <span key={piece.id}>{t('study.practice.ai.originalQuestion')}</span>
        ) : piece.materialId && piece.versionId ? (
          <Link
            key={piece.id}
            href={readerHref(piece.materialId, piece.versionId, piece.page ?? null)}
            className="inline-flex items-center gap-0.5 text-primary hover:underline"
          >
            <FileText className="size-3" />
            {piece.title ?? ''}
            {piece.page ? ` · ${t('study.practice.ai.page', { page: piece.page })}` : ''}
          </Link>
        ) : null,
      )}
    </p>
  );
}
