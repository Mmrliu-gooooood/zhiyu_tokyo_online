'use client';

/**
 * /study/classmates — the student's classmate templates (learning plan B04).
 * Create, edit, archive and restore; import roles made on this device before
 * templates lived on the server. Picking classmates for a new course happens
 * in the home roster picker.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Archive, ChevronLeft, Pencil, Plus, RotateCcw, Upload } from 'lucide-react';
import { toast } from 'sonner';

import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import {
  classmateApi,
  localRolesToImport,
  syncClassmateRegistry,
} from '@/lib/study/classmates/client';
import type { ClassmateInput, ClassmateView } from '@/lib/study/classmates/contracts';
import { materialsApi } from '@/lib/study/materials/client';
import type { StudyMaterialSummary } from '@/lib/study/materials/contracts';
import { StudyApiError, fetchStudyCapabilities } from '@/lib/study/spaces/client';

import { ClassmateFormDialog } from './ClassmateFormDialog';

interface PageData {
  classmates: ClassmateView[];
  materials: StudyMaterialSummary[] | null;
}

export function ClassmatesPage() {
  const { t } = useI18n();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [data, setData] = useState<PageData>({ classmates: [], materials: null });
  const [loadKey, setLoadKey] = useState(0);
  const [editing, setEditing] = useState<ClassmateView | null | 'new'>(null);
  const [importable, setImportable] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      const capabilities = await fetchStudyCapabilities();
      if (!capabilities.classmates) {
        throw Object.assign(new Error('unavailable'), { status: 404 });
      }
      const [classmates, materials] = await Promise.all([
        classmateApi.list(),
        capabilities.materials ? materialsApi.list().catch(() => null) : Promise.resolve(null),
      ]);
      return { classmates, materials };
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') {
        setData(result.data);
        setImportable(localRolesToImport().length);
        void syncClassmateRegistry({ force: true });
      }
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  const refresh = () => setLoadKey((key) => key + 1);

  const errorText = (error: unknown) => {
    const code = error instanceof StudyApiError ? error.code : '';
    const key = `study.classmates.errors.${code}`;
    const translated = t(key);
    return translated !== key ? translated : t('study.errors.generic');
  };

  async function save(input: ClassmateInput) {
    try {
      if (editing && editing !== 'new') {
        await classmateApi.update(editing.id, editing.revision, input);
      } else {
        await classmateApi.create(input);
      }
    } catch (error) {
      if (error instanceof StudyApiError && error.code === 'STUDY_REVISION_CONFLICT') refresh();
      throw new Error(errorText(error));
    }
    refresh();
  }

  async function setStatus(classmate: ClassmateView, status: ClassmateView['status']) {
    setBusy(true);
    try {
      await classmateApi.update(classmate.id, classmate.revision, { status });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function importLocal() {
    const items = localRolesToImport().slice(0, 10);
    if (items.length === 0) return;
    setBusy(true);
    try {
      const result = await classmateApi.importLocal(items);
      // Imported roles now live on the account; drop the device-only copies.
      const registry = useAgentRegistry.getState();
      for (const agent of registry.listAgents()) {
        if (
          items.some((item) => item.name === agent.name && item.persona === agent.persona.trim())
        ) {
          registry.deleteAgent(agent.id);
        }
      }
      toast.success(
        t('study.classmates.imported', {
          created: result.created.length,
          skipped: result.skipped,
        }),
      );
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
      refresh();
    }
  }

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

  const active = data.classmates.filter((classmate) => classmate.status === 'active');
  const archived = data.classmates.filter((classmate) => classmate.status === 'archived');

  const card = (classmate: ClassmateView) => (
    <li
      key={classmate.id}
      data-testid="classmate-card"
      className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4"
    >
      <div
        className="size-12 shrink-0 overflow-hidden rounded-full ring-2"
        style={{ ['--tw-ring-color' as string]: `${classmate.color}66` }}
      >
        <img src={classmate.avatar} alt="" className="size-full object-cover" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-base font-semibold text-foreground">{classmate.name}</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {t(`study.classmates.role.${classmate.role}`)}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(`study.classmates.style.${classmate.learningStyle}`)} ·{' '}
          {t(`study.classmates.speech.${classmate.speechPolicy}`)}
          {classmate.materialIds.length > 0
            ? ` · ${t('study.classmates.materialCount', { count: classmate.materialIds.length })}`
            : ''}
        </p>
        {classmate.persona ? (
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
            {classmate.persona}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-1">
        {classmate.status === 'active' ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('study.classmates.edit')}
              onClick={() => setEditing(classmate)}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('study.classmates.archive')}
              disabled={busy}
              onClick={() => void setStatus(classmate, 'archived')}
            >
              <Archive className="size-4" />
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void setStatus(classmate, 'active')}
          >
            <RotateCcw className="mr-1.5 size-4" />
            {t('study.classmates.restore')}
          </Button>
        )}
      </div>
    </li>
  );

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
            {t('study.classmates.title')}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t('study.classmates.subtitle')}
          </p>
        </div>
        <div className="flex gap-2">
          {importable > 0 ? (
            <Button variant="outline" disabled={busy} onClick={() => void importLocal()}>
              <Upload className="mr-1.5 size-4" />
              {t('study.classmates.importLocal', { count: importable })}
            </Button>
          ) : null}
          <Button onClick={() => setEditing('new')} data-testid="classmate-create">
            <Plus className="mr-1.5 size-4" />
            {t('study.classmates.create')}
          </Button>
        </div>
      </header>

      {active.length === 0 ? (
        <div
          data-testid="classmates-empty"
          className="rounded-2xl border border-dashed border-border px-6 py-14 text-center text-sm leading-6 text-muted-foreground"
        >
          {t('study.classmates.empty')}
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">{active.map(card)}</ul>
      )}
      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        {t('study.classmates.howToUse')}
      </p>

      {archived.length > 0 ? (
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            {t('study.classmates.archivedTitle')}
          </h2>
          <ul className="grid gap-3 opacity-80 md:grid-cols-2">{archived.map(card)}</ul>
        </section>
      ) : null}

      {editing ? (
        <ClassmateFormDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          classmate={editing === 'new' ? null : editing}
          defaultIndex={data.classmates.length}
          materials={data.materials}
          onSubmit={save}
        />
      ) : null}
    </StudyShell>
  );
}
