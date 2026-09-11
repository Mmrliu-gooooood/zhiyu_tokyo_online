import type { ModelSelection, PlatformDefaultCatalog } from '@/lib/types/platform-default-models';

interface TTSAvailabilityConfig {
  enabled?: boolean;
  isServerConfigured?: boolean;
  serverDisabled?: boolean;
}

/**
 * Present the selected platform TTS binding as usable to voice-selection code
 * without marking the user's same-vendor configuration as server-managed.
 */
export function withPlatformTTSAvailability<
  T extends Record<string, TTSAvailabilityConfig | undefined>,
>(config: T, selection: ModelSelection | undefined, catalog: PlatformDefaultCatalog | null): T {
  if (selection?.source !== 'platform') return config;
  const entry = catalog?.entries.find(
    (candidate) => candidate.defaultId === selection.defaultId && candidate.capability === 'tts',
  );
  if (!entry?.available) return config;
  return {
    ...config,
    [entry.providerId]: {
      ...config[entry.providerId],
      enabled: true,
      isServerConfigured: true,
      serverDisabled: false,
    },
  } as T;
}

export function platformTTSRequestFields(
  selection: ModelSelection | undefined,
  selectedProviderId: string,
  platformProviderId: string,
  selectedModelId?: string,
  platformModelId?: string,
  voiceBinding?: {
    source?: 'platform' | 'user' | 'legacy-managed';
    defaultId?: string;
  },
):
  | { modelSource: 'platform'; platformDefaultId: string }
  | { modelSource: 'user' | 'legacy-managed' } {
  // A roster/role voice binding is more specific than the global setting. New
  // bindings always carry their source, preventing same-vendor/model equality
  // from silently switching credential owners.
  if (voiceBinding?.source === 'platform' && voiceBinding.defaultId) {
    return { modelSource: 'platform', platformDefaultId: voiceBinding.defaultId };
  }
  if (voiceBinding?.source === 'user' || voiceBinding?.source === 'legacy-managed') {
    return { modelSource: voiceBinding.source };
  }
  if (voiceBinding) {
    // Pre-source role bindings came from the user's local roster/settings. They
    // are never authority to borrow a newly introduced platform credential.
    return { modelSource: 'user' };
  }
  if (
    selection?.source === 'platform' &&
    selectedProviderId === platformProviderId &&
    (!selectedModelId || !platformModelId || selectedModelId === platformModelId)
  ) {
    return { modelSource: 'platform', platformDefaultId: selection.defaultId };
  }
  return { modelSource: 'user' };
}
