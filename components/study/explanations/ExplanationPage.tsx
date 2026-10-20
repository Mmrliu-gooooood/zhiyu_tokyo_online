'use client';

/**
 * One explanation (learning plan B13): written for one wrong question as
 * text, on a whiteboard, as a light interactive page, or a full course.
 * While it is pending the page asks the server to write it (the server
 * keeps going if the student leaves; coming back shows the result); it can
 * be cancelled, retried, written again or deleted, and the next step — new
 * questions of the same kind (B11 variants) — is right below.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Slide, SlideTheme } from '@openmaic/dsl';

import { CompanionAnswer } from '@/components/study/companion/CompanionAnswer';
import {
  FORMAT_ICONS,
  useExplanationStatusLabel,
} from '@/components/study/explanations/ExplainSection';
import { newRequestKey } from '@/components/study/exams/exam-format';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { RelativeTime } from '@/components/study/spaces/study-format';
import { VariantPractice } from '@/components/study/wrongbook/WrongbookPage';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
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
import {
  cancelGenerationJob,
  generationJobRequest,
  retryGenerationJob,
  type GenerationJobSnapshot,
} from '@/lib/generation/job-client';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  courseGenerationHref,
  explanationApi,
  explanationHref,
  itemExplanationsHref,
} from '@/lib/study/explanations/client';
import {
  EXPLANATION_LIMITS,
  isLightFormat,
  type ExplanationDetail,
  type InteractiveExplanation,
  type TextExplanation,
  type WhiteboardExplanation,
} from '@/lib/study/explanations/contracts';
import { readerHref } from '@/lib/study/materials/client';
import { StudyApiError, fetchStudyCapabilities, studyApi } from '@/lib/study/spaces/client';
import { wrongbookApi } from '@/lib/study/wrongbook/client';
import type { WrongOccurrenceView } from '@/lib/study/wrongbook/contracts';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import { cn } from '@/lib/utils';

const POLL_MS = 4000;

const BOARD_THEME: SlideTheme = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Microsoft YaHei',
  outline: { color: '#d14424', width: 2, style: 'solid' },
  shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
};

export function ExplanationPage({
  spaceId,
  explanationId,
}: {
  spaceId: string;
  explanationId: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const statusLabel = useExplanationStatusLabel();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [loadKey, setLoadKey] = useState(0);
  const [spaceName, setSpaceName] = useState('');
  const [practiceOn, setPracticeOn] = useState(false);
  const [detail, setDetail] = useState<ExplanationDetail | null>(null);
  const [question, setQuestion] = useState<WrongOccurrenceView['question'] | null>(null);
  const [working, setWorking] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const runFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      const capabilities = await fetchStudyCapabilities();
      if (!capabilities.explanations) throw new StudyApiError(404, 'STUDY_NOT_AVAILABLE', null);
      const space = await studyApi.getSpace(spaceId);
      const explanation = await explanationApi.get(explanationId);
      if (explanation.spaceId !== spaceId) {
        throw new StudyApiError(404, 'STUDY_EXPLANATION_NOT_FOUND', null);
      }
      return { capabilities, space, explanation };
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') {
        setSpaceName(result.data.space.name);
        setPracticeOn(result.data.capabilities.practice);
        setDetail(result.data.explanation);
      }
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, explanationId, loadKey]);

  // The wrong question as last answered (for the variant step).
  useEffect(() => {
    if (!detail || !practiceOn) return;
    let cancelled = false;
    wrongbookApi
      .get(detail.itemId)
      .then((item) => {
        const wrong = item.occurrences.find((occurrence) => occurrence.outcome !== 'correct');
        if (!cancelled && wrong) setQuestion(wrong.question);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [detail?.itemId, practiceOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async () => {
    setWorking(true);
    setRunError(null);
    try {
      const result = await explanationApi.run(explanationId);
      setDetail(result.explanation);
    } catch (error) {
      setRunError(
        error instanceof StudyApiError && error.code === 'STUDY_EXPLANATION_MODEL_UNAVAILABLE'
          ? t('study.explain.modelUnavailable')
          : error instanceof StudyApiError && error.status === 429
            ? t('study.explain.busy')
            : t('study.errors.generic'),
      );
    } finally {
      setWorking(false);
    }
  }, [explanationId, t]);

  // A pending explanation is written once per visit; one running elsewhere is watched.
  useEffect(() => {
    if (!detail || detail.status !== 'pending' || !isLightFormat(detail.format)) return;
    if (!detail.running && runFor.current !== `${detail.id}:${detail.attempts}`) {
      runFor.current = `${detail.id}:${detail.attempts}`;
      void run();
      return;
    }
    if (working) return;
    const timer = setTimeout(() => {
      explanationApi
        .get(explanationId)
        .then(setDetail)
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [detail, working, run, explanationId]);

  async function act(action: 'cancel' | 'retry' | 'again') {
    if (!detail) return;
    setBusy(true);
    try {
      if (action === 'cancel') {
        if (detail.format === 'course' && detail.jobId) {
          await cancelGenerationJob(detail.jobId).catch(() => undefined);
        }
        setDetail(await explanationApi.cancel(detail.id));
      } else if (action === 'retry') {
        const next = await explanationApi.retry(detail.id);
        if (next.format === 'course') router.push(courseGenerationHref(spaceId, next.id));
        else setDetail(next);
      } else {
        const result = await explanationApi.create({
          itemId: detail.itemId,
          format: detail.format,
          language: locale,
          fresh: true,
          idempotencyKey: newRequestKey(),
        });
        router.push(explanationHref(spaceId, result.explanation.id));
      }
    } catch (error) {
      toast.error(
        error instanceof StudyApiError && error.code === 'STUDY_EXPLANATION_LIMIT'
          ? t('study.explain.limit', { count: EXPLANATION_LIMITS.perDay })
          : t('study.errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!detail) return;
    setBusy(true);
    try {
      await explanationApi.remove(detail.id);
      toast.success(t('study.explain.deleted'));
      router.push(itemExplanationsHref(spaceId, detail.itemId));
    } catch {
      toast.error(t('study.errors.generic'));
      setBusy(false);
    }
  }

  if (state !== 'ready' || !detail) {
    return (
      <StudyShell>
        <StudyStatus
          state={state === 'ready' ? 'loading' : state}
          onRetry={() => {
            setState('loading');
            setLoadKey((key) => key + 1);
          }}
        />
      </StudyShell>
    );
  }

  const Icon = FORMAT_ICONS[detail.format];
  const pending = detail.status === 'pending';
  const light = isLightFormat(detail.format);
  return (
    <StudyShell>
      <Link
        href={itemExplanationsHref(spaceId, detail.itemId)}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        data-testid="explanation-back"
      >
        <ChevronLeft className="size-4" />
        {t('study.explain.backToItem')}
      </Link>

      <header className="mb-4 space-y-2" data-testid="explanation-header">
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5 text-primary" />
          <span>{t(`study.explain.format.${detail.format}`)}</span>
          <span aria-hidden>·</span>
          <span>{spaceName}</span>
          <span aria-hidden>·</span>
          <RelativeTime iso={detail.createdAt} />
          <span
            className={cn(
              'rounded-full px-2 py-0.5',
              detail.status === 'ready'
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : detail.status === 'failed'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-muted',
            )}
            data-testid="explanation-status"
            data-status={detail.status}
          >
            {statusLabel(detail)}
          </span>
        </p>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground md:text-3xl">
          {detail.title ?? t(`study.explain.format.${detail.format}`)}
        </h1>
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {t('study.explain.forQuestion')} {detail.stem}
        </p>
        {light && detail.calls > 0 ? (
          <p className="text-[11px] text-muted-foreground" data-testid="explanation-usage">
            {t('study.explain.usage', {
              model: detail.model ?? '',
              calls: detail.calls,
              tokens: detail.inputTokens + detail.outputTokens,
            })}
            {detail.preferencesUsed ? ` · ${t('study.explain.preferencesUsed')}` : ''}
          </p>
        ) : null}
      </header>

      {light && pending ? (
        <div
          className="mb-4 flex items-start gap-3 rounded-2xl border border-border bg-card px-4 py-4 text-sm"
          data-testid="explanation-pending"
        >
          <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-foreground">{t(`study.explain.writing.${detail.format}`)}</p>
            <p className="text-xs text-muted-foreground">{t('study.explain.canLeave')}</p>
            {runError ? (
              <p className="text-xs text-destructive" data-testid="explanation-run-error">
                {runError}{' '}
                <button type="button" className="underline" onClick={() => void run()}>
                  {t('study.explain.tryAgain')}
                </button>
              </p>
            ) : null}
          </div>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('cancel')}>
            <X className="mr-1 size-4" />
            {t('study.explain.cancel')}
          </Button>
        </div>
      ) : null}

      {detail.status === 'failed' || detail.status === 'cancelled' ? (
        <div
          className="mb-4 rounded-2xl border border-dashed border-border px-4 py-4 text-sm"
          data-testid="explanation-stopped"
        >
          <p className="text-foreground">
            {detail.status === 'failed'
              ? t(`study.explain.error.${detail.lastError ?? 'model_error'}`)
              : t('study.explain.cancelled')}
          </p>
          {detail.canRetry ? (
            <Button
              size="sm"
              className="mt-2"
              disabled={busy}
              onClick={() => void act('retry')}
              data-testid="explanation-retry"
            >
              <RotateCcw className="mr-1 size-4" />
              {t('study.explain.retry', {
                left: light ? EXPLANATION_LIMITS.attempts - detail.attempts : 1,
              })}
            </Button>
          ) : light ? (
            <p className="mt-1 text-xs text-muted-foreground">{t('study.explain.noRetries')}</p>
          ) : null}
        </div>
      ) : null}

      {detail.format === 'course' ? (
        <CourseStatus detail={detail} spaceId={spaceId} onChange={setDetail} />
      ) : null}

      {detail.content?.kind === 'text' ? (
        <TextView content={detail.content} detail={detail} />
      ) : null}
      {detail.content?.kind === 'whiteboard' ? (
        <WhiteboardView content={detail.content} detail={detail} />
      ) : null}
      {detail.content?.kind === 'interactive' ? <InteractiveView content={detail.content} /> : null}

      {detail.sources.length ? (
        <section className="mt-4 space-y-1.5" data-testid="explanation-sources">
          <h2 className="text-xs font-medium text-muted-foreground">
            {t('study.explain.sources')}
          </h2>
          <ul className="space-y-1 text-xs">
            {detail.sources.map((source) => (
              <li key={source.id}>
                <Link
                  href={readerHref(source.materialId, source.versionId, source.page)}
                  className="text-primary hover:underline"
                >
                  [{source.id}] {source.title}
                  {source.page ? ` · ${t('study.explain.page', { page: source.page })}` : ''}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {light && (detail.status === 'ready' || detail.status === 'failed') ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act('again')}
            data-testid="explanation-again"
          >
            <RotateCcw className="mr-1 size-4" />
            {t('study.explain.again')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || (pending && detail.running)}
          onClick={() => setConfirmDelete(true)}
          data-testid="explanation-delete"
        >
          <Trash2 className="mr-1 size-4" />
          {t('study.explain.delete')}
        </Button>
      </footer>

      {practiceOn && question && detail.status === 'ready' ? (
        <section
          className="mt-6 space-y-2 rounded-2xl border border-border bg-card p-4"
          data-testid="explanation-next"
        >
          <h2 className="text-sm font-medium text-foreground">{t('study.explain.next')}</h2>
          <p className="text-xs text-muted-foreground">{t('study.explain.nextHint')}</p>
          <VariantPractice spaceId={spaceId} itemId={detail.itemId} question={question} />
        </section>
      ) : null}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('study.explain.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {detail.format === 'course'
                ? t('study.explain.deleteCourseBody')
                : t('study.explain.deleteBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('study.explain.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void remove()}
              data-testid="explanation-delete-confirm"
            >
              {t('study.explain.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </StudyShell>
  );
}

// ── text ────────────────────────────────────────────────────────────────────

function useCitation(detail: ExplanationDetail) {
  return useCallback(
    (ref: string) => {
      const source = detail.sources.find((candidate) => candidate.id === ref);
      return source ? (
        <Link
          href={readerHref(source.materialId, source.versionId, source.page)}
          className="text-primary no-underline hover:underline"
        >
          [{ref}]
        </Link>
      ) : (
        <span className="text-muted-foreground">[{ref}]</span>
      );
    },
    [detail.sources],
  );
}

function TextView({ content, detail }: { content: TextExplanation; detail: ExplanationDetail }) {
  const { t } = useI18n();
  const cite = useCitation(detail);
  const [showAnswer, setShowAnswer] = useState(false);
  return (
    <article className="space-y-4" data-testid="explanation-text">
      <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <h2 className="mb-1 text-xs font-medium text-amber-700 dark:text-amber-400">
          {t('study.explain.diagnosis')}
        </h2>
        <CompanionAnswer text={content.diagnosis} renderCitation={cite} />
      </section>
      <ol className="space-y-3">
        {content.steps.map((step, index) => (
          <li key={index} className="flex gap-3">
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <CompanionAnswer text={step} renderCitation={cite} />
            </div>
          </li>
        ))}
      </ol>
      <section className="rounded-2xl bg-muted/50 px-4 py-3">
        <h2 className="mb-1 text-xs font-medium text-muted-foreground">
          {t('study.explain.takeaway')}
        </h2>
        <CompanionAnswer text={content.takeaway} renderCitation={cite} />
      </section>
      {content.check ? (
        <section
          className="rounded-2xl border border-border px-4 py-3"
          data-testid="explanation-check"
        >
          <h2 className="mb-1 text-xs font-medium text-muted-foreground">
            {t('study.explain.check')}
          </h2>
          <CompanionAnswer text={content.check.question} renderCitation={cite} />
          {showAnswer ? (
            <div className="mt-2 border-t border-border pt-2">
              <CompanionAnswer text={content.check.answer} renderCitation={cite} />
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => setShowAnswer(true)}>
              {t('study.explain.showAnswer')}
            </Button>
          )}
        </section>
      ) : null}
    </article>
  );
}

// ── whiteboard ──────────────────────────────────────────────────────────────

function WhiteboardView({
  content,
  detail,
}: {
  content: WhiteboardExplanation;
  detail: ExplanationDetail;
}) {
  const { t } = useI18n();
  const cite = useCitation(detail);
  const [step, setStep] = useState(0);
  const last = content.steps.length - 1;
  const board = EXPLANATION_LIMITS.whiteboard;
  const slide = useMemo<Slide>(
    () => ({
      id: `${detail.id}-board-${step}`,
      viewportSize: board.width,
      viewportRatio: board.height / board.width,
      theme: BOARD_THEME,
      elements: content.steps.slice(0, step + 1).flatMap((entry) => entry.elements),
      background: { type: 'solid', color: '#ffffff' },
    }),
    [content.steps, step, detail.id, board.width, board.height],
  );
  const current = content.steps[step]!;
  return (
    <article className="space-y-3" data-testid="explanation-whiteboard">
      <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
        <div className="aspect-video w-full" data-testid="explanation-board" data-step={step + 1}>
          <SlideThumbnail slide={slide} viewportRatio={board.height / board.width} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={step === 0}
          onClick={() => setStep((value) => Math.max(0, value - 1))}
          aria-label={t('study.explain.board.previous')}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="explanation-board-step">
          {t('study.explain.board.step', { step: step + 1, total: content.steps.length })}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={step === last}
          onClick={() => setStep((value) => Math.min(last, value + 1))}
          aria-label={t('study.explain.board.next')}
          data-testid="explanation-board-next"
        >
          <ChevronRight className="size-4" />
        </Button>
        {step < last ? (
          <Button size="sm" variant="ghost" onClick={() => setStep(last)}>
            {t('study.explain.board.all')}
          </Button>
        ) : null}
      </div>
      {current.say ? (
        <div className="rounded-2xl bg-muted/50 px-4 py-3" data-testid="explanation-board-say">
          <CompanionAnswer text={current.say} renderCitation={cite} />
        </div>
      ) : null}
      {step === last ? (
        <section className="rounded-2xl border border-border px-4 py-3">
          <h2 className="mb-1 text-xs font-medium text-muted-foreground">
            {t('study.explain.takeaway')}
          </h2>
          <CompanionAnswer text={content.takeaway} renderCitation={cite} />
        </section>
      ) : null}
    </article>
  );
}

// ── interactive ─────────────────────────────────────────────────────────────

function InteractiveView({ content }: { content: InteractiveExplanation }) {
  const { t } = useI18n();
  const html = useMemo(() => patchHtmlForIframe(content.html), [content.html]);
  return (
    <article className="space-y-3" data-testid="explanation-interactive">
      <p className="rounded-2xl bg-muted/50 px-4 py-3 text-sm text-foreground">{content.intro}</p>
      <div className="overflow-hidden rounded-2xl border border-border bg-white">
        {/* Generated page: scripts run, but without same-origin access (like classroom interactive scenes). */}
        <iframe
          title={content.title}
          srcDoc={html}
          sandbox="allow-scripts allow-forms"
          className="block h-[70dvh] max-h-[640px] min-h-[420px] w-full"
          data-testid="explanation-frame"
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t(`study.explain.widget.${content.widgetType}`)}
      </p>
    </article>
  );
}

// ── course ──────────────────────────────────────────────────────────────────

const JOB_DONE = new Set(['succeeded', 'failed', 'cancelled', 'needs_attention']);

function CourseStatus({
  detail,
  spaceId,
  onChange,
}: {
  detail: ExplanationDetail;
  spaceId: string;
  onChange: (detail: ExplanationDetail) => void;
}) {
  const { t } = useI18n();
  const [job, setJob] = useState<GenerationJobSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const linking = useRef(false);

  // Watch the course generation job; once its first page is ready, the course joins the subject.
  useEffect(() => {
    if (!detail.jobId || detail.status === 'cancelled') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const snapshot = await generationJobRequest<GenerationJobSnapshot>(
          `/${encodeURIComponent(detail.jobId!)}`,
        );
        if (cancelled) return;
        setJob(snapshot);
        if (snapshot.readyScenes > 0 && !detail.stageId && !linking.current) {
          linking.current = true;
          const result = await explanationApi
            .attachCourse(detail.id, { stageId: snapshot.stageId })
            .catch(() => null);
          linking.current = false;
          if (result && !cancelled) onChange(result.explanation);
        }
        if (!JOB_DONE.has(snapshot.status)) timer = setTimeout(poll, POLL_MS);
      } catch {
        if (!cancelled) timer = setTimeout(poll, POLL_MS * 2);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [detail.id, detail.jobId, detail.stageId, detail.status, onChange]);

  async function retryJob() {
    if (!job) return;
    setBusy(true);
    try {
      const next = await retryGenerationJob(job);
      if (next) setJob(next);
    } catch {
      toast.error(t('study.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  const media = detail.media;
  const mediaText = media
    ? (['image', 'tts', 'video'] as const)
        .filter((kind) => media[kind])
        .map((kind) => t(`study.explain.media.${kind}`))
        .join('、') || t('study.explain.media.none')
    : '';
  return (
    <section
      className="mb-4 space-y-2 rounded-2xl border border-border bg-card px-4 py-4 text-sm"
      data-testid="explanation-course"
    >
      {detail.requirement ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {t('study.explain.course.requirement')} {detail.requirement}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t('study.explain.course.media')} {mediaText}
      </p>
      {detail.stageId ? (
        <Button asChild size="sm" data-testid="explanation-course-open">
          <Link href={`/classroom/${encodeURIComponent(detail.stageId)}`}>
            <ExternalLink className="mr-1 size-4" />
            {t('study.explain.course.open')}
          </Link>
        </Button>
      ) : detail.status === 'pending' && (!detail.jobId || job?.status === 'cancelled') ? (
        <Button asChild size="sm" data-testid="explanation-course-start">
          <Link href={courseGenerationHref(spaceId, detail.id)}>
            {t('study.explain.course.start')}
          </Link>
        </Button>
      ) : null}
      {job && !detail.stageId ? (
        <p
          className="text-xs text-foreground"
          data-testid="explanation-course-job"
          data-job-status={job.status}
        >
          {t(`study.explain.course.job.${job.status}`, {
            ready: job.readyScenes,
            total: job.totalScenes,
          })}
          {job.status === 'failed' || job.status === 'needs_attention' ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void retryJob()}>
              <RotateCcw className="mr-1 size-4" />
              {t('study.explain.course.retryJob')}
            </Button>
          ) : null}
        </p>
      ) : null}
      {job && detail.stageId && !JOB_DONE.has(job.status) ? (
        <p className="text-xs text-muted-foreground">
          {t('study.explain.course.stillWriting', {
            ready: job.readyScenes,
            total: job.totalScenes,
          })}
        </p>
      ) : null}
      <p className="text-[11px] text-muted-foreground">{t('study.explain.course.once')}</p>
    </section>
  );
}
