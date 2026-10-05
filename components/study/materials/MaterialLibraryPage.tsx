'use client';

/** /study/materials — the owner's material library across all spaces (learning plan B02). */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { useI18n } from '@/lib/hooks/use-i18n';
import { materialsApi } from '@/lib/study/materials/client';
import type { StudyMaterialSummary } from '@/lib/study/materials/contracts';
import { fetchStudyCapabilities } from '@/lib/study/spaces/client';

import { MaterialList } from './MaterialList';
import { MaterialUploadButton } from './MaterialUploadButton';
import { isParseActive, usePollWhile } from './material-format';

export function MaterialLibraryPage() {
  const { t } = useI18n();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [materials, setMaterials] = useState<StudyMaterialSummary[]>([]);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      if (!(await fetchStudyCapabilities()).materials) {
        throw Object.assign(new Error('unavailable'), { status: 404 });
      }
      return materialsApi.list();
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') setMaterials(result.data);
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  const refresh = () => setLoadKey((key) => key + 1);
  usePollWhile(
    materials.some((material) => isParseActive(material.current.parseState)),
    refresh,
  );

  if (state !== 'ready') {
    return (
      <StudyShell>
        <StudyStatus
          state={state}
          onRetry={() => {
            setState('loading');
            refresh();
          }}
        />
      </StudyShell>
    );
  }

  return (
    <StudyShell>
      <Link
        href="/study"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t('study.backToSpaces')}
      </Link>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground md:text-3xl">
            {t('study.materials.libraryTitle')}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {t('study.materials.librarySubtitle')}
          </p>
        </div>
        <MaterialUploadButton onUploaded={refresh} size="default" />
      </header>
      {materials.length === 0 ? (
        <div
          data-testid="study-materials-empty"
          className="rounded-2xl border border-dashed border-border px-6 py-14 text-center text-sm leading-6 text-muted-foreground"
        >
          {t('study.materials.empty')}
        </div>
      ) : (
        <MaterialList materials={materials} showSpaces />
      )}
    </StudyShell>
  );
}
