'use client';

/**
 * /study/[spaceId]/wrongbook — the space's wrong-answer book (learning plan
 * B10): mistakes from submitted subject papers, classroom quizzes and
 * learning checks in one list.
 *
 * - Opening the page asks the server to bring the list up to date (bounded,
 *   throttled, never duplicating), then reads it. Items still being graded
 *   never appear.
 * - Filters: open / to review / archived, source, knowledge point, time.
 * - An item opens in place: the question as it was asked, the student's
 *   answer and the grading it got, the explanation, every earlier answer,
 *   then the way back — the paper's report, the material page, or the
 *   classroom page (offered only while it still shows the same content) —
 *   and asking a classmate, whose chat carries the question.
 * - Marking for review and archiving are the student's own; the order
 *   stays by the latest mistake (automatic review planning comes later).
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ClipboardList,
  FileText,
  History,
  LoaderCircle,
  MessageCircleQuestion,
  RefreshCw,
  Shuffle,
  Star,
} from 'lucide-react';
import { toast } from 'sonner';

import { QuizMathText } from '@/components/quiz/QuizMathText';
import {
  MathText,
  QuestionFigures,
  SourceDetails,
  TypeChip,
  useCriterionLabel,
} from '@/components/study/exams/exam-format';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { RelativeTime } from '@/components/study/spaces/study-format';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { classmateApi } from '@/lib/study/classmates/client';
import type { ClassmateView } from '@/lib/study/classmates/contracts';
import { readerHref } from '@/lib/study/materials/client';
import { StudyApiError, fetchStudyCapabilities, studyApi } from '@/lib/study/spaces/client';
import { resumeHref } from '@/lib/study/spaces/view-model';
import { classroomSceneHref, wrongItemChatHref, wrongbookApi } from '@/lib/study/wrongbook/client';
import type {
  WrongItemDetail,
  WrongItemSummary,
  WrongLookBack,
  WrongOccurrenceView,
  WrongOutcome,
  WrongSourceType,
  WrongbookFilter,
  WrongbookPage as WrongbookPageData,
  WrongbookSyncResult,
} from '@/lib/study/wrongbook/contracts';
import { cn } from '@/lib/utils';
import { GenerationPanel } from '@/components/study/practice/GenerationPanel';
import { PracticeChips } from '@/components/study/practice/PracticeHelp';
import { newRequestKey } from '@/components/study/exams/exam-format';
import { practiceApi } from '@/lib/study/practice/client';
import { PRACTICE_LIMITS, callCapFor } from '@/lib/study/practice/contracts';

const CHIP = 'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px]';
const SELECT = 'h-8 rounded-md border border-border bg-background px-2 text-sm';

/**
 * The concept filter's "everything" option. Stored knowledge points are
 * trimmed, so one never starts with a space; '' is "no knowledge point".
 */
const ALL_CONCEPTS = ' all';

const DEFAULT_FILTER: WrongbookFilter = {
  state: 'active',
  source: null,
  concept: null,
  since: 'all',
  offset: 0,
};

/** Paper text treats `$…$` as formulas; model-written classroom text may use `$` for money. */
function QText({ text, trusted, block }: { text: string; trusted: boolean; block?: boolean }) {
  return trusted ? (
    <MathText text={text} allowDisplayMode={block} />
  ) : (
    <QuizMathText text={text} allowDisplayMode={block} />
  );
}

export function WrongbookPage({ spaceId }: { spaceId: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [spaceName, setSpaceName] = useState('');
  const [chatOn, setChatOn] = useState(false);
  const [practiceOn, setPracticeOn] = useState(false);
  const [filter, setFilter] = useState<WrongbookFilter>(DEFAULT_FILTER);
  const [data, setData] = useState<WrongbookPageData | null>(null);
  const [listing, setListing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [sync, setSync] = useState<WrongbookSyncResult | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchStudyCapabilities().then((capabilities) => {
      if (!cancelled) {
        setChatOn(capabilities.companionChat);
        setPracticeOn(capabilities.practice);
      }
    });
    void loadStudyPage(async () => {
      const capabilities = await fetchStudyCapabilities();
      if (!capabilities.wrongbook) throw new StudyApiError(404, 'STUDY_NOT_AVAILABLE', null);
      const space = await studyApi.getSpace(spaceId);
      const synced = await wrongbookApi.sync(spaceId).catch(() => null);
      return { space, synced };
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') {
        setSpaceName(result.data.space.name);
        setSync(result.data.synced);
      }
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, loadKey]);

  const load = useCallback(
    async (next: WrongbookFilter, append: boolean) => {
      setListing(true);
      try {
        const page = await wrongbookApi.list(spaceId, next);
        setData((previous) =>
          append && previous ? { ...page, items: [...previous.items, ...page.items] } : page,
        );
      } catch {
        toast.error(t('study.errors.generic'));
      } finally {
        setListing(false);
      }
    },
    [spaceId, t],
  );

  useEffect(() => {
    if (state === 'ready') void load(filter, filter.offset > 0);
  }, [state, filter, load]);

  async function refresh() {
    setSyncing(true);
    try {
      setSync(await wrongbookApi.sync(spaceId, true));
      setOpenId(null);
      setFilter((current) => ({ ...current, offset: 0 }));
      await load({ ...filter, offset: 0 }, false);
    } catch {
      toast.error(t('study.errors.generic'));
    } finally {
      setSyncing(false);
    }
  }

  function change(patch: Partial<WrongbookFilter>) {
    setOpenId(null);
    setFilter((current) => ({ ...current, ...patch, offset: 0 }));
  }

  /** After marking or archiving: update the row, and drop it when it left the current view. */
  function applyState(item: WrongItemSummary) {
    setData((current) => {
      if (!current) return current;
      const leaves =
        (filter.state === 'archived' && !item.archived) ||
        (filter.state !== 'archived' && item.archived) ||
        (filter.state === 'to_review' && item.reviewState !== 'to_review');
      const states = { ...current.facets.states };
      const before = current.items.find((candidate) => candidate.id === item.id);
      if (before) {
        if (before.archived !== item.archived) {
          states.archived += item.archived ? 1 : -1;
          states.active += item.archived ? -1 : 1;
        }
        const wasReview = !before.archived && before.reviewState === 'to_review';
        const isReview = !item.archived && item.reviewState === 'to_review';
        if (wasReview !== isReview) states.toReview += isReview ? 1 : -1;
      }
      return {
        ...current,
        total: leaves ? current.total - 1 : current.total,
        items: leaves
          ? current.items.filter((candidate) => candidate.id !== item.id)
          : current.items.map((candidate) => (candidate.id === item.id ? item : candidate)),
        facets: { ...current.facets, states },
      };
    });
  }

  if (state !== 'ready') {
    return (
      <StudyShell>
        <StudyStatus
          state={state}
          onRetry={() => {
            setState('loading');
            setLoadKey((key) => key + 1);
          }}
        />
      </StudyShell>
    );
  }

  const facets = data?.facets;
  return (
    <StudyShell>
      <Link
        href={`/study/${encodeURIComponent(spaceId)}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {spaceName || t('study.backToSpaces')}
      </Link>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground md:text-3xl">
            {t('study.wrongbook.title')}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            {t('study.wrongbook.subtitle')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={syncing}
          onClick={() => void refresh()}
          data-testid="wrongbook-refresh"
        >
          <RefreshCw className={cn('mr-1 size-4', syncing && 'animate-spin')} />
          {t('study.wrongbook.refresh')}
        </Button>
      </header>

      <SyncNotes sync={sync} />

      <div
        className="mb-3 flex flex-wrap gap-1.5"
        role="group"
        aria-label={t('study.wrongbook.stateLabel')}
      >
        {(['active', 'to_review', 'archived'] as const).map((value) => {
          const count =
            value === 'active'
              ? facets?.states.active
              : value === 'to_review'
                ? facets?.states.toReview
                : facets?.states.archived;
          return (
            <Button
              key={value}
              size="sm"
              variant={filter.state === value ? 'default' : 'outline'}
              aria-pressed={filter.state === value}
              onClick={() => change({ state: value })}
              data-testid={`wrongbook-state-${value}`}
            >
              {t(`study.wrongbook.state.${value}`)}
              {count !== undefined ? <span className="ml-1 opacity-70">{count}</span> : null}
            </Button>
          );
        })}
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <select
          value={filter.source ?? ''}
          onChange={(event) =>
            change({ source: (event.target.value || null) as WrongSourceType | null })
          }
          className={SELECT}
          aria-label={t('study.wrongbook.filter.source')}
          data-testid="wrongbook-source"
        >
          <option value="">{t('study.wrongbook.filter.allSources')}</option>
          {(['exam_attempt', 'quiz_attempt', 'learning_check'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`study.wrongbook.source.${value}`)}
              {facets ? ` (${facets.sources[value]})` : ''}
            </option>
          ))}
        </select>
        <select
          value={filter.concept === null ? ALL_CONCEPTS : filter.concept}
          onChange={(event) =>
            change({ concept: event.target.value === ALL_CONCEPTS ? null : event.target.value })
          }
          className={cn(SELECT, 'max-w-[14rem]')}
          aria-label={t('study.wrongbook.filter.concept')}
          data-testid="wrongbook-concept"
        >
          <option value={ALL_CONCEPTS}>{t('study.wrongbook.filter.allConcepts')}</option>
          {facets?.concepts.map((concept) => (
            <option key={concept.name} value={concept.name}>
              {concept.name} ({concept.count})
            </option>
          ))}
          {facets?.unlinked ? (
            <option value="">
              {t('study.wrongbook.filter.unlinked')} ({facets.unlinked})
            </option>
          ) : null}
        </select>
        <select
          value={filter.since}
          onChange={(event) => change({ since: event.target.value as WrongbookFilter['since'] })}
          className={SELECT}
          aria-label={t('study.wrongbook.filter.since')}
          data-testid="wrongbook-since"
        >
          {(['all', '30d', '7d'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`study.wrongbook.since.${value}`)}
            </option>
          ))}
        </select>
        {listing ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" /> : null}
      </div>

      {!data ? (
        <div className="flex justify-center py-16">
          <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : data.items.length === 0 ? (
        <p
          className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground"
          data-testid="wrongbook-empty"
        >
          {filter.state === 'active' &&
          !filter.source &&
          filter.concept === null &&
          filter.since === 'all'
            ? t('study.wrongbook.empty')
            : t('study.wrongbook.emptyFiltered')}
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground" data-testid="wrongbook-total">
            {t('study.wrongbook.total', { count: data.total })}
          </p>
          <ol className="space-y-3">
            {data.items.map((item) => (
              <WrongItemCard
                key={item.id}
                item={item}
                spaceId={spaceId}
                open={openId === item.id}
                chatOn={chatOn}
                practiceOn={practiceOn}
                onToggle={() => setOpenId((current) => (current === item.id ? null : item.id))}
                onState={applyState}
              />
            ))}
          </ol>
          {data.nextOffset !== null ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={listing}
                onClick={() => setFilter((current) => ({ ...current, offset: data.nextOffset! }))}
                data-testid="wrongbook-more"
              >
                {t('study.wrongbook.more')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </StudyShell>
  );
}

function SyncNotes({ sync }: { sync: WrongbookSyncResult | null }) {
  const { t } = useI18n();
  if (!sync) {
    return null;
  }
  const notes = [
    sync.failed.length
      ? t('study.wrongbook.sync.failed', {
          sources: sync.failed.map((source) => t(`study.wrongbook.source.${source}`)).join('、'),
        })
      : null,
    sync.legacy ? t('study.wrongbook.sync.legacy', { count: sync.legacy }) : null,
    sync.full ? t('study.wrongbook.sync.full') : null,
  ].filter(Boolean);
  if (notes.length === 0) return null;
  return (
    <div
      className="mb-4 space-y-1 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
      data-testid="wrongbook-sync-notes"
    >
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );
}

function OutcomeChip({
  outcome,
  earned,
  points,
}: {
  outcome: WrongOutcome;
  earned: number;
  points: number;
}) {
  const { t } = useI18n();
  return (
    <span
      data-testid="wrongbook-outcome"
      className={cn(
        CHIP,
        outcome === 'correct' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        outcome === 'incorrect' && 'bg-red-500/10 text-red-600 dark:text-red-400',
        outcome === 'partial' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
        outcome === 'unanswered' && 'bg-muted text-muted-foreground',
      )}
    >
      {t(`study.wrongbook.outcome.${outcome}`)} · {earned}/{points}
    </span>
  );
}

function sourceLabel(
  t: (key: string, values?: Record<string, unknown>) => string,
  source: WrongSourceType,
  origin: WrongOccurrenceView['origin'],
): string {
  if (source === 'exam_attempt') {
    return t('study.wrongbook.where.paper', { title: origin.paperTitle ?? '' });
  }
  if (source === 'quiz_attempt') {
    return t('study.wrongbook.where.quiz', { course: origin.courseTitle ?? '' });
  }
  return t(
    origin.checkKind === 'remediation_check'
      ? 'study.wrongbook.where.remediation'
      : 'study.wrongbook.where.check',
    { course: origin.courseTitle ?? '' },
  );
}

function WrongItemCard({
  item,
  spaceId,
  open,
  chatOn,
  practiceOn,
  onToggle,
  onState,
}: {
  item: WrongItemSummary;
  spaceId: string;
  open: boolean;
  chatOn: boolean;
  practiceOn: boolean;
  onToggle: () => void;
  onState: (item: WrongItemSummary) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const trusted = item.sourceType === 'exam_attempt';

  async function update(patch: { reviewState?: 'none' | 'to_review'; archived?: boolean }) {
    setBusy(true);
    try {
      const next = await wrongbookApi.update(item.id, item.revision, patch);
      onState({ ...item, ...next });
      toast.success(
        patch.archived === true
          ? t('study.wrongbook.archived')
          : patch.archived === false
            ? t('study.wrongbook.restored')
            : patch.reviewState === 'to_review'
              ? t('study.wrongbook.marked')
              : t('study.wrongbook.unmarked'),
      );
    } catch (error) {
      if (error instanceof StudyApiError && error.code === 'STUDY_REVISION_CONFLICT') {
        const current = error.body?.current as
          | { revision: number; reviewState: 'none' | 'to_review'; archived: boolean }
          | undefined;
        if (current) onState({ ...item, ...current });
        toast.error(t('study.errors.conflict'));
      } else {
        toast.error(t('study.errors.generic'));
      }
    } finally {
      setBusy(false);
    }
  }

  const review = item.reviewState === 'to_review';
  return (
    <li
      className="rounded-2xl border border-border bg-card"
      data-testid="wrongbook-item"
      data-item-id={item.id}
      data-source={item.sourceType}
    >
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
          data-testid="wrongbook-item-toggle"
        >
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <TypeChip type={item.question.type} subtype={item.question.subtype} />
            <span className={cn(CHIP, 'bg-muted text-muted-foreground')}>
              {sourceLabel(t, item.sourceType, item.latest.origin)}
            </span>
            {item.concepts.length ? (
              item.concepts.slice(0, 3).map((concept) => (
                <span key={concept} className={cn(CHIP, 'bg-primary/10 text-primary')}>
                  {concept}
                </span>
              ))
            ) : (
              <span
                className={cn(CHIP, 'border border-dashed border-border text-muted-foreground')}
              >
                {t('study.wrongbook.filter.unlinked')}
              </span>
            )}
          </div>
          <div className={cn('text-sm leading-6 text-foreground', !open && 'line-clamp-2')}>
            <QText text={item.question.stem} trusted={trusted} />
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{t('study.wrongbook.wrongTimes', { count: item.wrongCount })}</span>
            <span aria-hidden>·</span>
            <span>
              {t('study.wrongbook.lastWrong')} <RelativeTime iso={item.lastWrongAt} />
            </span>
            {item.latest.outcome === 'correct' ? (
              <span
                className={cn(CHIP, 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400')}
              >
                {t('study.wrongbook.laterCorrect')}
              </span>
            ) : null}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            disabled={busy || item.archived}
            aria-pressed={review}
            aria-label={review ? t('study.wrongbook.unmark') : t('study.wrongbook.mark')}
            title={review ? t('study.wrongbook.unmark') : t('study.wrongbook.mark')}
            onClick={() => void update({ reviewState: review ? 'none' : 'to_review' })}
            data-testid="wrongbook-mark"
          >
            <Star className={cn('size-4', review && 'fill-amber-400 text-amber-500')} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            aria-label={item.archived ? t('study.wrongbook.restore') : t('study.wrongbook.archive')}
            title={item.archived ? t('study.wrongbook.restore') : t('study.wrongbook.archive')}
            onClick={() => void update({ archived: !item.archived })}
            data-testid="wrongbook-archive"
          >
            {item.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={open ? t('study.wrongbook.collapse') : t('study.wrongbook.expand')}
            onClick={onToggle}
          >
            {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
        </div>
      </div>
      {open ? (
        <WrongItemBody itemId={item.id} spaceId={spaceId} chatOn={chatOn} practiceOn={practiceOn} />
      ) : null}
    </li>
  );
}

function WrongItemBody({
  itemId,
  spaceId,
  chatOn,
  practiceOn,
}: {
  itemId: string;
  spaceId: string;
  chatOn: boolean;
  practiceOn: boolean;
}) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<WrongItemDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    wrongbookApi
      .get(itemId)
      .then((item) => {
        if (!cancelled) setDetail(item);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  if (failed) {
    return (
      <p className="border-t border-border px-4 py-4 text-sm text-destructive">
        {t('study.errors.generic')}
      </p>
    );
  }
  if (!detail) {
    return (
      <div className="flex justify-center border-t border-border py-6">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const newestWrong = detail.occurrences.find((occurrence) => occurrence.outcome !== 'correct');
  const shown =
    detail.occurrences.find((occurrence) => occurrence.sourceKey === selected) ??
    newestWrong ??
    detail.occurrences[0]!;
  return (
    <div className="space-y-4 border-t border-border px-4 pb-4 pt-3" data-testid="wrongbook-detail">
      <OccurrenceView occurrence={shown} />
      {shown === newestWrong ? <LookBack items={detail.lookBack} spaceId={spaceId} /> : null}
      {chatOn ? (
        <AskClassmate spaceId={spaceId} itemId={itemId} stem={shown.question.stem} />
      ) : null}
      {practiceOn && newestWrong ? (
        <VariantPractice spaceId={spaceId} itemId={itemId} question={newestWrong.question} />
      ) : null}
      {detail.occurrences.length > 1 ? (
        <section data-testid="wrongbook-history">
          <h3 className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <History className="size-3.5" />
            {t('study.wrongbook.history', { count: detail.occurrences.length })}
          </h3>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {detail.occurrences.map((occurrence) => (
              <li key={occurrence.sourceKey}>
                <button
                  type="button"
                  onClick={() => setSelected(occurrence.sourceKey)}
                  aria-current={occurrence === shown}
                  className={cn(
                    'flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs',
                    occurrence === shown ? 'bg-muted/60' : 'hover:bg-muted/40',
                  )}
                >
                  <RelativeTime iso={occurrence.occurredAt} />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {sourceLabel(t, occurrence.sourceType, occurrence.origin)}
                  </span>
                  {occurrence.origin.practice ? (
                    <OccurrencePractice occurrence={occurrence} />
                  ) : null}
                  <OutcomeChip
                    outcome={occurrence.outcome}
                    earned={occurrence.earned}
                    points={occurrence.points}
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function OccurrenceView({ occurrence }: { occurrence: WrongOccurrenceView }) {
  const { t } = useI18n();
  const criterionLabel = useCriterionLabel();
  const { question, response, grading } = occurrence;
  const trusted = occurrence.sourceType === 'exam_attempt';
  const chosen = response && 'choices' in response ? response.choices : [];
  return (
    <section
      className="space-y-3"
      data-testid="wrongbook-occurrence"
      data-outcome={occurrence.outcome}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <OutcomeChip
          outcome={occurrence.outcome}
          earned={occurrence.earned}
          points={occurrence.points}
        />
        <span>{sourceLabel(t, occurrence.sourceType, occurrence.origin)}</span>
        <span aria-hidden>·</span>
        <RelativeTime iso={occurrence.occurredAt} />
        {occurrence.origin.practice ? <OccurrencePractice occurrence={occurrence} /> : null}
      </div>
      <div className="text-sm leading-6 text-foreground">
        <QText text={question.stem} trusted={trusted} block />
        <QuestionFigures figures={question.figures} />
      </div>
      {question.type !== 'short_answer' ? (
        <div className="grid gap-2">
          {question.options.map((option) => {
            const isKey = question.answer.includes(option.value);
            const isChosen = chosen.includes(option.value);
            return (
              <div
                key={option.value}
                className={cn(
                  'flex items-center gap-3 rounded-xl border px-3.5 py-2 text-sm',
                  isKey && 'border-emerald-400/70 bg-emerald-500/5',
                  isChosen && !isKey && 'border-red-300 bg-red-500/5',
                  !isKey && !isChosen && 'border-border text-muted-foreground',
                )}
              >
                <span className="w-5 text-xs font-semibold">{option.value}</span>
                <span className="flex-1">
                  <QText text={option.label} trusted={trusted} />
                </span>
                {isChosen ? (
                  <span className="text-[11px] text-muted-foreground">
                    {t('study.practice.report.yourChoice')}
                  </span>
                ) : null}
              </div>
            );
          })}
          <p className="text-sm text-muted-foreground">
            {t('study.practice.report.key', { answer: question.answer.join(', ') || '—' })}
            {chosen.length === 0 ? ` · ${t('study.wrongbook.noAnswer')}` : ''}
          </p>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="rounded-xl border border-border px-3 py-2">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t('study.wrongbook.yourAnswer')}
            </p>
            {response && 'text' in response ? (
              <>
                <p className="whitespace-pre-wrap text-foreground">{response.text}</p>
                {response.final ? (
                  <p className="mt-1 text-foreground">
                    {t('study.wrongbook.finalAnswer')}
                    <QText text={response.final} trusted={trusted} />
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">{t('study.wrongbook.noAnswer')}</p>
            )}
          </div>
          {question.reference || question.finalAnswer ? (
            <div className="rounded-xl bg-muted/50 px-3 py-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t('study.wrongbook.reference')}
              </p>
              {question.reference ? (
                <QText text={question.reference} trusted={trusted} block />
              ) : null}
              {question.finalAnswer ? (
                <p className="mt-1">
                  {t('study.wrongbook.finalAnswer')}
                  <QText text={question.finalAnswer} trusted={trusted} />
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <div
        className="space-y-1.5 rounded-xl border border-border px-3 py-2 text-sm"
        data-testid="wrongbook-grading"
      >
        <p className="text-xs text-muted-foreground">
          {t(`study.wrongbook.grading.${grading.method}`)}
          {grading.by === 'classroom'
            ? ` · ${grading.checked ? t('study.wrongbook.grading.checked') : t('study.wrongbook.grading.classroom')}`
            : ''}
          {grading.reviewed ? ` · ${t('study.wrongbook.grading.reviewed')}` : ''}
          {grading.model ? ` · ${grading.model}` : ''}
        </p>
        {grading.criteria?.length ? (
          <ul className="space-y-1">
            {grading.criteria.map((criterion) => (
              <li key={criterion.id} className="text-foreground">
                <span className="font-medium">
                  <QText text={criterionLabel(criterion)} trusted={trusted} />：{criterion.awarded}/
                  {criterion.points}
                </span>
                <span className="ml-1 text-[11px] text-muted-foreground">
                  {criterion.by === 'program'
                    ? t('study.practice.report.byProgram')
                    : t('study.practice.report.byModel')}
                </span>
                {criterion.comment ? (
                  <span className="block text-muted-foreground">
                    <QText text={criterion.comment} trusted={trusted} />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {grading.feedback ? (
          <div className="text-foreground">
            <QText text={grading.feedback} trusted={trusted} block />
          </div>
        ) : null}
        {grading.shortcomings?.length ? (
          <ul className="list-disc pl-5 text-muted-foreground">
            {grading.shortcomings.map((item) => (
              <li key={item}>
                <QText text={item} trusted={trusted} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {question.explanation ? (
        <div className="rounded-xl bg-muted/50 px-3 py-2 text-sm">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t('study.wrongbook.explanation')}
          </p>
          <QText text={question.explanation} trusted={trusted} block />
        </div>
      ) : null}
      {question.source ? <SourceDetails source={question.source} /> : null}
      {question.evidence?.length ? (
        <details
          className="rounded-xl border border-border px-3 py-2 text-sm"
          data-testid="wrongbook-evidence"
        >
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            {t('study.wrongbook.evidence', { count: question.evidence.length })}
          </summary>
          <div className="mt-2 space-y-2">
            {question.evidence.map((fragment) => (
              <blockquote
                key={fragment.sceneId}
                className="border-l-2 border-border pl-3 text-muted-foreground"
              >
                <p className="mb-0.5 text-xs font-medium text-foreground">{fragment.sceneTitle}</p>
                <p className="whitespace-pre-wrap text-xs">{fragment.text}</p>
              </blockquote>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function LookBack({ items, spaceId }: { items: WrongLookBack[]; spaceId: string }) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  const link = 'inline-flex items-center gap-1 text-primary hover:underline';
  return (
    <section
      className="rounded-xl border border-border px-3 py-2 text-sm"
      data-testid="wrongbook-lookback"
    >
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">
        {t('study.wrongbook.lookBack.title')}
      </h3>
      <ul className="space-y-1">
        {items.map((target, index) => (
          <li key={`${target.kind}-${index}`} data-kind={target.kind}>
            {target.kind === 'paper' ? (
              <Link
                href={`/study/${encodeURIComponent(spaceId)}/attempts/${encodeURIComponent(target.attemptId)}`}
                className={link}
              >
                <ClipboardList className="size-3.5" />
                {t('study.wrongbook.lookBack.paper', { title: target.title })}
              </Link>
            ) : target.kind === 'material' ? (
              <Link
                href={readerHref(target.materialId, target.versionId, target.page)}
                className={link}
              >
                <FileText className="size-3.5" />
                {t('study.wrongbook.lookBack.material', { title: target.title })}
              </Link>
            ) : target.kind === 'material_gone' ? (
              <span className="text-muted-foreground">
                {t('study.wrongbook.lookBack.materialGone', { title: target.title })}
              </span>
            ) : target.kind === 'scene' ? (
              <Link href={classroomSceneHref(target.stageId, target.sceneId)} className={link}>
                <BookOpen className="size-3.5" />
                {t('study.wrongbook.lookBack.scene', {
                  course: target.courseTitle,
                  page: target.sceneTitle,
                })}
              </Link>
            ) : target.kind === 'scene_changed' ? (
              <span className="text-muted-foreground">
                {t('study.wrongbook.lookBack.sceneChanged', {
                  course: target.courseTitle,
                  page: target.sceneTitle,
                })}{' '}
                <Link href={resumeHref(target.stageId)} className="text-primary hover:underline">
                  {t('study.wrongbook.lookBack.openCourse')}
                </Link>
              </span>
            ) : target.kind === 'scene_missing' ? (
              <span className="text-muted-foreground">
                {t('study.wrongbook.lookBack.sceneMissing', { course: target.courseTitle })}
              </span>
            ) : target.kind === 'course' ? (
              <Link href={resumeHref(target.stageId)} className={link}>
                <BookOpen className="size-3.5" />
                {t('study.wrongbook.lookBack.course', { course: target.courseTitle })}
              </Link>
            ) : (
              <span className="text-muted-foreground">
                {t('study.wrongbook.lookBack.courseGone')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AskClassmate({
  spaceId,
  itemId,
  stem,
}: {
  spaceId: string;
  itemId: string;
  stem: string;
}) {
  const { t } = useI18n();
  const [classmates, setClassmates] = useState<ClassmateView[] | null>(null);
  const [choice, setChoice] = useState('');
  useEffect(() => {
    let cancelled = false;
    classmateApi
      .list('active')
      .then((list) => {
        if (cancelled) return;
        setClassmates(list);
        setChoice(list[0]?.id ?? '');
      })
      .catch(() => {
        if (!cancelled) setClassmates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (classmates === null) return null;
  if (classmates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('study.wrongbook.ask.none')}{' '}
        <Link href="/study/classmates" className="text-primary hover:underline">
          {t('study.wrongbook.ask.create')}
        </Link>
      </p>
    );
  }
  // The question's start, without its own closing punctuation (the sentence adds its own).
  const opening = Array.from(stem.replace(/\s+/gu, ' ').trim()).slice(0, 60).join('');
  const question = t('study.wrongbook.ask.prompt', {
    stem: opening.replace(/[\s。．.？?！!；;：:]+$/u, ''),
  });
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="wrongbook-ask">
      <select
        value={choice}
        onChange={(event) => setChoice(event.target.value)}
        className={SELECT}
        aria-label={t('study.wrongbook.ask.pick')}
      >
        {classmates.map((classmate) => (
          <option key={classmate.id} value={classmate.id}>
            {classmate.name}
          </option>
        ))}
      </select>
      <Button asChild size="sm" variant="outline">
        <Link
          href={wrongItemChatHref(choice, spaceId, itemId, question)}
          data-testid="wrongbook-ask-open"
        >
          <MessageCircleQuestion className="mr-1 size-4" />
          {t('study.wrongbook.ask.open')}
        </Link>
      </Button>
    </div>
  );
}

/** Whether a paper answer was new, helped, a variant — and so an independent check (B11). */
function OccurrencePractice({ occurrence }: { occurrence: WrongOccurrenceView }) {
  const practice = occurrence.origin.practice!;
  return (
    <PracticeChips
      novelty={practice.novelty}
      level={practice.assistance}
      correct={occurrence.outcome === 'correct'}
      variant={practice.variant}
    />
  );
}

/**
 * Variants of a wrong question (B11): AI writes 1–3 new questions on the same
 * knowledge point and method from the original (and the subject's
 * materials), after the student agreed to the plan; the practice paper's
 * answers then join this item's history.
 */
function VariantPractice({
  spaceId,
  itemId,
  question,
}: {
  spaceId: string;
  itemId: string;
  question: WrongOccurrenceView['question'];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(2);
  const [jobKey, setJobKey] = useState(newRequestKey);
  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        data-testid="wrongbook-variant-open"
      >
        <Shuffle className="mr-1 size-4" />
        {t('study.wrongbook.variant.open')}
      </Button>
    );
  }
  return (
    <section className="space-y-2" data-testid="wrongbook-variant">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-foreground">{t('study.wrongbook.variant.title')}</span>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t('study.wrongbook.variant.count')}
          <select
            value={count}
            onChange={(event) => {
              setCount(Number(event.target.value));
              setJobKey(newRequestKey());
            }}
            className={SELECT}
            data-testid="wrongbook-variant-count"
          >
            {Array.from({ length: PRACTICE_LIMITS.variantMax }, (_, index) => index + 1).map(
              (value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      <GenerationPanel
        key={jobKey}
        plan={{
          mode: 'ai',
          targets: [{ type: question.type, count }],
          total: count,
          concepts: question.concepts,
          materials: [],
          maxCalls: callCapFor(count),
          blocked: null,
        }}
        selectableMaterials={false}
        note={t('study.wrongbook.variant.intro')}
        createJob={() => practiceApi.createVariantJob(itemId, count, jobKey)}
        paperTitle={null}
        spaceId={spaceId}
      />
      <p className="text-xs text-muted-foreground">{t('study.wrongbook.variant.help')}</p>
    </section>
  );
}
