'use client';

/**
 * Advanced option of the classmate form (learning plan B05): which model the
 * classmate answers with in after-class chats and in live classroom replies.
 * Default = inherit the student's current model. A custom choice names an
 * existing connection only (platform default, a signed-in account or a
 * server-configured provider) — never a key — and does not change lecture
 * lines a course already generated.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/hooks/use-i18n';
import { studyRequest } from '@/lib/study/spaces/client';
import type { ClassmateModelChoice, ClassmateModelPolicy } from '@/lib/study/classmates/contracts';

interface ModelOptions {
  platform: Array<{ defaultId: string; label: string; available: boolean }>;
  credentials: Array<{ credentialId: string; providerId: string; label: string; status: string }>;
  server: Array<{ providerId: string; models: string[] }>;
}

type Source =
  | { kind: 'platform'; defaultId: string }
  | { kind: 'credential'; credentialId: string; providerId: string }
  | { kind: 'server'; providerId: string };

function sourceKey(source: Source | ClassmateModelChoice): string {
  return source.kind === 'platform'
    ? `platform:${source.defaultId}`
    : source.kind === 'credential'
      ? `credential:${source.credentialId}`
      : `server:${source.providerId}`;
}

export function ClassmateModelPolicyField({
  value,
  onChange,
}: {
  value: ClassmateModelPolicy;
  onChange: (value: ClassmateModelPolicy) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(value.mode === 'custom');
  const [options, setOptions] = useState<ModelOptions | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || options) return;
    studyRequest<{ options: ModelOptions }>('/api/study/classmates/model-options')
      .then((body) => setOptions(body.options))
      .catch(() => setFailed(true));
  }, [open, options]);

  const sources: Array<{ source: Source; label: string; disabled: boolean }> = options
    ? [
        ...options.platform.map((entry) => ({
          source: { kind: 'platform' as const, defaultId: entry.defaultId },
          label: t('study.classmates.model.platform', { label: entry.label }),
          disabled: !entry.available,
        })),
        ...options.credentials.map((entry) => ({
          source: {
            kind: 'credential' as const,
            credentialId: entry.credentialId,
            providerId: entry.providerId,
          },
          label: t('study.classmates.model.account', { label: entry.label }),
          disabled: entry.status !== 'active',
        })),
        ...options.server.map((entry) => ({
          source: { kind: 'server' as const, providerId: entry.providerId },
          label: t('study.classmates.model.server', { label: entry.providerId }),
          disabled: false,
        })),
      ]
    : [];
  const current = value.mode === 'custom' ? value.model : null;
  const currentKey = current ? sourceKey(current) : 'inherit';
  const serverModels =
    current?.kind === 'server'
      ? (options?.server.find((entry) => entry.providerId === current.providerId)?.models ?? [])
      : [];

  const choose = (key: string) => {
    if (key === 'inherit') {
      onChange({ mode: 'inherit' });
      return;
    }
    const found = sources.find((entry) => sourceKey(entry.source) === key)?.source;
    if (!found) return;
    if (found.kind === 'platform') {
      onChange({ mode: 'custom', model: found });
    } else if (found.kind === 'server') {
      const models = options?.server.find((entry) => entry.providerId === found.providerId)?.models;
      onChange({
        mode: 'custom',
        model: { kind: 'server', providerId: found.providerId, modelId: models?.[0] ?? '' },
      });
    } else {
      onChange({ mode: 'custom', model: { ...found, modelId: '' } });
    }
  };

  const setModelId = (modelId: string) => {
    if (!current || current.kind === 'platform') return;
    onChange({ mode: 'custom', model: { ...current, modelId } });
  };

  return (
    <div className="space-y-1.5" data-testid="classmate-model-policy">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-sm font-medium"
        onClick={() => setOpen((state) => !state)}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        {t('study.classmates.model.title')}
      </button>
      {open ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs leading-5 text-muted-foreground">
            {t('study.classmates.model.hint')}
          </p>
          <Label className="text-xs">{t('study.classmates.model.label')}</Label>
          <select
            className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={currentKey}
            onChange={(event) => choose(event.target.value)}
            data-testid="classmate-model-select"
          >
            <option value="inherit">{t('study.classmates.model.inherit')}</option>
            {sources.map((entry) => (
              <option
                key={sourceKey(entry.source)}
                value={sourceKey(entry.source)}
                disabled={entry.disabled}
              >
                {entry.label}
                {entry.disabled ? ` (${t('study.classmates.model.unavailable')})` : ''}
              </option>
            ))}
            {current && !sources.some((entry) => sourceKey(entry.source) === currentKey) ? (
              <option value={currentKey}>
                {options ? t('study.classmates.model.saved') : '…'}
              </option>
            ) : null}
          </select>
          {current && current.kind !== 'platform' ? (
            serverModels.length ? (
              <select
                className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={current.modelId}
                onChange={(event) => setModelId(event.target.value)}
              >
                {serverModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                value={current.modelId}
                onChange={(event) => setModelId(event.target.value.trim())}
                placeholder={t('study.classmates.model.modelIdPlaceholder')}
              />
            )
          ) : null}
          {failed ? (
            <p className="text-xs text-destructive">{t('study.classmates.model.loadFailed')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
