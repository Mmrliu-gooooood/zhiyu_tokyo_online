'use client';

import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ImageProtocol, VideoProtocol } from '@/lib/media/types';

const protocols: Record<
  'image' | 'video',
  Array<{ id: ImageProtocol | VideoProtocol; label: string }>
> = {
  image: [
    { id: 'openai-images', label: 'OpenAI Images' },
    { id: 'siliconflow-images', label: 'SiliconFlow Images' },
    { id: 'openrouter-images', label: 'OpenRouter Images' },
  ],
  video: [
    { id: 'siliconflow-video', label: 'SiliconFlow Video' },
    { id: 'openrouter-video', label: 'OpenRouter Video' },
  ],
};

export function MediaProtocolSelect({
  kind,
  value,
  onChange,
}: {
  kind: 'image' | 'video';
  value: ImageProtocol | VideoProtocol;
  onChange: (value: ImageProtocol | VideoProtocol) => void;
}) {
  const id = useId();
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t('settings.mediaProtocol')}</Label>
      <select
        id={id}
        value={value}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        onChange={(e) => {
          const option = protocols[kind].find((p) => p.id === e.target.value);
          if (option) onChange(option.id);
        }}
      >
        {protocols[kind].map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">{t('settings.mediaProtocolHint')}</p>
    </div>
  );
}
