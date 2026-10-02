'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import {
  CUSTOM_PROVIDER_API_LIST,
  type CustomProviderApi,
} from '@/lib/model-gateway/catalog/descriptors';

/** Legacy settings `type` kept alongside the protocol for older readers. */
export function legacyTypeForApi(api: CustomProviderApi): 'openai' | 'anthropic' {
  return api === 'anthropic-messages' ? 'anthropic' : 'openai';
}

const API_LABEL_KEYS: Record<CustomProviderApi, string> = {
  'openai-completions': 'settings.wireApis.openai-completions',
  'openai-responses': 'settings.wireApis.openai-responses',
  'anthropic-messages': 'settings.wireApis.anthropic-messages',
};

export interface NewProviderData {
  name: string;
  api: CustomProviderApi;
  type: 'openai' | 'anthropic';
  baseUrl: string;
  icon: string;
  requiresApiKey: boolean;
  /** Optional explicit /models URL override (kept for parity; unused by manual form). */
  modelsUrl?: string;
}

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (provider: NewProviderData) => void;
}

export function AddProviderDialog({ open, onOpenChange, onAdd }: AddProviderDialogProps) {
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [api, setApi] = useState<CustomProviderApi>(CUSTOM_PROVIDER_API_LIST[0]);
  const [baseUrl, setBaseUrl] = useState('');
  const [icon, setIcon] = useState('');
  const [requiresApiKey, setRequiresApiKey] = useState(true);

  // Reset form when dialog closes (derived state pattern)
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setName('');
      setApi(CUSTOM_PROVIDER_API_LIST[0]);
      setBaseUrl('');
      setIcon('');
      setRequiresApiKey(true);
    }
  }

  const handleClose = () => onOpenChange(false);
  const handleAdd = () =>
    onAdd({ name, api, type: legacyTypeForApi(api), baseUrl, icon, requiresApiKey });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogTitle className="sr-only">{t('settings.addProviderDialog')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('settings.addProviderDescription')}
        </DialogDescription>
        <div className="space-y-4">
          <div className="pb-3 border-b">
            <h2 className="text-lg font-semibold">{t('settings.addProviderDialog')}</h2>
          </div>

          {/* Provider Name */}
          <div className="space-y-2">
            <Label>{t('settings.providerName')}</Label>
            <Input
              placeholder={t('settings.providerNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* API Mode */}
          <div className="space-y-2">
            <Label>{t('settings.providerApiMode')}</Label>
            <div className="grid grid-cols-3 gap-2">
              {CUSTOM_PROVIDER_API_LIST.map((mode) => (
                <button
                  type="button"
                  key={mode}
                  onClick={() => setApi(mode)}
                  aria-pressed={api === mode}
                  className={cn(
                    'p-2 rounded-lg border text-left text-sm transition-colors',
                    api === mode
                      ? 'bg-primary/5 border-primary/50'
                      : 'hover:bg-muted/50 border-transparent',
                  )}
                >
                  {t(API_LABEL_KEYS[mode])}
                </button>
              ))}
            </div>
          </div>

          {/* Default Base URL */}
          <div className="space-y-2">
            <Label>{t('settings.defaultBaseUrl')}</Label>
            <Input
              type="url"
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          {/* Icon URL */}
          <div className="space-y-2">
            <Label>{t('settings.providerIcon')}</Label>
            <Input
              type="url"
              placeholder="https://example.com/icon.svg"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
            />
          </div>

          {/* Requires API Key */}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="requires-api-key"
              checked={requiresApiKey}
              onCheckedChange={(checked) => setRequiresApiKey(checked as boolean)}
            />
            <label htmlFor="requires-api-key" className="text-sm cursor-pointer">
              {t('settings.requiresApiKey')}
            </label>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t">
            <Button variant="outline" size="sm" onClick={handleClose}>
              {t('settings.cancelEdit')}
            </Button>
            <Button size="sm" onClick={handleAdd} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              {t('settings.addProviderButton')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
