import { TTS_PROVIDERS } from '@/lib/audio/constants';
import {
  buildVoiceCatalog,
  type CatalogVoice,
  type RegisteredVoiceInfo,
  type VoiceCatalogProvider,
} from '@/lib/audio/voice-catalog';
import { supportsVoiceRegistration } from '@/lib/audio/voice-registration';
import { getServerTTSProviders, resolveTTSApiKey } from '@/lib/server/provider-config';

export interface EffectiveSessionVoiceConfig {
  providerId: string;
  apiKey: string;
  requiresApiKey: boolean;
  enabled: boolean;
  modelId: string;
  voice: string;
  default?: boolean;
}

function sortKey(config: EffectiveSessionVoiceConfig) {
  return `${config.providerId}\0${config.modelId}\0${config.voice}`;
}

/** The deterministic, synthesizable subset of a session's encrypted snapshot. */
export function effectiveSessionVoiceConfigs<T extends EffectiveSessionVoiceConfig>(
  configs: readonly T[],
): T[] {
  return configs
    .filter(
      (config) =>
        config.enabled &&
        !getServerTTSProviders()[config.providerId]?.disabled &&
        (!config.requiresApiKey || !!resolveTTSApiKey(config.providerId, config.apiKey)),
    )
    .sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
}

/** Resolve a roster binding or the explicit session default from the same directory. */
export function resolveEffectiveSessionVoice<T extends EffectiveSessionVoiceConfig>(
  configs: readonly T[],
  binding?: { providerId?: string; modelId?: string; voiceId?: string },
): T | undefined {
  const available = effectiveSessionVoiceConfigs(configs);
  if (binding?.providerId) {
    return available.find(
      (config) =>
        config.providerId === binding.providerId &&
        (!binding.modelId || config.modelId === binding.modelId) &&
        (!binding.voiceId || config.voice === binding.voiceId),
    );
  }
  return available.find((config) => config.default) ?? available[0];
}

/** Build list_voices/set_roster's catalog from that exact effective directory. */
export function sessionVoiceCatalog(
  configs: readonly EffectiveSessionVoiceConfig[],
  registeredVoices: RegisteredVoiceInfo[] = [],
): CatalogVoice[] {
  const providers = new Map<string, VoiceCatalogProvider>();
  for (const snapshot of effectiveSessionVoiceConfigs(configs)) {
    const builtIn = TTS_PROVIDERS[snapshot.providerId as keyof typeof TTS_PROVIDERS];
    if (builtIn?.excludeFromAgentVoiceCatalog === true) {
      if (supportsVoiceRegistration(snapshot.providerId)) {
        providers.set(snapshot.providerId, { id: snapshot.providerId, voices: [] });
      }
      continue;
    }
    const voice = builtIn?.voices.find((candidate) => candidate.id === snapshot.voice) ?? {
      id: snapshot.voice,
      name: snapshot.voice,
      language: 'auto',
    };
    const current = providers.get(snapshot.providerId) ?? {
      id: snapshot.providerId,
      voices: [],
    };
    if (!current.voices.some((candidate) => candidate.id === voice.id)) {
      current.voices.push(voice);
    }
    providers.set(snapshot.providerId, current);
  }
  const ordered = [...providers.values()].sort((left, right) => left.id.localeCompare(right.id));
  return buildVoiceCatalog(ordered, registeredVoices, {
    supportsClone: ordered.some((provider) => supportsVoiceRegistration(provider.id)),
  });
}
