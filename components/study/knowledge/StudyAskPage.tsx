'use client';

/**
 * /study/[spaceId]/ask — questions over the space's materials with cited
 * answers (learning plan B03). Left: question, the current answer and saved
 * answers. Right: which materials are searchable (index state per version,
 * build/rebuild/retry/remove) and which versions a question is pinned to.
 *
 * An answer is shown in three parts that are never mixed: "From your
 * materials" (each claim with its passages; a passage opens the exact version,
 * page and block in the reader), "Additional explanation" (model knowledge,
 * not from the materials) and "Not found in your materials". With nothing
 * indexed a question can still be asked: the answer is only the model's
 * explanation, without the "not found" part.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  BookOpenCheck,
  ChevronLeft,
  CircleAlert,
  FileSearch,
  LoaderCircle,
  RefreshCw,
  Search,
  Send,
  Square,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { useI18n } from '@/lib/hooks/use-i18n';
import { StudyApiError, fetchStudyCapabilities, studyApi } from '@/lib/study/spaces/client';
import { knowledgeApi, rememberCitationQuote } from '@/lib/study/knowledge/client';
import {
  STUDY_QA_LIMITS,
  citationReaderHref,
  type StudyAnswerCitation,
  type StudyAnswerView,
  type StudyIndexState,
  type StudyKnowledgeStatus,
  type StudyKnowledgeVersionView,
  type StudyRetrievalKind,
  type StudySearchResult,
} from '@/lib/study/knowledge/contracts';

type Busy = null | 'ask' | 'search';

export function StudyAskPage({ spaceId }: { spaceId: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [spaceName, setSpaceName] = useState('');
  const [status, setStatus] = useState<StudyKnowledgeStatus | null>(null);
  const [answers, setAnswers] = useState<StudyAnswerView[]>([]);
  const [question, setQuestion] = useState('');
  const [pinned, setPinned] = useState<string[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [search, setSearch] = useState<StudySearchResult | null>(null);
  const [current, setCurrent] = useState<StudyAnswerView | null>(null);
  const [building, setBuilding] = useState<Set<string>>(new Set());
  const controller = useRef<AbortController | null>(null);

  const refreshStatus = useCallback(
    () =>
      knowledgeApi
        .status(spaceId)
        .then(setStatus)
        .catch(() => undefined),
    [spaceId],
  );

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      if (!(await fetchStudyCapabilities()).qa) {
        throw Object.assign(new Error('unavailable'), { status: 404 });
      }
      const [space, knowledge, saved] = await Promise.all([
        studyApi.getSpace(spaceId),
        knowledgeApi.status(spaceId),
        knowledgeApi.answers(spaceId),
      ]);
      return { space, knowledge, saved };
    }).then((result) => {
      if (cancelled) return;
      if (result.state !== 'ready') {
        setState(result.state);
        return;
      }
      setSpaceName(result.data.space.name);
      setStatus(result.data.knowledge);
      setAnswers(result.data.saved);
      setState('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  const indexing = status?.materials.some((material) =>
    material.versions.some((version) => version.state === 'indexing'),
  );
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(() => void refreshStatus(), 3000);
    return () => clearInterval(timer);
  }, [indexing, refreshStatus]);

  useEffect(() => () => controller.current?.abort(), []);

  const searchable = useMemo(
    () =>
      status?.materials.flatMap((material) =>
        material.versions
          .filter((version) => version.index && version.state !== 'not_parsed')
          .map((version) => ({ material, version })),
      ) ?? [],
    [status],
  );
  const currentSearchable = searchable.filter(({ version }) => version.isCurrent).length;

  async function build(targets: Array<{ materialId: string; versionId: string }>) {
    setBuilding((prev) => new Set([...prev, ...targets.map((target) => target.versionId)]));
    try {
      const results = await knowledgeApi.build(spaceId, targets);
      const failed = results.filter((result) => result.error);
      if (failed.length > 0) toast.error(qaError(t, failed[0]!.error!));
      await refreshStatus();
    } catch (error) {
      toast.error(qaError(t, error instanceof StudyApiError ? error.code : ''));
    } finally {
      setBuilding((prev) => {
        const next = new Set(prev);
        for (const target of targets) next.delete(target.versionId);
        return next;
      });
    }
  }

  async function removeIndex(materialId: string, versionId: string) {
    try {
      await knowledgeApi.removeIndex(materialId, versionId);
      setPinned((prev) => prev.filter((id) => id !== versionId));
      await refreshStatus();
    } catch (error) {
      toast.error(qaError(t, error instanceof StudyApiError ? error.code : ''));
    }
  }

  async function submit(mode: 'ask' | 'search') {
    const text = question.trim();
    if (!text || busy) return;
    const next = new AbortController();
    controller.current = next;
    setBusy(mode);
    setSearch(null);
    try {
      if (mode === 'ask') {
        const answer = await knowledgeApi.ask(spaceId, text, pinned, next.signal);
        setCurrent(answer);
        setAnswers((prev) => [answer, ...prev.filter((item) => item.answerId !== answer.answerId)]);
      } else {
        setCurrent(null);
        setSearch(await knowledgeApi.search(spaceId, text, pinned, next.signal));
      }
    } catch (error) {
      if (next.signal.aborted) {
        toast.message(t('study.qa.cancelled'));
      } else {
        toast.error(qaError(t, error instanceof StudyApiError ? error.code : ''));
      }
    } finally {
      if (controller.current === next) controller.current = null;
      setBusy(null);
    }
  }

  async function removeAnswer(answerId: string) {
    try {
      await knowledgeApi.removeAnswer(spaceId, answerId);
      setAnswers((prev) => prev.filter((answer) => answer.answerId !== answerId));
      if (current?.answerId === answerId) setCurrent(null);
    } catch {
      toast.error(t('study.errors.generic'));
    }
  }

  if (state !== 'ready' || !status) {
    return (
      <StudyShell>
        <StudyStatus state={state === 'ready' ? 'loading' : state} />
      </StudyShell>
    );
  }

  // Asking works without materials (the model answers alone); search needs an index.
  const canAsk = status.available;
  const canSearch = canAsk && currentSearchable + pinned.length > 0;
  const history = answers.filter((answer) => answer.answerId !== current?.answerId);

  return (
    <StudyShell>
      <Link
        href={`/study/${encodeURIComponent(spaceId)}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t('study.qa.backToSpace', { name: spaceName })}
      </Link>
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold text-foreground md:text-3xl">
          {t('study.qa.title')}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t('study.qa.subtitle')}</p>
      </header>

      {!status.available || status.reason ? (
        <div
          data-testid="study-qa-unavailable"
          className="mb-5 flex items-start gap-2 rounded-xl border border-review/30 bg-review-soft/60 px-4 py-3 text-sm text-foreground"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-review-ink" />
          <span>{t(`study.qa.reason.${status.reason ?? 'STORAGE_UNAVAILABLE'}`)}</span>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-5">
          <form
            className="rounded-2xl border border-border bg-card p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit('ask');
            }}
          >
            <label htmlFor="study-qa-question" className="sr-only">
              {t('study.qa.questionLabel')}
            </label>
            <Textarea
              id="study-qa-question"
              data-testid="study-qa-question"
              value={question}
              maxLength={STUDY_QA_LIMITS.maxQuestionChars}
              rows={3}
              placeholder={t('study.qa.placeholder')}
              disabled={busy !== null}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit('ask');
                }
              }}
            />
            {pinned.length > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="study-qa-pinned">
                {t('study.qa.pinnedScope', { count: pinned.length })}{' '}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => setPinned([])}
                >
                  {t('study.qa.clearPins')}
                </button>
              </p>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="study-qa-scope">
                {currentSearchable > 0
                  ? t('study.qa.defaultScope', { count: currentSearchable })
                  : t('study.qa.noScope')}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              {busy ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => controller.current?.abort()}
                  data-testid="study-qa-cancel"
                >
                  <Square className="mr-1 size-4" />
                  {t('study.qa.cancel')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={!canSearch || busy !== null || !question.trim()}
                onClick={() => void submit('search')}
                data-testid="study-qa-search"
              >
                {busy === 'search' ? (
                  <LoaderCircle className="mr-1 size-4 animate-spin" />
                ) : (
                  <Search className="mr-1 size-4" />
                )}
                {t('study.qa.searchOnly')}
              </Button>
              <Button
                type="submit"
                disabled={!canAsk || busy !== null || !question.trim()}
                data-testid="study-qa-ask"
              >
                {busy === 'ask' ? (
                  <LoaderCircle className="mr-1 size-4 animate-spin" />
                ) : (
                  <Send className="mr-1 size-4" />
                )}
                {busy === 'ask' ? t('study.qa.asking') : t('study.qa.ask')}
              </Button>
            </div>
          </form>

          {search ? <SearchResults result={search} /> : null}
          {current ? <AnswerCard answer={current} onRemove={removeAnswer} highlight /> : null}

          {history.length > 0 ? (
            <section>
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                {t('study.qa.history')}
              </h2>
              <div className="space-y-4">
                {history.map((answer) => (
                  <AnswerCard key={answer.answerId} answer={answer} onRemove={removeAnswer} />
                ))}
              </div>
            </section>
          ) : !current && !search ? (
            <p className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
              {currentSearchable > 0 ? t('study.qa.emptyHistory') : t('study.qa.noIndexYet')}
            </p>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-3" data-testid="study-qa-sources">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-foreground">{t('study.qa.sources')}</h2>
            <Button
              size="sm"
              variant="outline"
              disabled={!status.available || status.reason === 'WORKER_UNAVAILABLE'}
              data-testid="study-qa-build-all"
              onClick={() =>
                void build(
                  status.materials.flatMap((material) =>
                    material.versions
                      .filter(
                        (version) =>
                          version.isCurrent &&
                          ['not_indexed', 'stale', 'failed'].includes(version.state),
                      )
                      .map((version) => ({
                        materialId: material.materialId,
                        versionId: version.versionId,
                      })),
                  ),
                )
              }
            >
              <BookOpenCheck className="mr-1 size-4" />
              {t('study.qa.buildAll')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="study-qa-retrieval-mode">
            {status.embeddingModel
              ? t('study.qa.embeddingModel', { model: status.embeddingModel })
              : t('study.qa.keywordMode')}
          </p>
          {status.materials.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
              {t('study.qa.noMaterials')}
            </p>
          ) : (
            status.materials.map((material) => (
              <div
                key={material.materialId}
                className="rounded-xl border border-border bg-card p-3"
                data-testid="study-qa-material"
              >
                <Link
                  href={`/study/materials/${encodeURIComponent(material.materialId)}`}
                  className="block truncate text-sm font-medium text-foreground hover:underline"
                >
                  {material.title}
                </Link>
                <ul className="mt-2 space-y-2">
                  {material.versions.map((version) => (
                    <VersionRow
                      key={version.versionId}
                      version={version}
                      busy={building.has(version.versionId)}
                      canBuild={status.available && status.reason !== 'WORKER_UNAVAILABLE'}
                      pinned={pinned.includes(version.versionId)}
                      onPin={(on) =>
                        setPinned((prev) =>
                          on
                            ? [...prev, version.versionId].slice(
                                0,
                                STUDY_QA_LIMITS.maxPinnedVersions,
                              )
                            : prev.filter((id) => id !== version.versionId),
                        )
                      }
                      onBuild={() =>
                        void build([
                          { materialId: material.materialId, versionId: version.versionId },
                        ])
                      }
                      onRemove={() => void removeIndex(material.materialId, version.versionId)}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
        </aside>
      </div>
    </StudyShell>
  );
}

function qaError(t: (key: string, values?: Record<string, unknown>) => string, code: string) {
  const known = [
    'STUDY_QA_UNAVAILABLE',
    'STUDY_QA_NOT_INDEXED',
    'STUDY_QA_INVALID_SCOPE',
    'STUDY_QA_RATE_LIMITED',
    'STUDY_QA_ANSWER_INVALID',
    'STUDY_QA_MODEL_UNAVAILABLE',
    'STUDY_INDEX_QUOTA_EXCEEDED',
    'STUDY_TASKS_UNAVAILABLE',
    'STUDY_MATERIAL_NOT_PARSED',
    'HEAVY_TASK_PERSONAL_CAPACITY_LIMIT',
    'HEAVY_TASK_SITE_CAPACITY_LIMIT',
  ];
  return known.includes(code) ? t(`study.qa.errors.${code}`) : t('study.errors.generic');
}

const RETRIEVAL_LABEL: Record<StudyRetrievalKind, string> = {
  keyword: 'study.qa.keyword',
  hybrid: 'study.qa.hybrid',
  lexical: 'study.qa.lexicalOnly',
  none: 'study.qa.noRetrieval',
};

const STATE_TONE: Record<StudyIndexState, string> = {
  not_parsed: 'bg-muted text-muted-foreground',
  not_indexed: 'bg-muted text-muted-foreground',
  indexing: 'bg-primary/10 text-primary',
  ready: 'bg-correct-soft text-correct-ink',
  stale: 'bg-review-soft text-review-ink',
  failed: 'bg-destructive/10 text-destructive',
};

function VersionRow({
  version,
  busy,
  canBuild,
  pinned,
  onPin,
  onBuild,
  onRemove,
}: {
  version: StudyKnowledgeVersionView;
  busy: boolean;
  canBuild: boolean;
  pinned: boolean;
  onPin: (on: boolean) => void;
  onBuild: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const action =
    version.state === 'not_indexed'
      ? t('study.qa.build')
      : version.state === 'stale'
        ? t('study.qa.rebuild')
        : version.state === 'failed'
          ? t('study.qa.retryBuild')
          : null;
  return (
    <li
      className="text-xs"
      data-testid="study-qa-version"
      data-state={version.state}
      data-version-no={version.versionNo}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-foreground">
          {t('study.materials.versionLabel', { n: version.versionNo })}
        </span>
        {version.isCurrent ? (
          <span className="text-muted-foreground">{t('study.materials.currentVersion')}</span>
        ) : null}
        <span className={`rounded-full px-1.5 py-0.5 ${STATE_TONE[version.state]}`}>
          {version.state === 'indexing' ? (
            <LoaderCircle className="mr-0.5 inline size-3 animate-spin" />
          ) : null}
          {t(`study.qa.state.${version.state}`)}
        </span>
      </div>
      {version.index ? (
        <p className="mt-1 text-muted-foreground">
          {t('study.qa.chunkCount', { count: version.index.chunkCount })}
          {version.index.unparsedPages.length > 0
            ? ` · ${t('study.qa.unparsedPages', {
                pages: version.index.unparsedPages.slice(0, 8).join(', '),
              })}`
            : ''}
        </p>
      ) : null}
      {version.state === 'failed' && version.task?.lastErrorCode ? (
        <p className="mt-1 text-destructive">
          {t('study.qa.buildFailed', { code: version.task.lastErrorCode })}
        </p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {version.index ? (
          <label className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={pinned}
              onChange={(event) => onPin(event.target.checked)}
              data-testid="study-qa-pin"
            />
            {t('study.qa.pin')}
          </label>
        ) : null}
        {action ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50"
            disabled={!canBuild || busy}
            onClick={onBuild}
            data-testid="study-qa-build"
          >
            {busy ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {action}
          </button>
        ) : null}
        {version.index && version.state !== 'indexing' ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 className="size-3" />
            {t('study.qa.removeIndex')}
          </button>
        ) : null}
        {version.state === 'not_parsed' ? (
          <span className="text-muted-foreground">{t('study.qa.parseFirst')}</span>
        ) : null}
      </div>
    </li>
  );
}

function CitationChip({ citation }: { citation: StudyAnswerCitation }) {
  const { t } = useI18n();
  if (citation.sourceDeleted) {
    return (
      <span
        className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
        data-testid="study-qa-citation-deleted"
      >
        [{citation.ref}] {t('study.qa.sourceDeleted')}
      </span>
    );
  }
  return (
    <Link
      href={citationReaderHref(citation)}
      onClick={() => rememberCitationQuote(citation.blockId, citation.quote)}
      className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20"
      data-testid="study-qa-citation"
      title={citation.quote}
    >
      [{citation.ref}] {citationLabel(t, citation)}
    </Link>
  );
}

function citationLabel(
  t: (key: string, values?: Record<string, unknown>) => string,
  citation: StudyAnswerCitation,
) {
  return [
    citation.materialTitle,
    citation.versionNo !== null
      ? t('study.materials.versionLabel', { n: citation.versionNo })
      : null,
    citation.pageNumber ? t('study.qa.page', { n: citation.pageNumber }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function AnswerCard({
  answer,
  onRemove,
  highlight = false,
}: {
  answer: StudyAnswerView;
  onRemove: (answerId: string) => void;
  highlight?: boolean;
}) {
  const { t } = useI18n();
  const byRef = new Map(answer.citations.map((citation) => [citation.ref, citation]));
  const grounded = answer.segments.filter((segment) => segment.kind === 'grounded');
  const supplement = answer.segments.filter((segment) => segment.kind === 'supplement');
  return (
    <article
      className={`rounded-2xl border bg-card p-4 ${highlight ? 'border-primary/40' : 'border-border'}`}
      data-testid="study-qa-answer"
      data-status={answer.status}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{answer.question}</h3>
        <button
          type="button"
          aria-label={t('study.qa.removeAnswer')}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => onRemove(answer.answerId)}
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      {grounded.length > 0 ? (
        <section className="mb-3" data-testid="study-qa-grounded">
          <h4 className="mb-1.5 text-xs font-semibold text-correct-ink">
            {t('study.qa.grounded')}
          </h4>
          <div className="space-y-2">
            {grounded.map((segment, index) => (
              <div key={index}>
                <p className="whitespace-pre-wrap text-sm leading-7 text-foreground">
                  {segment.text}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {segment.kind === 'grounded'
                    ? segment.citations.map((ref) => {
                        const citation = byRef.get(ref);
                        return citation ? <CitationChip key={ref} citation={citation} /> : null;
                      })
                    : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {answer.status === 'not_found' && answer.retrieval !== 'none' ? (
        <section className="mb-3 rounded-xl bg-muted/60 px-3 py-2" data-testid="study-qa-not-found">
          <h4 className="flex items-center gap-1 text-xs font-semibold text-foreground">
            <FileSearch className="size-3.5" />
            {t('study.qa.notFound')}
          </h4>
          <p className="mt-1 text-sm text-muted-foreground">
            {answer.notFoundNote ?? t('study.qa.notFoundDefault')}
          </p>
        </section>
      ) : null}

      {supplement.length > 0 ? (
        <section className="mb-3" data-testid="study-qa-supplement">
          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">
            {t(answer.retrieval === 'none' ? 'study.qa.modelAnswer' : 'study.qa.supplement')}
          </h4>
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            {t(
              answer.retrieval === 'none' ? 'study.qa.modelAnswerHint' : 'study.qa.supplementHint',
            )}
          </p>
          {supplement.map((segment, index) => (
            <p
              key={index}
              className="whitespace-pre-wrap border-l-2 border-border pl-3 text-sm leading-7 text-muted-foreground"
            >
              {segment.text}
            </p>
          ))}
        </section>
      ) : null}

      {answer.citations.filter((citation) => !citation.sourceDeleted).length > 0 ? (
        <details className="mb-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {t('study.qa.passages', { count: answer.citations.length })}
          </summary>
          <ul className="mt-2 space-y-2">
            {answer.citations
              .filter((citation) => !citation.sourceDeleted)
              .map((citation) => (
                <li key={citation.ref} className="rounded-lg bg-muted/50 p-2">
                  <CitationChip citation={citation} />
                  {!citation.isCurrentVersion ? (
                    <span className="ml-1 text-review-ink">{t('study.qa.notCurrentVersion')}</span>
                  ) : null}
                  <p className="mt-1 text-muted-foreground">{citation.quote}</p>
                </li>
              ))}
          </ul>
        </details>
      ) : null}

      <p className="text-[11px] text-muted-foreground" data-testid="study-qa-answer-meta">
        {t(RETRIEVAL_LABEL[answer.retrieval])}
        {answer.modelString ? ` · ${answer.modelString}` : ''}
        {answer.usage
          ? ` · ${t('study.qa.usage', {
              input: answer.usage.inputTokens,
              output: answer.usage.outputTokens,
              calls: answer.usage.modelCalls,
            })}`
          : ''}
        {answer.usageCompleteness === 'partial' || answer.usageCompleteness === 'unknown'
          ? ` · ${t('study.qa.usageUnknown')}`
          : ''}
      </p>
    </article>
  );
}

function SearchResults({ result }: { result: StudySearchResult }) {
  const { t } = useI18n();
  return (
    <section
      className="rounded-2xl border border-border bg-card p-4"
      data-testid="study-qa-results"
    >
      <h3 className="mb-1 text-sm font-medium text-foreground">{t('study.qa.searchResults')}</h3>
      <p className="mb-3 text-[11px] text-muted-foreground">
        {t(RETRIEVAL_LABEL[result.retrieval])}
      </p>
      {result.hits.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('study.qa.noHits')}</p>
      ) : (
        <ul className="space-y-2">
          {result.hits.map((hit) => (
            <li
              key={`${hit.versionId}:${hit.chunkId}`}
              className="rounded-lg bg-muted/50 p-2 text-xs"
            >
              <Link
                href={citationReaderHref(hit)}
                onClick={() => rememberCitationQuote(hit.blockId, hit.excerpt)}
                className="font-medium text-primary hover:underline"
              >
                {[
                  hit.materialTitle,
                  t('study.materials.versionLabel', { n: hit.versionNo }),
                  hit.pageNumber ? t('study.qa.page', { n: hit.pageNumber }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Link>
              <span className="ml-2 text-muted-foreground">
                {t(`study.qa.method.${hit.method}`)}
              </span>
              <p className="mt-1 text-muted-foreground">{hit.excerpt}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
