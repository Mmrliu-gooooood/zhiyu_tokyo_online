import type { ModelSelection, PlatformDefaultCatalog } from '@/lib/types/platform-default-models';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import type { ProviderWithVoices } from '@/lib/audio/voice-resolver';
import { isTTSProviderEnabled, type TTSEnablementConfig } from '@/lib/audio/provider-enablement';
import type { TTSProviderId } from '@/lib/audio/types';

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

/**
 * While a platform TTS default is selected, its provider offers only the
 * platform model's voices, stamped with the platform binding, so a pick never
 * lands on another model of the same vendor. `ownConfig` is the user's own
 * TTS configuration (before withPlatformTTSAvailability): without a usable
 * credential of their own, the provider is marked `platformOnly`.
 */
export function scopeProvidersToPlatformTTS(
  providers: ProviderWithVoices[],
  selection: ModelSelection | undefined,
  catalog: PlatformDefaultCatalog | null,
  ownConfig: Partial<Record<string, TTSEnablementConfig>>,
): ProviderWithVoices[] {
  const entry = availablePlatformTTSEntry(selection, catalog);
  if (!entry) return providers;
  const platformOnly = !isTTSProviderEnabled(
    entry.providerId as TTSProviderId,
    ownConfig[entry.providerId],
  );
  return providers.flatMap((provider) => {
    if (provider.providerId !== entry.providerId) return [provider];
    const group = provider.modelGroups.find((candidate) => candidate.modelId === entry.modelId);
    if (!group || group.voices.length === 0) return [];
    return [
      {
        ...provider,
        source: 'platform' as const,
        defaultId: entry.defaultId,
        revision: entry.revision,
        modelId: entry.modelId,
        ...(platformOnly ? { platformOnly } : {}),
        voices: group.voices,
        modelGroups: [group],
      },
    ];
  });
}

/**
 * A role's voice for a new course: the first usable of its saved pick and its
 * own binding. Under a platform TTS default, a binding on the platform's
 * provider is skipped when it names another default, or when it belongs to
 * the user but their own configuration cannot serve it (as in the picker).
 */
export function roleVoiceBinding<
  T extends { providerId: string; source?: string; defaultId?: string },
>(
  candidates: ReadonlyArray<T | undefined>,
  selection: ModelSelection | undefined,
  catalog: PlatformDefaultCatalog | null,
  ownConfig: Partial<Record<string, TTSEnablementConfig>>,
): T | undefined {
  const entry = availablePlatformTTSEntry(selection, catalog);
  const ownUsable =
    !!entry && isTTSProviderEnabled(entry.providerId as TTSProviderId, ownConfig[entry.providerId]);
  return candidates.find(
    (voice): voice is T =>
      !!voice &&
      !(
        entry &&
        voice.providerId === entry.providerId &&
        (voice.source === 'platform' ? voice.defaultId !== entry.defaultId : !ownUsable)
      ),
  );
}

function availablePlatformTTSEntry(
  selection: ModelSelection | undefined,
  catalog: PlatformDefaultCatalog | null,
) {
  if (selection?.source !== 'platform') return undefined;
  const entry = catalog?.entries.find(
    (candidate) => candidate.defaultId === selection.defaultId && candidate.capability === 'tts',
  );
  return entry?.available ? entry : undefined;
}

/** Stamp newly generated roster voices that came from the advertised platform list. */
export function bindGeneratedPlatformTTSVoices(
  agents: GeneratedAgentConfig[],
  advertisedVoices: readonly { providerId: string; voiceId: string; modelId?: string }[],
  selection: ModelSelection | undefined,
  catalog: PlatformDefaultCatalog | null,
): GeneratedAgentConfig[] {
  if (selection?.source !== 'platform') return agents;
  const entry = catalog?.entries.find((candidate) =>
    candidate.capability === 'tts' && candidate.defaultId === selection.defaultId,
  );
  if (!entry?.available) return agents;
  return agents.map((agent) => {
    const voice = agent.voiceConfig;
    if (
      !voice || voice.source || voice.providerId !== entry.providerId ||
      (voice.modelId && voice.modelId !== entry.modelId) ||
      !advertisedVoices.some((candidate) =>
        candidate.providerId === voice.providerId && candidate.voiceId === voice.voiceId &&
        (!voice.modelId || !candidate.modelId || candidate.modelId === voice.modelId),
      )
    ) return agent;
    return {
      ...agent,
      voiceConfig: {
        ...voice,
        source: 'platform',
        defaultId: entry.defaultId,
        revision: entry.revision,
      },
    };
  });
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
