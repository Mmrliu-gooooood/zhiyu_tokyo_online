'use client';

/**
 * Start an exercise extraction from one of the space's parsed materials, or
 * reopen an earlier one (learning plan B08). The student picks the material,
 * its version and a page range; the server reads the parsed text of those
 * pages (rules only, no model) and the review page opens.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/hooks/use-i18n';
import { extractionApi } from '@/lib/study/extraction/client';
import { EXTRACTION_LIMITS, type ExtractionView } from '@/lib/study/extraction/contracts';
import { materialsApi } from '@/lib/study/materials/client';
import type {
  StudyMaterialSummary,
  StudyMaterialVersionView,
} from '@/lib/study/materials/contracts';
import { StudyApiError } from '@/lib/study/spaces/client';

export function extractionTitle(
  t: ReturnType<typeof useI18n>['t'],
  extraction: Pick<ExtractionView, 'materialTitle' | 'versionNo' | 'pageFrom' | 'pageTo'>,
): string {
  return [
    extraction.materialTitle ?? t('study.extraction.materialGone'),
    extraction.versionNo ? t('study.practice.source.version', { n: extraction.versionNo }) : null,
    extraction.pageFrom !== null
      ? t('study.extraction.pageRange', { from: extraction.pageFrom, to: extraction.pageTo })
      : t('study.extraction.wholeDocument'),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function ExtractQuestionsDialog({
  open,
  onOpenChange,
  spaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaceId: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [materials, setMaterials] = useState<StudyMaterialSummary[] | null>(null);
  const [history, setHistory] = useState<ExtractionView[]>([]);
  const [materialId, setMaterialId] = useState('');
  const [versions, setVersions] = useState<StudyMaterialVersionView[]>([]);
  const [versionId, setVersionId] = useState('');
  /** null: the default range of the chosen version (from page 1, as many pages as allowed). */
  const [typed, setTyped] = useState<{ from: string; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([materialsApi.list(spaceId), extractionApi.list(spaceId)])
      .then(([list, extractions]) => {
        if (cancelled) return;
        setMaterials(list);
        setHistory(extractions);
        const first = list.find((material) => material.current.artifact);
        if (first) setMaterialId(first.materialId);
      })
      .catch(() => {
        if (!cancelled) {
          setMaterials([]);
          setError(t('study.errors.generic'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, t]);

  useEffect(() => {
    if (!materialId) return;
    let cancelled = false;
    void materialsApi
      .get(materialId)
      .then(({ material }) => {
        if (cancelled) return;
        setVersions(material.versions);
        setTyped(null);
        const current = material.versions.find((version) => version.isCurrent);
        setVersionId(current?.versionId ?? material.versions[0]?.versionId ?? '');
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [materialId]);

  const version = versions.find((entry) => entry.versionId === versionId) ?? null;
  const artifact = version?.artifact ?? null;
  const pageCount = artifact?.paged ? artifact.pageCount : null;

  const from = typed?.from ?? '1';
  const to = typed?.to ?? String(Math.min(pageCount ?? 1, EXTRACTION_LIMITS.maxPages));
  const setFrom = (value: string) => setTyped({ from: value, to });
  const setTo = (value: string) => setTyped({ from, to: value });

  const range = useMemo(() => {
    if (!pageCount) return { ok: true, from: null, to: null };
    const start = Number(from);
    const end = Number(to);
    const ok =
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 1 &&
      end >= start &&
      end <= pageCount &&
      end - start + 1 <= EXTRACTION_LIMITS.maxPages;
    return { ok, from: start, to: end };
  }, [from, to, pageCount]);

  async function start() {
    if (!materialId || !versionId || !range.ok) return;
    setBusy(true);
    setError(null);
    try {
      const result = await extractionApi.start({
        spaceId,
        materialId,
        versionId,
        pageFrom: range.from,
        pageTo: range.to,
      });
      router.push(
        `/study/${encodeURIComponent(spaceId)}/extractions/${encodeURIComponent(result.extractionId)}`,
      );
    } catch (failure) {
      const code = failure instanceof StudyApiError ? failure.code : '';
      setError(
        code === 'STUDY_MATERIAL_NOT_PARSED'
          ? t('study.extraction.notParsed')
          : code === 'STUDY_EXTRACTION_RANGE_INVALID'
            ? t('study.extraction.rangeInvalid', {
                count: pageCount ?? 0,
                max: EXTRACTION_LIMITS.maxPages,
              })
            : code === 'STUDY_EXTRACTION_LIMIT'
              ? t('study.extraction.limit', { max: EXTRACTION_LIMITS.extractionsPerSpace })
              : t('study.errors.generic'),
      );
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        data-testid="extract-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('study.extraction.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('study.extraction.dialogDescription')}</DialogDescription>
        </DialogHeader>

        {materials === null ? (
          <div className="flex justify-center py-6">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : materials.length === 0 ? (
          <p className="rounded-md bg-muted/60 px-3 py-3 text-sm text-muted-foreground">
            {t('study.extraction.noMaterials')}{' '}
            <Link href={`/study/${encodeURIComponent(spaceId)}`} className="text-primary underline">
              {t('study.extraction.toSpace')}
            </Link>
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t('study.extraction.material')}</Label>
              <Select value={materialId} onValueChange={setMaterialId}>
                <SelectTrigger className="w-full" data-testid="extract-material">
                  <SelectValue placeholder={t('study.extraction.pickMaterial')} />
                </SelectTrigger>
                <SelectContent>
                  {materials.map((material) => (
                    <SelectItem key={material.materialId} value={material.materialId}>
                      {material.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {versions.length > 1 ? (
              <div className="space-y-1.5">
                <Label>{t('study.extraction.version')}</Label>
                <Select
                  value={versionId}
                  onValueChange={(value) => {
                    setVersionId(value);
                    setTyped(null);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((entry) => (
                      <SelectItem key={entry.versionId} value={entry.versionId}>
                        {t('study.practice.source.version', { n: entry.versionNo })}
                        {entry.isCurrent ? ` · ${t('study.extraction.current')}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {version && !artifact ? (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {t('study.extraction.notParsed')}
              </p>
            ) : null}
            {pageCount ? (
              <div className="space-y-1.5">
                <Label>{t('study.extraction.pages', { count: pageCount })}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={pageCount}
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                    className="w-24"
                    aria-label={t('study.extraction.pageFrom')}
                    data-testid="extract-from"
                  />
                  <span className="text-muted-foreground">–</span>
                  <Input
                    type="number"
                    min={1}
                    max={pageCount}
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                    className="w-24"
                    aria-label={t('study.extraction.pageTo')}
                    data-testid="extract-to"
                  />
                </div>
                {!range.ok ? (
                  <p className="text-xs text-destructive">
                    {t('study.extraction.rangeInvalid', {
                      count: pageCount,
                      max: EXTRACTION_LIMITS.maxPages,
                    })}
                  </p>
                ) : null}
              </div>
            ) : artifact ? (
              <p className="text-sm text-muted-foreground">{t('study.extraction.wholeDocument')}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('study.extraction.rulesHint')}</p>
          </div>
        )}

        {history.length ? (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-sm font-medium text-foreground">{t('study.extraction.history')}</p>
            <ul className="space-y-1.5">
              {history.map((extraction) => (
                <li key={extraction.id}>
                  <Link
                    href={`/study/${encodeURIComponent(spaceId)}/extractions/${encodeURIComponent(extraction.id)}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-foreground">
                        {extractionTitle(t, extraction)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t('study.extraction.historyCounts', { ...extraction.counts })}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
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
            disabled={busy || !artifact || !range.ok}
            onClick={() => void start()}
            data-testid="extract-start"
          >
            {busy ? <LoaderCircle className="mr-1.5 size-4 animate-spin" /> : null}
            {t('study.extraction.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
