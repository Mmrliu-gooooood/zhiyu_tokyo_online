'use client';

/**
 * Home composer: pick parsed materials of the target space as course material
 * (learning plan B02). Their stored parse is reused; local uploads and library
 * materials are not combined in one generation.
 */
import { useEffect, useState } from 'react';
import { Check, FileText } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { materialsApi } from '@/lib/study/materials/client';
import type { StudyMaterialSummary } from '@/lib/study/materials/contracts';
import type { StudyMaterialSelection } from '@/lib/study/materials/generation';
import { fetchStudyCapabilities } from '@/lib/study/spaces/client';
import { cn } from '@/lib/utils';

export function GenerationMaterialPicker({
  spaceId,
  selected,
  onChange,
  disabled,
}: {
  spaceId: string;
  selected: StudyMaterialSelection[];
  onChange: (next: StudyMaterialSelection[]) => void;
  /** Local files are attached; library materials cannot be combined with them. */
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [materials, setMaterials] = useState<StudyMaterialSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!(await fetchStudyCapabilities()).materials) return;
      const list = await materialsApi.list(spaceId).catch(() => null);
      if (!cancelled && list) setMaterials(list.filter((material) => material.current.artifact));
    })();
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  if (materials === null) return null;
  const isSelected = (materialId: string) =>
    selected.some((item) => item.materialId === materialId);
  const toggle = (material: StudyMaterialSummary) =>
    onChange(
      isSelected(material.materialId)
        ? selected.filter((item) => item.materialId !== material.materialId)
        : [
            ...selected,
            {
              materialId: material.materialId,
              versionId: material.current.versionId,
              title: material.title,
            },
          ],
    );

  return (
    <div className="mx-5 mt-2" data-testid="study-generation-materials">
      <p className="text-xs font-medium text-foreground">
        {t('study.materials.generation.pickerTitle')}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {disabled
          ? t('study.materials.generation.exclusive')
          : materials.length === 0
            ? t('study.materials.generation.none')
            : t('study.materials.generation.pickerHint')}
      </p>
      {materials.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {materials.map((material) => {
            const checked = isSelected(material.materialId);
            return (
              <button
                key={material.materialId}
                type="button"
                disabled={disabled}
                aria-pressed={checked}
                onClick={() => toggle(material)}
                data-testid="study-generation-material"
                className={cn(
                  'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                  checked
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {checked ? <Check className="size-3" /> : <FileText className="size-3" />}
                <span className="truncate">{material.title}</span>
                {material.current.artifact?.pageCount ? (
                  <span className="shrink-0 opacity-70">
                    {t('study.materials.pages', { count: material.current.artifact.pageCount })}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
