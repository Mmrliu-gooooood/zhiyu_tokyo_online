'use client';

/** A list of library materials with parse state, size and read/open actions. */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { BookOpen, FileText } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { RelativeTime } from '@/components/study/spaces/study-format';
import { useI18n } from '@/lib/hooks/use-i18n';
import { readerHref } from '@/lib/study/materials/client';
import type { StudyMaterialSummary } from '@/lib/study/materials/contracts';

import {
  ParseStateChip,
  formatBytes,
  useArtifactStats,
  useTaskStatusText,
} from './material-format';

export function MaterialList({
  materials,
  actions,
  showSpaces = false,
}: {
  materials: StudyMaterialSummary[];
  /** Extra per-row actions (e.g. remove from space). */
  actions?: (material: StudyMaterialSummary) => ReactNode;
  showSpaces?: boolean;
}) {
  const { t } = useI18n();
  const stats = useArtifactStats();
  const taskText = useTaskStatusText();
  return (
    <ul className="space-y-2" data-testid="study-material-list">
      {materials.map((material) => {
        const current = material.current;
        const note = taskText(current.latestTask);
        const detail = [
          current.originalName,
          formatBytes(current.byteSize),
          material.versionCount > 1
            ? t('study.materials.versionLabel', { n: current.versionNo })
            : null,
          stats(current),
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <li
            key={material.materialId}
            data-testid="study-material-row"
            data-material-id={material.materialId}
            className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center"
          >
            <FileText className="hidden size-5 shrink-0 text-muted-foreground sm:block" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Link
                  href={`/study/materials/${encodeURIComponent(material.materialId)}`}
                  className="truncate text-sm font-medium text-foreground hover:underline"
                  data-testid="study-material-title"
                >
                  {material.title}
                </Link>
                <ParseStateChip state={current.parseState} />
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
              {note ? (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="study-material-note">
                  {note}
                </p>
              ) : null}
              {showSpaces ? (
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {material.spaces.length
                    ? material.spaces.map((space) => space.name).join('、')
                    : t('study.materials.noSpaces')}
                  {' · '}
                  <RelativeTime iso={material.updatedAt} />
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {current.artifact ? (
                <Button size="sm" variant="outline" asChild>
                  <Link
                    href={readerHref(material.materialId, current.versionId)}
                    data-testid="study-material-read"
                  >
                    <BookOpen className="mr-1 size-4" />
                    {t('study.materials.read')}
                  </Link>
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" asChild>
                <Link href={`/study/materials/${encodeURIComponent(material.materialId)}`}>
                  {t('study.materials.open')}
                </Link>
              </Button>
              {actions?.(material)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
