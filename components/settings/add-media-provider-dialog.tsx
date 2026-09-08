'use client';

import { useId, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/hooks/use-i18n';
import { isImageProtocol, isVideoProtocol } from '@/lib/media/provider-catalog';
import type { ImageProtocol, VideoProtocol } from '@/lib/media/types';
import { MediaProtocolSelect } from './media-protocol-select';

type NewMediaProvider = { name: string; baseUrl: string; requiresApiKey: boolean } & (
  | { kind: 'image'; protocol: ImageProtocol }
  | { kind: 'video'; protocol: VideoProtocol }
);

export function AddMediaProviderDialog({
  kind,
  onClose,
  onAdd,
}: {
  kind: 'image' | 'video';
  onClose: () => void;
  onAdd: (data: NewMediaProvider) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [protocol, setProtocol] = useState<ImageProtocol | VideoProtocol>(
    kind === 'image' ? 'openai-images' : 'siliconflow-video',
  );
  const [requiresApiKey, setRequiresApiKey] = useState(true);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogTitle>{t('settings.addCustomMediaProvider')}</DialogTitle>
        <DialogDescription>{t('settings.customMediaProviderHint')}</DialogDescription>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            let url: URL;
            try {
              url = new URL(baseUrl.trim());
            } catch {
              return;
            }
            if (
              !name.trim() ||
              !['http:', 'https:'].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.search ||
              url.hash
            )
              return;
            const common = {
              name: name.trim(),
              baseUrl: baseUrl.trim().replace(/\/+$/, ''),
              requiresApiKey,
            };
            if (kind === 'image' && isImageProtocol(protocol)) onAdd({ ...common, kind, protocol });
            else if (kind === 'video' && isVideoProtocol(protocol))
              onAdd({ ...common, kind, protocol });
            else return;
            onClose();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`${id}-name`}>{t('settings.providerName')}</Label>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              autoFocus
            />
          </div>
          <MediaProtocolSelect kind={kind} value={protocol} onChange={setProtocol} />
          <div className="space-y-2">
            <Label htmlFor={`${id}-url`}>Base URL</Label>
            <Input
              id={`${id}-url`}
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              required
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-key`}
              checked={requiresApiKey}
              onCheckedChange={(v) => setRequiresApiKey(v === true)}
            />
            <Label htmlFor={`${id}-key`}>{t('settings.requiresApiKey')}</Label>
          </div>
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('settings.cancelEdit')}
            </Button>
            <Button type="submit" disabled={!name.trim() || !baseUrl.trim()}>
              {t('settings.addProviderButton')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
