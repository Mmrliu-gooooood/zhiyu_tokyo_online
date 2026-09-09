'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ImageProtocol, VideoProtocol } from '@/lib/media/types';
import { MediaProtocolSelect } from './media-protocol-select';

export function CustomMediaProviderFields({
  kind,
  name,
  protocol,
  requiresApiKey,
  enabled,
  onNameChange,
  onProtocolChange,
  onRequiresKeyChange,
  onEnabledChange,
  onDelete,
}: {
  kind: 'image' | 'video';
  name: string;
  protocol: ImageProtocol | VideoProtocol;
  requiresApiKey: boolean;
  enabled: boolean;
  onNameChange: (name: string) => void;
  onProtocolChange: (protocol: ImageProtocol | VideoProtocol) => void;
  onRequiresKeyChange: (required: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draftName, setDraftName] = useState(name);
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>{t('settings.providerName')}</Label>
        <Input
          id={`${id}-name`}
          value={draftName}
          maxLength={120}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={() => {
            if (draftName.trim()) onNameChange(draftName.trim());
            else setDraftName(name);
          }}
        />
      </div>
      <MediaProtocolSelect kind={kind} value={protocol} onChange={onProtocolChange} />
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-key`}
            checked={requiresApiKey}
            onCheckedChange={(v) => onRequiresKeyChange(v === true)}
          />
          <Label htmlFor={`${id}-key`}>{t('settings.requiresApiKey')}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-enabled`}
            checked={enabled}
            onCheckedChange={(v) => onEnabledChange(v === true)}
          />
          <Label htmlFor={`${id}-enabled`}>{t('settings.mediaProviderEnabled')}</Label>
        </div>
        <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)}>
          {t('settings.deleteProvider')}
        </Button>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.deleteProvider')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.deleteProviderConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>{t('settings.deleteProvider')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
