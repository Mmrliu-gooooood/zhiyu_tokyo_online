'use client';

import { CheckCircle2, CircleAlert, Cloud, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type {
  PlatformDefaultCapability,
  PlatformDefaultCatalogEntry,
} from '@/lib/types/platform-default-models';

interface PlatformDefaultPanelProps {
  capability: PlatformDefaultCapability;
  entry?: PlatformDefaultCatalogEntry;
  catalogStatus: 'idle' | 'ready' | 'error';
  isSelected: boolean;
  onUse: () => void;
}

export function PlatformDefaultListEntry({
  selected,
  onSelect,
}: {
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();

  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-all border text-left',
          selected
            ? 'bg-primary/5 border-primary/50 shadow-sm'
            : 'border-transparent hover:bg-muted/50',
        )}
      >
        <Cloud className="h-5 w-5 text-primary" aria-hidden="true" />
        <span className="font-medium text-sm flex-1 truncate">{t('settings.defaultModel')}</span>
      </button>
      <div className="mx-2 my-2 border-t border-border/70" />
    </>
  );
}

export function PlatformDefaultPanel({
  capability,
  entry,
  catalogStatus,
  isSelected,
  onUse,
}: PlatformDefaultPanelProps) {
  const { t } = useI18n();
  const available = catalogStatus === 'ready' && entry?.available === true;
  const statusKey =
    catalogStatus === 'idle'
      ? 'loading'
      : catalogStatus === 'error'
        ? 'loadError'
        : entry?.status === 'available'
          ? 'available'
          : entry?.status === 'disabled'
            ? 'disabled'
            : 'notConfigured';

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="rounded-xl border border-border/70 bg-muted/20 p-5">
        <div className="mb-5 flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Cloud className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-base font-semibold">
              {t(`settings.platformDefault.titles.${capability}`)}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('settings.platformDefault.credentialsProvided')}
            </p>
          </div>
        </div>

        <dl className="space-y-3 text-sm">
          <div className="flex gap-2">
            <dt className="shrink-0 text-muted-foreground">
              {t('settings.platformDefault.provider')}
              {t('settings.platformDefault.separator')}
            </dt>
            <dd className="font-medium">{entry?.providerName || '—'}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-muted-foreground">
              {t('settings.platformDefault.model')}
              {t('settings.platformDefault.separator')}
            </dt>
            <dd className="font-medium">{entry?.displayName || '—'}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="shrink-0 text-muted-foreground">
              {t('settings.platformDefault.status')}
              {t('settings.platformDefault.separator')}
            </dt>
            <dd className="flex items-center gap-1.5 font-medium">
              {statusKey === 'loading' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : available ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
              ) : (
                <CircleAlert className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
              )}
              {t(`settings.platformDefault.statuses.${statusKey}`)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="flex items-center justify-between gap-3">
        {isSelected ? (
          <span className="text-sm text-muted-foreground">
            {t('settings.platformDefault.currentlyUsing')}
          </span>
        ) : (
          <span />
        )}
        <Button onClick={onUse} disabled={!available}>
          {t('settings.platformDefault.useThisModel')}
        </Button>
      </div>
    </div>
  );
}
