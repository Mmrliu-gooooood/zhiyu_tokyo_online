'use client';

/**
 * /study/materials/[materialId] — one material (learning plan B02): parse
 * state and controls (parser choice, retry, cancel), versions, the spaces it
 * sits in, reading, download, replacing the file, workbench reuse and
 * permanent deletion.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  ChevronLeft,
  Download,
  MessageSquareText,
  Pencil,
  Trash2,
  X,
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { RelativeTime } from '@/components/study/spaces/study-format';
import { isProWorkbenchEnabled } from '@/lib/config/feature-flags';
import { useI18n } from '@/lib/hooks/use-i18n';
import { materialsApi, readerHref } from '@/lib/study/materials/client';
import {
  STUDY_MATERIAL_LIMITS,
  type MaterialParserOption,
  type StudyMaterialDetail,
  type StudyMaterialVersionView,
} from '@/lib/study/materials/contracts';
import { StudyApiError, fetchStudyCapabilities, studyApi } from '@/lib/study/spaces/client';
import type { StudySpaceSummary } from '@/lib/study/spaces/contracts';

import { MaterialUploadButton } from './MaterialUploadButton';
import {
  ParseStateChip,
  formatBytes,
  isParseActive,
  useArtifactStats,
  useMaterialErrorText,
  usePollWhile,
  useTaskStatusText,
} from './material-format';

const WORKBENCH_HANDOFF_KEY = 'workbench.launchPrompt';

export function MaterialDetailPage({ materialId }: { materialId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const errorText = useMaterialErrorText();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [material, setMaterial] = useState<StudyMaterialDetail | null>(null);
  const [parsers, setParsers] = useState<MaterialParserOption[]>([]);
  const [spaces, setSpaces] = useState<StudySpaceSummary[]>([]);
  const [loadKey, setLoadKey] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      if (!(await fetchStudyCapabilities()).materials) {
        throw Object.assign(new Error('unavailable'), { status: 404 });
      }
      const [detail, list] = await Promise.all([
        materialsApi.get(materialId),
        studyApi.listSpaces().catch(() => [] as StudySpaceSummary[]),
      ]);
      return { detail, list };
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') {
        setMaterial(result.data.detail.material);
        setParsers(result.data.detail.parsers);
        setSpaces(result.data.list);
      }
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [materialId, loadKey]);

  const refresh = () => setLoadKey((key) => key + 1);
  usePollWhile(
    material?.versions.some((version) => isParseActive(version.parseState)) ?? false,
    refresh,
  );

  if (state !== 'ready' || !material) {
    return (
      <StudyShell>
        <StudyStatus
          state={state === 'ready' ? 'loading' : state}
          onRetry={() => {
            setState('loading');
            refresh();
          }}
        />
      </StudyShell>
    );
  }

  const current = material.current;
  const linkable = spaces.filter(
    (space) =>
      space.status === 'active' && !material.spaces.some((ref) => ref.spaceId === space.id),
  );

  function useInWorkbench() {
    try {
      window.sessionStorage.setItem(
        WORKBENCH_HANDOFF_KEY,
        JSON.stringify({
          v: 1,
          prompt: t('study.materials.workbenchPrompt', { name: material!.title }),
          materials: [
            {
              materialId: current.uploadId,
              name: current.originalName,
              bytes: current.byteSize,
              mimeType: current.mime,
            },
          ],
        }),
      );
    } catch {
      toast.error(t('study.errors.generic'));
      return;
    }
    router.push('/workbench/new');
  }

  return (
    <StudyShell>
      <Link
        href="/study/materials"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t('study.materials.backToLibrary')}
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1
              className="truncate font-display text-2xl font-bold text-foreground md:text-3xl"
              data-testid="study-material-name"
            >
              {material.title}
            </h1>
            <ParseStateChip state={current.parseState} />
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {current.originalName} · {formatBytes(current.byteSize)} ·{' '}
            {t('study.materials.versionCount', { count: material.versionCount })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {current.artifact ? (
            <Button asChild>
              <Link
                href={readerHref(material.materialId, current.versionId)}
                data-testid="study-material-read"
              >
                <BookOpen className="mr-1 size-4" />
                {t('study.materials.read')}
              </Link>
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => setRenaming(true)}>
            <Pencil className="mr-1 size-4" />
            {t('study.materials.rename')}
          </Button>
        </div>
      </header>

      <ParsePanel
        material={material}
        version={current}
        parsers={parsers}
        onChanged={refresh}
        errorText={errorText}
      />

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">
            {t('study.materials.versions')}
          </h2>
          <MaterialUploadButton
            materialId={material.materialId}
            label={t('study.materials.replace')}
            variant="outline"
            onUploaded={refresh}
            testId="study-material-replace"
          />
        </div>
        <p className="mb-3 text-xs text-muted-foreground">{t('study.materials.replaceHint')}</p>
        <ul className="space-y-2" data-testid="study-material-versions">
          {material.versions.map((version) => (
            <VersionRow
              key={version.versionId}
              materialId={material.materialId}
              version={version}
            />
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-base font-semibold text-foreground">
          {t('study.materials.inSpaces')}
        </h2>
        <div className="flex flex-wrap items-center gap-2" data-testid="study-material-spaces">
          {material.spaces.length === 0 ? (
            <span className="text-sm text-muted-foreground">{t('study.materials.noSpaces')}</span>
          ) : null}
          {material.spaces.map((space) => (
            <span
              key={space.spaceId}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1 text-sm"
            >
              <Link
                href={`/study/${encodeURIComponent(space.spaceId)}`}
                className="hover:underline"
              >
                {space.name}
              </Link>
              <button
                type="button"
                aria-label={t('study.materials.removeFromSpace')}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() =>
                  void materialsApi
                    .unlink(space.spaceId, material.materialId)
                    .then(refresh)
                    .catch((error) => toast.error(errorText(error)))
                }
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
          {linkable.length > 0 ? (
            <Select
              value=""
              onValueChange={(spaceId) =>
                void materialsApi
                  .link(spaceId, material.materialId)
                  .then(refresh)
                  .catch((error) => toast.error(errorText(error)))
              }
            >
              <SelectTrigger
                className="h-8 w-auto gap-1 text-sm"
                data-testid="study-material-add-space"
              >
                <SelectValue placeholder={t('study.materials.addToSpace')} />
              </SelectTrigger>
              <SelectContent>
                {linkable.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </section>

      <section className="mt-10 flex flex-wrap gap-2 border-t border-border pt-6">
        {isProWorkbenchEnabled() && current.artifact ? (
          <Button variant="outline" onClick={useInWorkbench} data-testid="study-material-workbench">
            <MessageSquareText className="mr-1 size-4" />
            {t('study.materials.useInWorkbench')}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
          data-testid="study-material-delete"
        >
          <Trash2 className="mr-1 size-4" />
          {t('study.materials.delete')}
        </Button>
      </section>

      {renaming ? (
        <RenameDialog
          material={material}
          onClose={() => setRenaming(false)}
          onSaved={(next) => {
            setMaterial(next);
            setRenaming(false);
          }}
        />
      ) : null}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('study.materials.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('study.materials.deleteText', { name: material.title })}
              {material.sessionRefCount > 0
                ? ` ${t('study.materials.deleteSessions', { count: material.sessionRefCount })}`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="study-material-delete-confirm"
              onClick={() => {
                void materialsApi
                  .remove(material.materialId)
                  .then((result) => {
                    toast.success(
                      result.deleted
                        ? t('study.materials.deleted')
                        : t('study.materials.deletePending'),
                    );
                    router.push('/study/materials');
                  })
                  .catch((error) => toast.error(errorText(error)));
              }}
            >
              {t('study.materials.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </StudyShell>
  );
}

function ParsePanel({
  material,
  version,
  parsers,
  onChanged,
  errorText,
}: {
  material: StudyMaterialDetail;
  version: StudyMaterialVersionView;
  parsers: MaterialParserOption[];
  onChanged: () => void;
  errorText: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const stats = useArtifactStats();
  const taskText = useTaskStatusText();
  const fallback = parsers.find((parser) => parser.isDefault)?.providerId ?? '';
  const [providerId, setProviderId] = useState(
    version.artifact?.extractorId ?? version.latestTask?.providerId ?? fallback,
  );
  const [busy, setBusy] = useState(false);
  const task = version.latestTask;
  const active = isParseActive(version.parseState);
  const chosen = parsers.find((parser) => parser.providerId === providerId);
  // Only parsers this server can run are offered: unconfigured paid OCR
  // providers stay hidden (the library supports text PDFs only for now).
  const choices = parsers.filter((parser) => parser.available);
  const note = taskText(task);
  const parseLabel = version.artifact
    ? t('study.materials.reparse')
    : version.parseState === 'not_started'
      ? t('study.materials.parse')
      : t('study.materials.parseAgain');
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work()
      .then(onChanged)
      .catch((error) => toast.error(errorText(error)))
      .finally(() => setBusy(false));
  };

  return (
    <section
      className="rounded-2xl border border-border bg-card p-5"
      data-testid="study-material-parse-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-foreground">
          {t('study.materials.parseTitle')}
        </h2>
        <ParseStateChip state={version.parseState} />
      </div>
      <p className="mt-2 text-sm text-muted-foreground" data-testid="study-material-parse-summary">
        {version.artifact
          ? `${stats(version)} · ${t('study.materials.parsedBy', {
              name:
                parsers.find((parser) => parser.providerId === version.artifact!.extractorId)
                  ?.displayName ?? version.artifact.extractorId,
            })}`
          : t('study.materials.notParsedYet')}
      </p>
      {note ? (
        <p
          className={
            task?.status === 'failed'
              ? 'mt-2 text-sm text-destructive'
              : 'mt-2 text-sm text-muted-foreground'
          }
          data-testid="study-material-task-note"
        >
          {note}
        </p>
      ) : null}
      {version.artifact?.diagnostics.length ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary>{t('study.materials.diagnostics')}</summary>
          <ul className="mt-1 list-disc pl-5">
            {version.artifact.diagnostics.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select value={providerId} onValueChange={setProviderId}>
          <SelectTrigger className="h-9 w-auto min-w-[12rem]" data-testid="study-material-parser">
            <SelectValue placeholder={t('study.materials.parser')} />
          </SelectTrigger>
          <SelectContent>
            {choices.map((parser) => (
              <SelectItem key={parser.providerId} value={parser.providerId}>
                {parser.displayName}
                {parser.isDefault ? ` · ${t('study.materials.parserDefault')}` : ''}
                {parser.paid ? ` · ${t('study.materials.parserPaid')}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {active && task?.cancelable ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => run(() => materialsApi.cancelTask(task.taskId))}
            data-testid="study-material-cancel"
          >
            {t('study.materials.cancel')}
          </Button>
        ) : (
          <Button
            disabled={busy || !chosen?.available}
            onClick={() =>
              run(() =>
                materialsApi.parse(
                  material.materialId,
                  version.versionId,
                  providerId || undefined,
                  // Per click; a live task for the version is returned instead of a second one.
                  `${version.versionId}:${providerId}:${Date.now()}`,
                ),
              )
            }
            data-testid="study-material-parse"
          >
            {parseLabel}
          </Button>
        )}
        {task && task.retryable && !active ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => run(() => materialsApi.retryTask(task.taskId))}
            data-testid="study-material-retry"
          >
            {t('study.materials.retry')}
          </Button>
        ) : null}
      </div>
      {chosen?.paid ? (
        <p className="mt-2 text-xs text-review-ink">{t('study.materials.paidNotice')}</p>
      ) : null}
    </section>
  );
}

function VersionRow({
  materialId,
  version,
}: {
  materialId: string;
  version: StudyMaterialVersionView;
}) {
  const { t } = useI18n();
  const stats = useArtifactStats();
  return (
    <li
      data-testid="study-material-version"
      data-version-no={version.versionNo}
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {t('study.materials.versionLabel', { n: version.versionNo })}
          </span>
          {version.isCurrent ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              {t('study.materials.currentVersion')}
            </span>
          ) : null}
          <ParseStateChip state={version.parseState} />
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {version.originalName} · {formatBytes(version.byteSize)}
          {stats(version) ? ` · ${stats(version)}` : ''} · <RelativeTime iso={version.createdAt} />
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {version.artifact ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={readerHref(materialId, version.versionId)}>
              <BookOpen className="mr-1 size-4" />
              {t('study.materials.read')}
            </Link>
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" asChild>
          <a href={materialsApi.fileUrl(materialId, version.versionId, true)}>
            <Download className="mr-1 size-4" />
            {t('study.materials.download')}
          </a>
        </Button>
      </div>
    </li>
  );
}

function RenameDialog({
  material,
  onClose,
  onSaved,
}: {
  material: StudyMaterialDetail;
  onClose: () => void;
  onSaved: (material: StudyMaterialDetail) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(material.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const valid = title.trim().length > 0 && title.trim().length <= STUDY_MATERIAL_LIMITS.titleMax;
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('study.materials.rename')}</DialogTitle>
        </DialogHeader>
        <label className="text-sm text-muted-foreground" htmlFor="material-title">
          {t('study.materials.titleLabel')}
        </label>
        <Input
          id="material-title"
          value={title}
          maxLength={STUDY_MATERIAL_LIMITS.titleMax}
          onChange={(event) => setTitle(event.target.value)}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={saving || !valid}
            onClick={() => {
              setSaving(true);
              setError('');
              void materialsApi
                .rename(material.materialId, title.trim(), material.revision)
                .then(onSaved)
                .catch((cause) => {
                  if (cause instanceof StudyApiError && cause.code === 'STUDY_REVISION_CONFLICT') {
                    const latest = cause.body?.current as StudyMaterialDetail | undefined;
                    if (latest) onSaved(latest);
                  }
                  setError(t('study.errors.generic'));
                })
                .finally(() => setSaving(false));
            }}
          >
            {t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
