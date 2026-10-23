'use client';

import { Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { deleteSlideElement } from './use-slide-surface';

/** Trash button for the anchored bars — deletes the element and clears the selection. */
export function DeleteButton({ elementId }: { readonly elementId: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      aria-label={t('edit.delete')}
      // preventDefault on mousedown keeps the canvas selection alive until the
      // click fires; the op then deletes the element.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => deleteSlideElement(elementId)}
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-mistake-soft hover:text-mistake-ink"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}
