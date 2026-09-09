'use client';

import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useI18n } from '@/lib/hooks/use-i18n';

export function GenerationExitDialog({
  open,
  cancelling,
  cancelError,
  onContinueInBackground,
  onCancelAndReturn,
  onStay,
}: {
  readonly open: boolean;
  readonly cancelling: boolean;
  readonly cancelError: Error | null;
  readonly onContinueInBackground: () => void;
  readonly onCancelAndReturn: () => void;
  readonly onStay: () => void;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => !nextOpen && !cancelling && onStay()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(cancelling ? 'generation.exitCancellingTitle' : 'generation.exitDialogTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('generation.exitDialogDesc')}</AlertDialogDescription>
        </AlertDialogHeader>
        {cancelError ? (
          <p role="alert" className="text-sm text-destructive">
            {t('generation.exitCancelFailed')}
          </p>
        ) : null}
        <AlertDialogFooter className="sm:grid sm:grid-cols-1">
          <AlertDialogCancel disabled={cancelling}>{t('generation.exitStay')}</AlertDialogCancel>
          <Button
            type="button"
            variant="outline"
            onClick={onContinueInBackground}
            disabled={cancelling}
          >
            {t('generation.exitContinueInBackground')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onCancelAndReturn}
            disabled={cancelling}
          >
            {t(cancelling ? 'generation.exitCancelling' : 'generation.exitCancelAndReturn')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
