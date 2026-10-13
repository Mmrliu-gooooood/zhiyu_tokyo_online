'use client';

/**
 * A subject's question bank (learning plan B07): counts, filters, the
 * questions with their answer, explanation, origin and check state, and the
 * ways in — JSON import, writing one, or copying from an official pack.
 * Editing saves a new version; papers already published keep their copy.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  BookCopy,
  FileUp,
  LoaderCircle,
  Pencil,
  Plus,
  ScanText,
  Search,
  Trash2,
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  GuideDetails,
  OriginChip,
  QuestionFigures,
  SourceDetails,
  TypeChip,
  VerificationChip,
  MathText,
} from '@/components/study/exams/exam-format';
import { ImportQuestionsDialog } from '@/components/study/exams/ImportQuestionsDialog';
import { ExtractQuestionsDialog } from '@/components/study/extraction/ExtractQuestionsDialog';
import { OfficialPacksDialog } from '@/components/study/exams/OfficialPacksDialog';
import {
  QuestionEditorDialog,
  type EditorCourse,
} from '@/components/study/exams/QuestionEditorDialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { questionBankApi, type BankFilter } from '@/lib/study/assessments/client';
import type {
  ConceptView,
  QuestionContent,
  QuestionListResult,
  QuestionView,
} from '@/lib/study/questions/contracts';
import { StudyApiError } from '@/lib/study/spaces/client';
import { cn } from '@/lib/utils';

const ALL = '__all__';

export function QuestionBankPanel({
  spaceId,
  archived,
  courses,
  concepts,
  canExtract = false,
  onBankChanged,
}: {
  spaceId: string;
  archived: boolean;
  courses: EditorCourse[];
  concepts: ConceptView[];
  /** Exercise extraction from materials is served (B08). */
  canExtract?: boolean;
  /** The bank changed (counts, knowledge points). */
  onBankChanged: () => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<BankFilter>({});
  const [query, setQuery] = useState('');
  const [data, setData] = useState<QuestionListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<QuestionView | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [removing, setRemoving] = useState<QuestionView | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (offset = 0) => {
      setLoading(true);
      setFailed(false);
      try {
        const page = await questionBankApi.list(spaceId, { ...filter, offset });
        setData((current) =>
          offset && current
            ? { ...page, questions: [...current.questions, ...page.questions] }
            : page,
        );
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [spaceId, filter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const changed = () => {
    void load();
    onBankChanged();
  };

  const setOne = (key: keyof BankFilter, value: string) =>
    setFilter((current) => ({ ...current, [key]: value === ALL ? undefined : value }));

  async function save(
    question: QuestionView | null,
    content: QuestionContent,
    verified: boolean,
    stageId: string | null,
  ) {
    try {
      if (question) await questionBankApi.update(question, content, verified, stageId);
      else await questionBankApi.create(spaceId, content, verified, stageId);
      changed();
    } catch (error) {
      if (error instanceof StudyApiError && error.code === 'STUDY_REVISION_CONFLICT') {
        changed();
        throw new Error(t('study.practice.errors.questionConflict'));
      }
      if (error instanceof StudyApiError && error.code === 'STUDY_QUESTION_LIMIT') {
        throw new Error(t('study.practice.errors.questionLimit'));
      }
      throw new Error(t('study.errors.generic'));
    }
  }

  const counts = data?.counts;
  const courseName = (stageId: string | null) =>
    courses.find((course) => course.stageId === stageId)?.name ?? null;

  return (
    <section data-testid="question-bank">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" data-testid="question-bank-counts">
          {counts ? t('study.practice.bank.counts', counts) : t('common.loading')}
        </p>
        {!archived ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setBrowsing(true)}>
              <BookCopy className="mr-1 size-4" />
              {t('study.practice.packs.open')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
              <Plus className="mr-1 size-4" />
              {t('study.practice.bank.write')}
            </Button>
            {canExtract ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setExtracting(true)}
                data-testid="question-extract-open"
              >
                <ScanText className="mr-1 size-4" />
                {t('study.extraction.open')}
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setImporting(true)} data-testid="question-import-open">
              <FileUp className="mr-1 size-4" />
              {t('study.practice.import.open')}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setBrowsing(true)}>
            <BookCopy className="mr-1 size-4" />
            {t('study.practice.packs.open')}
          </Button>
        )}
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto_auto]">
        <form
          className="relative"
          onSubmit={(event) => {
            event.preventDefault();
            setFilter((current) => ({ ...current, q: query.trim() || undefined }));
          }}
        >
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            value={query}
            placeholder={t('study.practice.bank.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </form>
        <Select value={filter.type ?? ALL} onValueChange={(value) => setOne('type', value)}>
          <SelectTrigger className="w-full sm:w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('study.practice.bank.allTypes')}</SelectItem>
            <SelectItem value="single">{t('study.practice.type.single')}</SelectItem>
            <SelectItem value="multiple">{t('study.practice.type.multiple')}</SelectItem>
            <SelectItem value="short_answer">{t('study.practice.type.short_answer')}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filter.verification ?? ALL}
          onValueChange={(value) => setOne('verification', value)}
        >
          <SelectTrigger className="w-full sm:w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('study.practice.bank.anyCheck')}</SelectItem>
            <SelectItem value="verified">{t('study.practice.bank.checked')}</SelectItem>
            <SelectItem value="unverified">
              {t('study.practice.verification.unverified')}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select value={filter.state ?? ALL} onValueChange={(value) => setOne('state', value)}>
          <SelectTrigger className="w-full sm:w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('study.practice.bank.anyState')}</SelectItem>
            <SelectItem value="gradable">{t('study.practice.bank.gradable')}</SelectItem>
            <SelectItem value="drafts">{t('study.practice.bank.drafts')}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filter.conceptId ?? ALL}
          onValueChange={(value) => setOne('conceptId', value)}
        >
          <SelectTrigger className="w-full sm:w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('study.practice.bank.allConcepts')}</SelectItem>
            {concepts
              .filter((concept) => concept.questionCount > 0)
              .map((concept) => (
                <SelectItem key={concept.id} value={concept.id}>
                  {concept.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      {failed ? (
        <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
          {t('study.state.error')}
          <Button variant="link" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : data && data.questions.length === 0 && !loading ? (
        <div
          className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm leading-6 text-muted-foreground"
          data-testid="question-bank-empty"
        >
          {counts?.all ? t('study.practice.bank.noMatch') : t('study.practice.bank.empty')}
        </div>
      ) : (
        <ul className="space-y-2" data-testid="question-list">
          {data?.questions.map((question) => {
            const open = expanded.has(question.id);
            return (
              <li
                key={question.id}
                data-testid="question-row"
                className="rounded-2xl border border-border bg-card p-4"
              >
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left text-sm text-foreground"
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (open) next.delete(question.id);
                        else next.add(question.id);
                        return next;
                      })
                    }
                  >
                    <span className={cn(!open && 'line-clamp-2')}>
                      <MathText text={question.stem} allowDisplayMode={open} />
                    </span>
                  </button>
                  {!archived ? (
                    <div className="flex shrink-0">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        aria-label={t('study.edit')}
                        onClick={() => setEditing(question)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 text-muted-foreground"
                        aria-label={t('study.delete')}
                        onClick={() => setRemoving(question)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <TypeChip type={question.type} subtype={question.subtype} />
                  <VerificationChip state={question.verification} />
                  <OriginChip origin={question.origin} />
                  {!question.gradable ? (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                      {t('study.practice.bank.draftChip')}
                    </span>
                  ) : null}
                  {question.difficulty ? (
                    <span className="text-[11px] text-muted-foreground">
                      {t(`study.practice.difficulty.level${question.difficulty}`)}
                    </span>
                  ) : null}
                  {question.concepts.map((name) => (
                    <span key={name} className="text-[11px] text-muted-foreground">
                      #{name}
                    </span>
                  ))}
                  {courseName(question.stageId) ? (
                    <span className="text-[11px] text-muted-foreground">
                      · {courseName(question.stageId)}
                    </span>
                  ) : null}
                </div>
                {open ? (
                  <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
                    <QuestionFigures figures={question.figures} />
                    {question.options.map((option) => (
                      <p
                        key={option.value}
                        className={cn(
                          question.answer.includes(option.value)
                            ? 'font-medium text-primary'
                            : 'text-muted-foreground',
                        )}
                      >
                        {option.value}. <MathText text={option.label} />
                      </p>
                    ))}
                    {question.type === 'short_answer' ? (
                      <GuideDetails guide={question.guide} points={question.points} />
                    ) : null}
                    {question.explanation ? (
                      <p className="pt-1 text-muted-foreground">
                        <MathText text={question.explanation} allowDisplayMode />
                      </p>
                    ) : null}
                    <SourceDetails source={question.source} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {loading ? (
        <div className="flex justify-center py-6">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : data && data.questions.length < data.total ? (
        <div className="flex justify-center py-4">
          <Button variant="outline" size="sm" onClick={() => void load(data.questions.length)}>
            {t('study.practice.bank.more', { left: data.total - data.questions.length })}
          </Button>
        </div>
      ) : null}

      {editing ? (
        <QuestionEditorDialog
          open
          onOpenChange={(next) => !next && setEditing(null)}
          title={
            editing === 'new'
              ? t('study.practice.bank.write')
              : t('study.practice.editor.editTitle')
          }
          initial={
            editing === 'new'
              ? null
              : {
                  content: editing,
                  verified: editing.verification !== 'unverified',
                  stageId: editing.stageId,
                }
          }
          courses={courses}
          onSave={(value) =>
            save(editing === 'new' ? null : editing, value.content, value.verified, value.stageId)
          }
        />
      ) : null}
      {importing ? (
        <ImportQuestionsDialog
          open
          onOpenChange={setImporting}
          spaceId={spaceId}
          courses={courses}
          onImported={changed}
        />
      ) : null}
      {extracting ? (
        <ExtractQuestionsDialog open onOpenChange={setExtracting} spaceId={spaceId} />
      ) : null}
      {browsing ? (
        <OfficialPacksDialog
          open
          onOpenChange={setBrowsing}
          spaceId={spaceId}
          archived={archived}
          onCopied={changed}
        />
      ) : null}
      <AlertDialog open={removing !== null} onOpenChange={(next) => !next && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('study.practice.bank.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('study.practice.bank.deleteText')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (!target) return;
                void questionBankApi
                  .remove(target.id)
                  .then(changed)
                  .catch(() => toast.error(t('study.errors.generic')));
              }}
            >
              {t('study.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
