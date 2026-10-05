'use client';

/**
 * The "学习资料" section of a subject space (learning plan B02): upload into
 * the space, add from the library, see parse state, read, remove from the
 * space (the material stays in the library).
 */
import { useEffect, useState } from 'react';
import { LoaderCircle, Plus } from 'lucide-react';
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
import { useI18n } from '@/lib/hooks/use-i18n';
import { materialsApi } from '@/lib/study/materials/client';
import type { StudyMaterialSummary } from '@/lib/study/materials/contracts';

import { AddMaterialsDialog } from './AddMaterialsDialog';
import { MaterialList } from './MaterialList';
import { MaterialUploadButton } from './MaterialUploadButton';
import { isParseActive, usePollWhile } from './material-format';

export function SpaceMaterialsSection({
  spaceId,
  archived,
}: {
  spaceId: string;
  archived: boolean;
}) {
  const { t } = useI18n();
  const [materials, setMaterials] = useState<StudyMaterialSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<StudyMaterialSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    materialsApi
      .list(spaceId)
      .then((list) => {
        if (cancelled) return;
        setMaterials(list);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [spaceId, loadKey]);

  const refresh = () => setLoadKey((key) => key + 1);
  usePollWhile(
    (materials ?? []).some((material) => isParseActive(material.current.parseState)),
    refresh,
  );

  return (
    <section className="mt-10" data-testid="study-space-materials">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">
          {t('study.materials.sectionTitle')}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {materials?.length ?? ''}
          </span>
        </h2>
        {!archived ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddOpen(true)}
              data-testid="study-add-materials"
            >
              <Plus className="mr-1 size-4" />
              {t('study.materials.addExisting')}
            </Button>
            <MaterialUploadButton spaceId={spaceId} onUploaded={refresh} />
          </div>
        ) : null}
      </div>

      {failed ? (
        <div className="rounded-2xl border border-dashed border-border px-6 py-8 text-center text-sm text-muted-foreground">
          {t('study.state.error')}{' '}
          <button type="button" className="underline" onClick={refresh}>
            {t('common.retry')}
          </button>
        </div>
      ) : materials === null ? (
        <div className="flex justify-center py-8">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : materials.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm leading-6 text-muted-foreground">
          {archived ? t('study.materials.emptyArchived') : t('study.materials.emptySpace')}
        </div>
      ) : (
        <MaterialList
          materials={materials}
          actions={(material) => (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => setRemoveTarget(material)}
              data-testid="study-material-remove-from-space"
            >
              {t('study.materials.removeFromSpace')}
            </Button>
          )}
        />
      )}

      {addOpen ? (
        <AddMaterialsDialog open onOpenChange={setAddOpen} spaceId={spaceId} onAdded={refresh} />
      ) : null}

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('study.materials.removeFromSpaceTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('study.materials.removeFromSpaceText', { name: removeTarget?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = removeTarget;
                setRemoveTarget(null);
                if (!target) return;
                void materialsApi
                  .unlink(spaceId, target.materialId)
                  .then(refresh)
                  .catch(() => toast.error(t('study.errors.generic')));
              }}
            >
              {t('study.materials.removeFromSpace')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
