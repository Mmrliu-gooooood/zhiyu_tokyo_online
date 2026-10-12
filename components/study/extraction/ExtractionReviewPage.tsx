'use client';

/**
 * /study/[spaceId]/extractions/[extractionId] — check extracted exercises
 * against the original pages (learning plan B08).
 *
 * Left: the original page (PDF canvas, or the parsed text), the page's
 * figures and the selected candidate's source lines (split from any line).
 * Right: the candidates with where their answer came from; edit, discard,
 * restore, merge with the next one, ask the model to tidy them and suggest
 * answers (optional, never marks anything checked), tick "answer checked",
 * and add the selected ones to the question bank.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  Combine,
  ImagePlus,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';

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
import { Checkbox } from '@/components/ui/checkbox';
import { MathText, TypeChip, useIssueText } from '@/components/study/exams/exam-format';
import { QuestionEditorDialog } from '@/components/study/exams/QuestionEditorDialog';
import { extractionTitle } from '@/components/study/extraction/ExtractQuestionsDialog';
import { PdfPageView } from '@/components/study/materials/MaterialReaderPage';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { useI18n } from '@/lib/hooks/use-i18n';
import { candidateIssues, isCommittable } from '@/lib/study/extraction/candidate';
import { extractionApi } from '@/lib/study/extraction/client';
import {
  EXTRACTION_LIMITS,
  type CandidateView,
  type ExtractionDetail,
} from '@/lib/study/extraction/contracts';
import { materialsApi } from '@/lib/study/materials/client';
import type { ReaderPageView } from '@/lib/study/materials/contracts';
import { blockingIssues, type QuestionContent } from '@/lib/study/questions/contracts';
import { StudyApiError, fetchStudyCapabilities } from '@/lib/study/spaces/client';
import { cn } from '@/lib/utils';

type Filter = 'todo' | 'ready' | 'committed' | 'discarded' | 'all';
const FILTERS: Filter[] = ['todo', 'ready', 'committed', 'discarded', 'all'];

function matches(candidate: CandidateView, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'todo') return candidate.status === 'draft';
  if (filter === 'ready') return candidate.status === 'draft' && isCommittable(candidate.content);
  return candidate.status === filter;
}

/** Counts after a local change (the server sends exact ones with every full reload). */
function recount(detail: ExtractionDetail): ExtractionDetail {
  const by = (status: CandidateView['status']) =>
    detail.candidates.filter((candidate) => candidate.status === status).length;
  return {
    ...detail,
    extraction: {
      ...detail.extraction,
      counts: {
        total: detail.candidates.length,
        draft: by('draft'),
        committed: by('committed'),
        discarded: by('discarded'),
        ready: detail.candidates.filter((c) => matches(c, 'ready')).length,
      },
    },
  };
}

function editorContent(candidate: CandidateView): QuestionContent {
  const content = candidate.content;
  return {
    type: content.type === 'open' ? 'single' : content.type,
    stem: content.stem,
    options:
      content.type === 'open' || content.options.length === 0
        ? ['A', 'B', 'C', 'D'].map((value) => ({ value, label: '' }))
        : content.options,
    answer: content.answer,
    explanation: content.explanation,
    concepts: content.concepts,
    difficulty: content.difficulty,
    points: content.points,
    source: null,
  };
}

export function ExtractionReviewPage({
  spaceId,
  extractionId,
}: {
  spaceId: string;
  extractionId: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [detail, setDetail] = useState<ExtractionDetail | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState<number | null>(null);
  const [reader, setReader] = useState<ReaderPageView | null>(null);
  const [readerFailed, setReaderFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('todo');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<CandidateView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      if (!(await fetchStudyCapabilities()).extraction) {
        throw Object.assign(new Error('unavailable'), { status: 404 });
      }
      return extractionApi.get(extractionId);
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') {
        if (result.data.extraction.spaceId !== spaceId) {
          setState('not-found');
          return;
        }
        setDetail(result.data);
        const first =
          result.data.candidates.find((candidate) => candidate.status === 'draft') ??
          result.data.candidates[0];
        setSelectedId((current) => current ?? first?.id ?? null);
        setPage((current) => current ?? first?.pages[0] ?? result.data.extraction.pageFrom ?? null);
      }
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [extractionId, spaceId, loadKey]);

  const extraction = detail?.extraction ?? null;

  // The original page beside the candidates.
  useEffect(() => {
    if (!extraction) return;
    const controller = new AbortController();
    materialsApi
      .reader(
        extraction.materialId,
        extraction.versionId,
        page,
        extraction.artifactId,
        controller.signal,
      )
      .then((view) => {
        setReader(view);
        setReaderFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setReaderFailed(true);
      });
    return () => controller.abort();
  }, [extraction, page]);

  const candidates = useMemo(() => detail?.candidates ?? [], [detail]);
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? null;
  const shown = candidates.filter((candidate) => matches(candidate, filter));
  const pickedDrafts = candidates.filter(
    (candidate) => picked.has(candidate.id) && candidate.status === 'draft',
  );
  const pickedReady = pickedDrafts.filter((candidate) => isCommittable(candidate.content));

  const reload = useCallback(() => setLoadKey((key) => key + 1), []);

  const replace = useCallback((candidate: CandidateView) => {
    setDetail((current) =>
      current
        ? recount({
            ...current,
            candidates: current.candidates.map((entry) =>
              entry.id === candidate.id ? candidate : entry,
            ),
          })
        : current,
    );
  }, []);

  const failed = useCallback(
    (error: unknown) => {
      const code = error instanceof StudyApiError ? error.code : '';
      if (code === 'STUDY_REVISION_CONFLICT') {
        toast.error(t('study.extraction.errors.conflict'));
        reload();
      } else if (code === 'STUDY_EXTRACTION_SOURCE_GONE') {
        toast.error(t('study.extraction.sourceGone'));
        reload();
      } else if (code === 'STUDY_EXTRACTION_MODEL_UNAVAILABLE') {
        toast.error(t('study.extraction.errors.model'));
      } else if (code === 'STUDY_EXTRACTION_ASSIST_LIMIT') {
        toast.error(t('study.extraction.errors.assistLimit'));
      } else if (code === 'STUDY_EXTRACTION_ASSIST_INVALID') {
        toast.error(t('study.extraction.errors.assistInvalid'));
      } else if (code === 'STUDY_QUESTION_LIMIT') {
        toast.error(t('study.practice.errors.questionLimit'));
      } else if (error instanceof StudyApiError && error.status === 429) {
        toast.error(t('study.extraction.errors.busy'));
      } else {
        toast.error(t('study.errors.generic'));
      }
    },
    [t, reload],
  );

  async function run<T>(key: string, action: () => Promise<T>): Promise<T | undefined> {
    setBusy(key);
    try {
      return await action();
    } catch (error) {
      failed(error);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  function select(candidate: CandidateView) {
    setSelectedId(candidate.id);
    if (candidate.pages[0]) setPage(candidate.pages[0]);
  }

  async function commit(ids: string[]) {
    if (!extraction || ids.length === 0) return;
    const result = await run('commit', () => extractionApi.commit(extraction.id, ids, null));
    if (!result) return;
    setDetail(result.detail);
    setPicked(new Set());
    const count = (status: string) =>
      result.outcomes.filter((outcome) => outcome.status === status).length;
    toast.success(
      t('study.extraction.committed', {
        created: count('created'),
        duplicates: count('duplicate'),
        invalid: count('invalid'),
      }),
    );
  }

  async function assist(ids: string[]) {
    if (!extraction || ids.length === 0) return;
    const result = await run('assist', () => extractionApi.assist(extraction.id, ids));
    if (!result) return;
    setDetail(result.detail);
    toast.success(
      t('study.extraction.assisted', {
        count: result.suggested.length,
        missing: result.missing.length,
      }),
    );
  }

  if (state !== 'ready' || !detail || !extraction) {
    return (
      <StudyShell>
        <StudyStatus
          state={state === 'ready' ? 'loading' : state}
          onRetry={() => {
            setState('loading');
            reload();
          }}
        />
      </StudyShell>
    );
  }

  const stats = extraction.stats;
  const usage = extraction.usage;
  const rangeFrom = extraction.pageFrom;
  const rangeTo = extraction.pageTo;
  const pageImages = (reader?.blocks ?? []).filter((block) => block.imageId);
  const writable = extraction.sourceAvailable;
  const isPdf = reader?.mime === 'application/pdf';

  return (
    <StudyShell>
      <Link
        href={`/study/${encodeURIComponent(spaceId)}/practice`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t('study.practice.title')}
      </Link>
      <header className="mb-4 space-y-1.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 className="min-w-0 text-xl font-semibold tracking-[-0.02em] text-foreground md:text-2xl">
            {t('study.extraction.reviewTitle')}
            <span className="mt-1 block text-sm font-normal text-muted-foreground">
              {extractionTitle(t, extraction)}
            </span>
          </h1>
          <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
            <Trash2 className="mr-1 size-4" />
            {t('study.extraction.delete')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="extraction-stats">
          {t('study.extraction.stats', {
            pages: stats.pagesRead,
            found: stats.candidates,
            choice: stats.choice,
            open: stats.open,
            answers: stats.answersFromSource,
            ms: stats.durationMs,
          })}
          {usage.modelCalls > 0
            ? ` · ${t('study.extraction.usage', {
                calls: usage.modelCalls,
                input: usage.inputTokens,
                output: usage.outputTokens,
                model: usage.modelString ?? '',
              })}`
            : ` · ${t('study.extraction.noModel')}`}
          {usage.usageCompleteness === 'partial' ? ` · ${t('study.extraction.usagePartial')}` : ''}
        </p>
      </header>

      <div className="mb-4 space-y-2">
        {!extraction.sourceAvailable ? (
          <Notice tone="warn" testId="extraction-source-gone">
            {t('study.extraction.sourceGone')}
          </Notice>
        ) : null}
        {!extraction.isCurrentVersion && extraction.sourceAvailable ? (
          <Notice>{t('study.extraction.oldVersion', { n: extraction.versionNo ?? '?' })}</Notice>
        ) : null}
        {stats.skippedPages.length ? (
          <Notice tone="warn" testId="extraction-skipped">
            {t('study.extraction.skipped', { pages: stats.skippedPages.join('、') })}
          </Notice>
        ) : null}
        {stats.unmatchedAnswers.length ? (
          <Notice>
            {t('study.extraction.unmatched', {
              count: stats.unmatchedAnswers.length,
              list: stats.unmatchedAnswers
                .slice(0, 8)
                .map((entry) => `${entry.label}. ${entry.text}（${entry.page}）`)
                .join('；'),
            })}
          </Notice>
        ) : null}
        {stats.unassignedFigures.length ? (
          <Notice>
            {t('study.extraction.unassignedFigures', {
              count: stats.unassignedFigures.length,
              pages: [...new Set(stats.unassignedFigures.map((figure) => figure.page))].join('、'),
            })}
          </Notice>
        ) : null}
        {stats.truncated ? <Notice tone="warn">{t('study.extraction.truncated')}</Notice> : null}
        {stats.candidates === 0 ? (
          <Notice tone="warn" testId="extraction-empty">
            {t('study.extraction.empty')}
          </Notice>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {/* Original */}
        <section className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <Button
            variant="outline"
            size="sm"
            className="w-full lg:hidden"
            onClick={() => setShowOriginal((value) => !value)}
          >
            {showOriginal ? t('study.extraction.hideOriginal') : t('study.extraction.showOriginal')}
          </Button>
          <div className={cn('space-y-3', !showOriginal && 'hidden lg:block')}>
            <div className="flex items-center justify-between gap-2">
              <Button
                size="icon"
                variant="outline"
                disabled={page === null || rangeFrom === null || page <= rangeFrom}
                aria-label={t('study.extraction.prevPage')}
                onClick={() => setPage((current) => (current ? current - 1 : current))}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-sm text-muted-foreground" data-testid="extraction-page">
                {page !== null
                  ? t('study.extraction.pageOf', { page, count: reader?.pageCount ?? '…' })
                  : t('study.extraction.wholeDocument')}
              </span>
              <Button
                size="icon"
                variant="outline"
                disabled={page === null || rangeTo === null || page >= rangeTo}
                aria-label={t('study.extraction.nextPage')}
                onClick={() => setPage((current) => (current ? current + 1 : current))}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
            <div className="max-h-[70vh] overflow-auto rounded-xl border border-border bg-card p-2">
              {readerFailed ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t('study.extraction.originalUnavailable')}
                </p>
              ) : isPdf && page !== null ? (
                <PdfPageView
                  url={materialsApi.fileUrl(extraction.materialId, extraction.versionId)}
                  page={page}
                />
              ) : reader ? (
                <div className="space-y-2 p-2 text-sm leading-7 text-foreground">
                  {reader.blocks
                    .filter((block) => block.text && !block.imageId)
                    .map((block) => (
                      <p key={block.id} className="whitespace-pre-wrap break-words">
                        {block.text}
                      </p>
                    ))}
                  {reader.blocks.every((block) => !block.text) ? (
                    <p className="text-muted-foreground">{t('study.extraction.pageNoText')}</p>
                  ) : null}
                </div>
              ) : (
                <LoaderCircle className="mx-auto my-8 size-4 animate-spin text-muted-foreground" />
              )}
            </div>
            {pageImages.length ? (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">{t('study.extraction.pageFigures')}</p>
                <div className="flex flex-wrap gap-2">
                  {pageImages.map((block) => {
                    const imageId = block.imageId!;
                    const inSelected = selected?.content.figures.includes(imageId) ?? false;
                    const canToggle =
                      writable &&
                      selected?.status === 'draft' &&
                      (inSelected ||
                        selected.content.figures.length < EXTRACTION_LIMITS.figuresPerQuestion);
                    return (
                      <div key={block.id} className="w-28 space-y-1">
                        <img
                          src={materialsApi.imageUrl(
                            extraction.materialId,
                            extraction.versionId,
                            imageId,
                            extraction.artifactId,
                          )}
                          alt={t('study.practice.figureAlt')}
                          className={cn(
                            'h-20 w-28 rounded-md border bg-white object-contain',
                            inSelected ? 'border-primary ring-2 ring-primary/40' : 'border-border',
                          )}
                        />
                        {selected && canToggle ? (
                          <Button
                            size="sm"
                            variant={inSelected ? 'secondary' : 'outline'}
                            className="h-7 w-full px-1 text-[11px]"
                            disabled={busy !== null}
                            data-testid={`figure-toggle-${imageId}`}
                            onClick={() =>
                              void run(selected.id, async () => {
                                const figures = inSelected
                                  ? selected.content.figures.filter((id) => id !== imageId)
                                  : [...selected.content.figures, imageId];
                                replace(
                                  await extractionApi.update(selected, {
                                    content: { ...selected.content, figures },
                                  }),
                                );
                              })
                            }
                          >
                            <ImagePlus className="mr-0.5 size-3" />
                            {inSelected
                              ? t('study.extraction.removeFigure')
                              : t('study.extraction.addFigure')}
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {selected ? (
              <div className="space-y-1.5" data-testid="extraction-source-lines">
                <p className="text-xs text-muted-foreground">
                  {t('study.extraction.sourceLines', {
                    label: selected.label ?? '—',
                    pages: selected.pages.join('–'),
                  })}
                </p>
                <ol className="max-h-64 space-y-0.5 overflow-auto rounded-xl border border-border bg-muted/30 p-2 text-xs leading-5">
                  {selected.lines.map((line, index) => (
                    <li key={index} className="group flex items-start gap-2">
                      <span className="w-8 shrink-0 text-right text-muted-foreground">
                        {line.page}
                      </span>
                      <span className="min-w-0 flex-1 break-words text-foreground">
                        {line.text}
                      </span>
                      {index > 0 && selected.status === 'draft' && writable ? (
                        <button
                          type="button"
                          className="shrink-0 rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          title={t('study.extraction.splitHere')}
                          aria-label={t('study.extraction.splitHere')}
                          data-testid={`split-at-${index}`}
                          disabled={busy !== null}
                          onClick={() =>
                            void run(selected.id, async () => {
                              const next = await extractionApi.split(selected, index);
                              setDetail(next);
                            })
                          }
                        >
                          <Scissors className="size-3.5" />
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        </section>

        {/* Candidates */}
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((entry) => (
              <Button
                key={entry}
                size="sm"
                variant={filter === entry ? 'secondary' : 'ghost'}
                className="h-8"
                onClick={() => setFilter(entry)}
                data-testid={`extraction-filter-${entry}`}
              >
                {t(`study.extraction.filter.${entry}`)} (
                {candidates.filter((candidate) => matches(candidate, entry)).length})
              </Button>
            ))}
          </div>
          {writable ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setPicked(new Set(candidates.filter((c) => matches(c, 'ready')).map((c) => c.id)))
                }
              >
                {t('study.extraction.pickReady')}
              </Button>
              {picked.size ? (
                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                  {t('study.extraction.clearPicked')}
                </Button>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {t('study.extraction.picked', { count: pickedDrafts.length })}
              </span>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy !== null ||
                    pickedDrafts.length === 0 ||
                    pickedDrafts.length > EXTRACTION_LIMITS.assistBatch
                  }
                  title={t('study.extraction.assistHint', { max: EXTRACTION_LIMITS.assistBatch })}
                  onClick={() => void assist(pickedDrafts.map((candidate) => candidate.id))}
                  data-testid="extraction-assist"
                >
                  {busy === 'assist' ? (
                    <LoaderCircle className="mr-1 size-4 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1 size-4" />
                  )}
                  {t('study.extraction.assist')}
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== null || pickedReady.length === 0}
                  onClick={() => void commit(pickedReady.map((candidate) => candidate.id))}
                  data-testid="extraction-commit"
                >
                  {busy === 'commit' ? (
                    <LoaderCircle className="mr-1 size-4 animate-spin" />
                  ) : (
                    <ArrowDownToLine className="mr-1 size-4" />
                  )}
                  {t('study.extraction.commit', { count: pickedReady.length })}
                </Button>
              </div>
              <p className="w-full text-[11px] text-muted-foreground">
                {pickedDrafts.length > EXTRACTION_LIMITS.assistBatch
                  ? t('study.extraction.assistHint', { max: EXTRACTION_LIMITS.assistBatch })
                  : t('study.extraction.commitHint')}
              </p>
            </div>
          ) : null}

          {shown.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
              {t('study.extraction.noneHere')}
            </p>
          ) : (
            <ul className="space-y-3">
              {shown.map((candidate) => (
                <CandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  materialId={extraction.materialId}
                  versionId={extraction.versionId}
                  artifactId={extraction.artifactId}
                  selected={candidate.id === selectedId}
                  picked={picked.has(candidate.id)}
                  writable={writable}
                  busy={busy !== null}
                  working={busy === candidate.id}
                  onSelect={() => select(candidate)}
                  onPick={(value) =>
                    setPicked((current) => {
                      const next = new Set(current);
                      if (value) next.add(candidate.id);
                      else next.delete(candidate.id);
                      return next;
                    })
                  }
                  onEdit={() => setEditing(candidate)}
                  onCheck={(checked) =>
                    void run(candidate.id, async () =>
                      replace(await extractionApi.update(candidate, { checked })),
                    )
                  }
                  onStatus={(status) =>
                    void run(candidate.id, async () =>
                      replace(await extractionApi.update(candidate, { status })),
                    )
                  }
                  onRestore={() =>
                    void run(candidate.id, async () =>
                      replace(await extractionApi.restore(candidate)),
                    )
                  }
                  onAdopt={() =>
                    void run(candidate.id, async () =>
                      replace(await extractionApi.adopt(candidate)),
                    )
                  }
                  onMerge={() =>
                    void run(candidate.id, async () =>
                      setDetail(await extractionApi.merge(candidate)),
                    )
                  }
                  onCommit={() => void commit([candidate.id])}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {editing ? (
        <QuestionEditorDialog
          open
          onOpenChange={(next) => !next && setEditing(null)}
          title={t('study.extraction.editTitle', { label: editing.label ?? '—' })}
          initial={{ content: editorContent(editing), verified: editing.checked, stageId: null }}
          courses={[]}
          onSave={async (value) => {
            try {
              replace(
                await extractionApi.update(editing, {
                  content: {
                    ...editing.content,
                    type: value.content.type,
                    stem: value.content.stem,
                    options: value.content.options,
                    answer: value.content.answer,
                    explanation: value.content.explanation,
                    concepts: value.content.concepts,
                    difficulty: value.content.difficulty,
                    points: value.content.points,
                  },
                  checked: value.verified,
                }),
              );
            } catch (error) {
              failed(error);
              throw new Error(t('study.extraction.errors.saveFailed'));
            }
          }}
        />
      ) : null}

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('study.extraction.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('study.extraction.deleteText')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                void extractionApi
                  .remove(extraction.id)
                  .then(() => router.push(`/study/${encodeURIComponent(spaceId)}/practice`))
                  .catch(failed)
              }
            >
              {t('study.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </StudyShell>
  );
}

function Notice({
  children,
  tone = 'info',
  testId,
}: {
  children: React.ReactNode;
  tone?: 'info' | 'warn';
  testId?: string;
}) {
  return (
    <p
      data-testid={testId}
      className={cn(
        'rounded-lg px-3 py-2 text-sm',
        tone === 'warn'
          ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300'
          : 'bg-muted/60 text-muted-foreground',
      )}
    >
      {children}
    </p>
  );
}

function AnswerBasisChip({ candidate }: { candidate: CandidateView }) {
  const { t } = useI18n();
  const ref = candidate.answerRef;
  const text =
    candidate.answerBasis === 'source'
      ? ref?.kind === 'answer_key'
        ? t('study.extraction.basis.answerKey', { page: ref.page })
        : t('study.extraction.basis.inline')
      : t(`study.extraction.basis.${candidate.answerBasis}`);
  return (
    <span
      data-testid="candidate-basis"
      data-basis={candidate.answerBasis}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px]',
        candidate.answerBasis === 'missing' || candidate.answerBasis === 'model'
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {text}
    </span>
  );
}

function CandidateCard(props: {
  candidate: CandidateView;
  materialId: string;
  versionId: string;
  artifactId: string;
  selected: boolean;
  picked: boolean;
  writable: boolean;
  busy: boolean;
  working: boolean;
  onSelect: () => void;
  onPick: (value: boolean) => void;
  onEdit: () => void;
  onCheck: (checked: boolean) => void;
  onStatus: (status: 'draft' | 'discarded') => void;
  onRestore: () => void;
  onAdopt: () => void;
  onMerge: () => void;
  onCommit: () => void;
}) {
  const { t } = useI18n();
  const issueText = useIssueText();
  const { candidate } = props;
  const content = candidate.content;
  const errors = blockingIssues(candidateIssues(content));
  const draft = candidate.status === 'draft';
  const editable = draft && props.writable;
  const suggestion = candidate.suggestion;
  return (
    <li
      data-testid="candidate"
      data-candidate-id={candidate.id}
      data-status={candidate.status}
      className={cn(
        'rounded-2xl border bg-card p-4 transition-colors',
        props.selected ? 'border-primary/60 ring-1 ring-primary/30' : 'border-border',
        candidate.status === 'discarded' && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-2.5">
        {editable ? (
          <Checkbox
            className="mt-1"
            checked={props.picked}
            onCheckedChange={(value) => props.onPick(value === true)}
            aria-label={t('study.extraction.pick')}
          />
        ) : null}
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={props.onSelect}
          data-testid="candidate-select"
        >
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">
              {candidate.label ? t('study.extraction.number', { label: candidate.label }) : '—'}
            </span>
            {candidate.section ? <span className="truncate">{candidate.section}</span> : null}
            <span>· {t('study.extraction.onPages', { pages: candidate.pages.join('–') })}</span>
          </div>
          <div className="text-sm leading-6 text-foreground">
            <MathText text={content.stem || t('study.practice.import.noStem')} allowDisplayMode />
          </div>
        </button>
      </div>

      {content.figures.length ? (
        <div className="mt-2 flex flex-wrap gap-2 pl-7">
          {content.figures.map((imageId) => (
            <img
              key={imageId}
              src={materialsApi.imageUrl(
                props.materialId,
                props.versionId,
                imageId,
                props.artifactId,
              )}
              alt={t('study.practice.figureAlt')}
              className="max-h-40 max-w-full rounded-md border border-border bg-white object-contain"
            />
          ))}
        </div>
      ) : null}

      {content.options.length ? (
        <div className="mt-2 grid gap-1 pl-7 text-sm">
          {content.options.map((option) => (
            <p
              key={option.value}
              className={cn(
                content.answer.includes(option.value)
                  ? 'font-medium text-primary'
                  : 'text-muted-foreground',
              )}
            >
              {option.value}. <MathText text={option.label} />
            </p>
          ))}
        </div>
      ) : null}
      {content.referenceAnswer ? (
        <p className="mt-2 pl-7 text-sm text-muted-foreground">
          {t('study.extraction.referenceAnswer')}
          <MathText text={content.referenceAnswer} />
        </p>
      ) : null}
      {content.explanation ? (
        <p className="mt-2 pl-7 text-sm text-muted-foreground">
          <MathText text={content.explanation} allowDisplayMode />
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-7">
        {content.type === 'open' ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {t('study.extraction.openType')}
          </span>
        ) : (
          <TypeChip type={content.type} />
        )}
        <AnswerBasisChip candidate={candidate} />
        {candidate.edited ? (
          <span className="text-[11px] text-muted-foreground">{t('study.extraction.edited')}</span>
        ) : null}
        {candidate.status === 'committed' ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
            {t('study.extraction.status.committed')}
          </span>
        ) : null}
        {candidate.status === 'discarded' ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {t('study.extraction.status.discarded')}
          </span>
        ) : null}
      </div>

      {errors.length && draft && content.type !== 'open' ? (
        <ul className="mt-2 space-y-0.5 rounded-md bg-destructive/5 px-3 py-2 pl-7 text-xs text-destructive">
          {errors.map((issue) => (
            <li key={`${issue.path}-${issue.code}`}>{issueText(issue)}</li>
          ))}
        </ul>
      ) : null}

      {suggestion && draft ? (
        <div
          className="mt-2.5 space-y-1.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm"
          data-testid="candidate-suggestion"
        >
          <p className="text-xs text-amber-800 dark:text-amber-300">
            {t('study.extraction.suggestion', { model: suggestion.modelString })}
          </p>
          {suggestion.stem && suggestion.stem !== content.stem ? (
            <div className="text-foreground">
              <MathText text={suggestion.stem} allowDisplayMode />
            </div>
          ) : null}
          {suggestion.options?.length &&
          JSON.stringify(suggestion.options) !== JSON.stringify(content.options) ? (
            <div className="grid gap-0.5 text-muted-foreground">
              {suggestion.options.map((option) => (
                <p key={option.value}>
                  {option.value}. <MathText text={option.label} />
                </p>
              ))}
            </div>
          ) : null}
          <p className="text-foreground">
            {suggestion.answer.length
              ? t('study.extraction.suggestedAnswer', { answer: suggestion.answer.join('') })
              : t('study.extraction.noSuggestedAnswer')}
          </p>
          {suggestion.explanation ? (
            <p className="text-xs text-muted-foreground">
              <MathText text={suggestion.explanation} />
            </p>
          ) : null}
          {editable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={props.busy}
              onClick={props.onAdopt}
              data-testid="candidate-adopt"
            >
              {t('study.extraction.adopt')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-2.5 pl-7">
        {editable && content.type !== 'open' ? (
          <label className="mr-2 flex items-center gap-1.5 text-xs text-foreground">
            <Checkbox
              checked={candidate.checked}
              disabled={props.busy || content.answer.length === 0}
              onCheckedChange={(value) => props.onCheck(value === true)}
              data-testid="candidate-checked"
            />
            {t('study.extraction.checked')}
          </label>
        ) : null}
        {editable ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              disabled={props.busy}
              onClick={props.onEdit}
              data-testid="candidate-edit"
            >
              <Pencil className="mr-1 size-3.5" />
              {t('study.extraction.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              disabled={props.busy}
              onClick={props.onMerge}
              data-testid="candidate-merge"
            >
              <Combine className="mr-1 size-3.5" />
              {t('study.extraction.merge')}
            </Button>
            {candidate.edited ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-8"
                disabled={props.busy}
                onClick={props.onRestore}
              >
                <RotateCcw className="mr-1 size-3.5" />
                {t('study.extraction.restore')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              disabled={props.busy}
              onClick={() => props.onStatus('discarded')}
              data-testid="candidate-discard"
            >
              <Trash2 className="mr-1 size-3.5" />
              {t('study.extraction.discard')}
            </Button>
            {isCommittable(content) ? (
              <Button
                size="sm"
                className="ml-auto h-8"
                disabled={props.busy}
                onClick={props.onCommit}
                data-testid="candidate-commit"
              >
                {props.working ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
                {t('study.extraction.commitOne')}
              </Button>
            ) : null}
          </>
        ) : null}
        {candidate.status === 'discarded' && props.writable ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            disabled={props.busy}
            onClick={() => props.onStatus('draft')}
          >
            <Undo2 className="mr-1 size-3.5" />
            {t('study.extraction.undiscard')}
          </Button>
        ) : null}
        {draft && content.type === 'open' ? (
          <span className="text-[11px] text-muted-foreground">
            {t('study.extraction.openHint')}
          </span>
        ) : null}
      </div>
    </li>
  );
}
