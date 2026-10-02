'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Box, Plus, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProviderId, ProviderConfig } from '@/lib/types/provider';
import {
  MONO_LOGO_PROVIDERS,
  PROVIDER_GROUP_ORDER,
} from '@/lib/model-gateway/catalog/client-catalog';
import type { ProviderGroup } from '@/lib/model-gateway/catalog/descriptors';
import { PlatformDefaultListEntry } from './platform-default-panel';

/** Catalog group, or `custom` for user-defined providers. */
export type ProviderListGroup = ProviderGroup | 'custom';

interface ProviderWithServerInfo extends ProviderConfig {
  isServerConfigured?: boolean;
  /** Absent = user-defined (`custom`). */
  group?: ProviderListGroup;
}

interface ProviderListProps {
  providers: ProviderWithServerInfo[];
  selectedProviderId: ProviderId;
  onSelect: (providerId: ProviderId) => void;
  onAddProvider: () => void;
  width?: number;
  platformDefaultSelected?: boolean;
  onSelectPlatformDefault?: () => void;
}

const GROUP_ORDER: readonly ProviderListGroup[] = [...PROVIDER_GROUP_ORDER, 'custom'];

export function browseProviderDetails<T extends string>(
  providerId: T,
  onBrowse: (id: T) => void,
  onLeavePlatformDefault: () => void,
) {
  onLeavePlatformDefault();
  onBrowse(providerId);
}

/** Providers grouped in display order, filtered by a case-insensitive query. */
export function groupProviders<T extends { id: string; group?: ProviderListGroup }>(
  providers: readonly T[],
  query: string,
  displayName: (provider: T) => string,
): Array<{ group: ProviderListGroup; providers: T[] }> {
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? providers.filter(
        (provider) =>
          provider.id.toLowerCase().includes(needle) ||
          displayName(provider).toLowerCase().includes(needle),
      )
    : providers;
  return GROUP_ORDER.map((group) => ({
    group,
    providers: matches.filter((provider) => (provider.group ?? 'custom') === group),
  })).filter((entry) => entry.providers.length > 0);
}

export function ProviderList({
  providers,
  selectedProviderId,
  onSelect,
  onAddProvider,
  width,
  platformDefaultSelected = false,
  onSelectPlatformDefault,
}: ProviderListProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  // Helper function to get translated provider name
  const getProviderDisplayName = (provider: ProviderConfig) => {
    const translationKey = `settings.providerNames.${provider.id}`;
    const translated = t(translationKey);
    // If translation exists (not equal to key), use it; otherwise fallback to provider.name
    return translated !== translationKey ? translated : provider.name;
  };

  const groups = groupProviders(providers, query, getProviderDisplayName);

  return (
    <div className="flex-shrink-0 bg-background flex flex-col" style={{ width: width ?? 192 }}>
      <div className="px-3 pt-3">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.providerSearchPlaceholder')}
            aria-label={t('settings.providerSearchPlaceholder')}
            className="h-8 pl-7 text-sm"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {onSelectPlatformDefault && !query.trim() && (
          <PlatformDefaultListEntry
            selected={platformDefaultSelected}
            onSelect={onSelectPlatformDefault}
          />
        )}
        {groups.map(({ group, providers: members }) => (
          <div key={group} className="space-y-1.5" data-provider-group={group}>
            <div className="px-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t(`settings.providerGroups.${group}`)}
            </div>
            {members.map((provider) => (
              <button
                type="button"
                key={provider.id}
                onClick={() => onSelect(provider.id)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-all border text-left',
                  !platformDefaultSelected && selectedProviderId === provider.id
                    ? 'bg-primary/5 border-primary/50 shadow-sm'
                    : 'border-transparent hover:bg-muted/50',
                )}
              >
                {provider.icon ? (
                  <img
                    src={provider.icon}
                    alt={getProviderDisplayName(provider)}
                    className={cn(
                      'w-5 h-5 rounded',
                      MONO_LOGO_PROVIDERS.has(provider.id) && 'dark:invert',
                    )}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <Box className="h-5 w-5 text-muted-foreground" />
                )}
                <span className="font-medium text-sm flex-1 truncate">
                  {getProviderDisplayName(provider)}
                </span>
                {provider.isServerConfigured && (
                  <span className="text-[10px] px-1 py-0 h-4 leading-4 rounded shrink-0 bg-muted text-muted-foreground">
                    {t('settings.serverConfigured')}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">
            {t('settings.providerSearchNoMatch')}
          </p>
        )}
      </div>

      {/* Add Provider Button */}
      <div className="p-3 border-t">
        <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={onAddProvider}>
          <Plus className="h-3.5 w-3.5" />
          {t('settings.addProviderButton')}
        </Button>
      </div>
    </div>
  );
}
