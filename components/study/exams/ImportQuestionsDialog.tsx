'use client';

/**
 * Import a JSON question file (learning plan B07): the server checks every
 * question and reports each problem where it is; the student can fix a
 * question in the editor, skip it, choose whether the answers count as
 * checked and link the batch to a course, then add the valid ones. Only JSON
 * is supported; a sample file shows the format.
 */
import { useRef, useState } from 'react';
import { Download, FileJson, LoaderCircle, Pencil, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useIssueText, MathText } from '@/components/study/exams/exam-format';
import {
  PublicSourceFields,
  publicSourceDetails,
  publicSourceValid,
  type PublicSourceForm,
} from '@/components/study/exams/PublicSourceFields';
import {
  QuestionEditorDialog,
  type EditorCourse,
} from '@/components/study/exams/QuestionEditorDialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { questionBankApi } from '@/lib/study/assessments/client';
import {
  QUESTION_LIMITS,
  type ImportPreview,
  type ImportPreviewItem,
  type QuestionContent,
} from '@/lib/study/questions/contracts';
import { StudyApiError } from '@/lib/study/spaces/client';
import { cn } from '@/lib/utils';

const NONE = '__none__';
export const SAMPLE_FILE = '/examples/zhiyu-question-bank-sample.json';

type VerifiedMode = 'file' | 'all' | 'none';

function status(item: ImportPreviewItem): 'ready' | 'draft' | 'invalid' | 'duplicate' {
  if (item.errors.length) return 'invalid';
  if (item.duplicateOf) return 'duplicate';
  return item.warnings.length ? 'draft' : 'ready';
}

const STATUS_STYLE = {
  ready: 'bg-primary/10 text-primary',
  draft: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  invalid: 'bg-destructive/10 text-destructive',
  duplicate: 'bg-muted text-muted-foreground',
} as const;

export function ImportQuestionsDialog({
  open,
  onOpenChange,
  spaceId,
  courses,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaceId: string;
  courses: EditorCourse[];
  onImported: () => void;
}) {
  const { t } = useI18n();
  const issueText = useIssueText();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [verifiedMode, setVerifiedMode] = useState<VerifiedMode>('file');
  const [stageId, setStageId] = useState(NONE);
  const [publicSource, setPublicSource] = useState<PublicSourceForm | null>(null);
  const [editing, setEditing] = useState<ImportPreviewItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function failure(caught: unknown): string {
    if (caught instanceof StudyApiError && caught.code === 'STUDY_IMPORT_INVALID') {
      return t(
        `study.practice.import.fileError.${String(caught.body?.reason ?? 'not_question_bank')}`,
      );
    }
    if (caught instanceof StudyApiError && caught.code === 'STUDY_INVALID_INPUT') {
      return t('study.practice.import.tooLarge');
    }
    if (caught instanceof StudyApiError && caught.code === 'STUDY_QUESTION_LIMIT') {
      return t('study.practice.errors.questionLimit');
    }
    return t('study.errors.generic');
  }

  async function check(document: unknown) {
    setBusy(true);
    setError(null);
    try {
      setPreview(await questionBankApi.previewImport(spaceId, document));
    } catch (caught) {
      setPreview(null);
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  }

  async function readFile(file: File) {
    setFileName(file.name);
    setSkipped(new Set());
    if (file.size > QUESTION_LIMITS.importBytes) {
      setPreview(null);
      setError(t('study.practice.import.tooLarge'));
      return;
    }
    let document: unknown;
    try {
      document = JSON.parse(await file.text());
    } catch {
      setPreview(null);
      setError(t('study.practice.import.notJson'));
      return;
    }
    await check(document);
  }

  /** Re-check after an edit: the server decides validity and duplicates again. */
  async function replace(index: number, content: QuestionContent, verified: boolean) {
    if (!preview) return;
    const questions = preview.items.map((item) =>
      item.index === index
        ? { ...content, verified }
        : item.content
          ? { ...item.content, verified: item.verified }
          : {},
    );
    await check({ questions });
  }

  const selected = (preview?.items ?? []).filter(
    (item) => !skipped.has(item.index) && item.content && !item.errors.length && !item.duplicateOf,
  );

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const result = await questionBankApi.commitImport(
        spaceId,
        selected.map((item) => ({
          ...item.content!,
          verified: verifiedMode === 'all' ? true : verifiedMode === 'none' ? false : item.verified,
        })),
        stageId === NONE ? null : stageId,
        publicSource ? publicSourceDetails(publicSource) : null,
      );
      toast.success(
        t('study.practice.import.done', { created: result.created, duplicates: result.duplicates }),
      );
      onImported();
      onOpenChange(false);
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
          data-testid="question-import"
        >
          <DialogHeader>
            <DialogTitle>{t('study.practice.import.title')}</DialogTitle>
            <DialogDescription>{t('study.practice.import.description')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              data-testid="question-import-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void readFile(file);
              }}
            />
            <Button variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
              <FileJson className="mr-1 size-4" />
              {fileName ? t('study.practice.import.another') : t('study.practice.import.choose')}
            </Button>
            <Button variant="ghost" asChild>
              <a href={SAMPLE_FILE} download>
                <Download className="mr-1 size-4" />
                {t('study.practice.import.sample')}
              </a>
            </Button>
            {fileName ? <span className="text-sm text-muted-foreground">{fileName}</span> : null}
            {busy ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" /> : null}
          </div>

          {preview ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground" data-testid="question-import-summary">
                {t('study.practice.import.summary', preview.summary)}
              </p>
              <ul className="max-h-[45dvh] space-y-2 overflow-y-auto pr-1">
                {preview.items.map((item) => {
                  const kind = status(item);
                  const isSkipped = skipped.has(item.index);
                  return (
                    <li
                      key={item.index}
                      data-testid="question-import-item"
                      data-status={kind}
                      className={cn(
                        'rounded-xl border border-border p-3 text-sm',
                        isSkipped && 'opacity-50',
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <span className="w-8 shrink-0 text-xs text-muted-foreground">
                          #{item.index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-2">
                            {item.content?.stem ? (
                              <MathText text={item.content.stem} />
                            ) : (
                              <span className="text-muted-foreground">
                                {t('study.practice.import.noStem')}
                              </span>
                            )}
                          </div>
                          {[...item.errors, ...item.warnings].map((issue) => (
                            <p
                              key={`${issue.path}-${issue.code}`}
                              className={cn(
                                'mt-1 text-xs',
                                item.errors.includes(issue)
                                  ? 'text-destructive'
                                  : 'text-amber-700 dark:text-amber-400',
                              )}
                            >
                              {issueText(issue)}
                            </p>
                          ))}
                        </div>
                        <span
                          className={cn(
                            'shrink-0 rounded-full px-2 py-0.5 text-[11px]',
                            STATUS_STYLE[kind],
                          )}
                        >
                          {isSkipped
                            ? t('study.practice.import.status.skipped')
                            : t(`study.practice.import.status.${kind}`)}
                        </span>
                        {item.content ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            aria-label={t('study.practice.import.edit')}
                            disabled={busy}
                            onClick={() => setEditing(item)}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                        ) : null}
                        {kind === 'ready' || kind === 'draft' ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            aria-label={
                              isSkipped
                                ? t('study.practice.import.include')
                                : t('study.practice.import.skip')
                            }
                            onClick={() =>
                              setSkipped((current) => {
                                const next = new Set(current);
                                if (next.has(item.index)) next.delete(item.index);
                                else next.add(item.index);
                                return next;
                              })
                            }
                          >
                            <Undo2 className={cn('size-3.5', !isSkipped && 'rotate-180')} />
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t('study.practice.import.verifiedMode')}</Label>
                  <Select
                    value={verifiedMode}
                    onValueChange={(value) => setVerifiedMode(value as VerifiedMode)}
                  >
                    <SelectTrigger className="w-full" data-testid="question-import-verified">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="file">
                        {t('study.practice.import.verifiedFile')}
                      </SelectItem>
                      <SelectItem value="all">{t('study.practice.import.verifiedAll')}</SelectItem>
                      <SelectItem value="none">
                        {t('study.practice.import.verifiedNone')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t('study.practice.editor.course')}</Label>
                  <Select value={stageId} onValueChange={setStageId}>
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
              </div>
              <PublicSourceFields value={publicSource} onChange={setPublicSource} />
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={busy || selected.length === 0 || !publicSourceValid(publicSource)}
              onClick={() => void commit()}
              data-testid="question-import-commit"
            >
              {t('study.practice.import.commit', { count: selected.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {editing?.content ? (
        <QuestionEditorDialog
          open
          onOpenChange={(next) => !next && setEditing(null)}
          title={t('study.practice.import.editTitle', { n: editing.index + 1 })}
          initial={{ content: editing.content, verified: editing.verified, stageId: null }}
          courses={[]}
          onSave={async (value) => {
            await replace(editing.index, value.content, value.verified);
          }}
        />
      ) : null}
    </>
  );
}
