import { TTS_PROVIDERS } from '@/lib/audio/constants';
import {
  buildVoiceCatalog,
  type CatalogVoice,
  type RegisteredVoiceInfo,
  type VoiceCatalogProvider,
} from '@/lib/audio/voice-catalog';
import { supportsVoiceRegistration } from '@/lib/audio/voice-registration';
import { getServerTTSProviders, resolveTTSApiKey } from '@/lib/server/provider-config';
import type { MediaConfigSnapshotContent } from '@/lib/server/media-config-snapshots';

export interface EffectiveSessionVoiceConfig {
  providerId: string;
  apiKey: string;
  requiresApiKey: boolean;
  enabled: boolean;
  modelId: string;
  voice?: string;
  default?: boolean;
}

export interface EffectiveVoiceDirectoryEntry {
  providerId: string;
  modelId: string;
  voiceIds: readonly string[];
}

export interface EffectiveVoiceBinding {
  providerId: string;
  modelId: string;
  voiceId: string;
  speed?: number;
}

export interface EffectiveSessionVoiceSource<
  T extends EffectiveSessionVoiceConfig = EffectiveSessionVoiceConfig,
> {
  providerConfigs: readonly T[];
  voiceDirectory?: readonly EffectiveVoiceDirectoryEntry[];
  defaultVoice?: EffectiveVoiceBinding;
}

export interface SessionCatalogVoice extends CatalogVoice {
  modelId?: string;
}

function sortKey(config: EffectiveSessionVoiceConfig) {
  return `${config.providerId}\0${config.modelId}\0${config.voice ?? ''}`;
}

function asVoiceSource<T extends EffectiveSessionVoiceConfig>(
  source: readonly T[] | EffectiveSessionVoiceSource<T>,
): EffectiveSessionVoiceSource<T> {
  return Array.isArray(source)
    ? { providerConfigs: source }
    : (source as EffectiveSessionVoiceSource<T>);
}

/** Preserve v1's exact entries; v2 keeps providers, directory and binding separate. */
export function mediaConfigVoiceSource(
  content: MediaConfigSnapshotContent,
): EffectiveSessionVoiceSource<
  EffectiveSessionVoiceConfig & Record<string, unknown>
> {
  if (content.version === 2) {
    return {
      providerConfigs: content.ttsProviders ?? [],
      voiceDirectory: content.ttsVoiceDirectory,
      defaultVoice: content.ttsDefault,
    };
  }
  return { providerConfigs: content.tts ?? [] };
}

/** The deterministic, synthesizable subset of a session's encrypted snapshot. */
export function effectiveSessionVoiceConfigs<T extends EffectiveSessionVoiceConfig>(
  source: readonly T[] | EffectiveSessionVoiceSource<T>,
): Array<T & { voice: string }> {
  const resolved = asVoiceSource(source);
  const providers = resolved.providerConfigs
    .filter(
      (config) =>
        config.enabled &&
        !getServerTTSProviders()[config.providerId]?.disabled &&
        (!config.requiresApiKey || !!resolveTTSApiKey(config.providerId, config.apiKey)),
    );
  const available = resolved.voiceDirectory
    ? resolved.voiceDirectory.flatMap((entry) => {
        const config = providers.find(
          (candidate) =>
            candidate.providerId === entry.providerId && candidate.modelId === entry.modelId,
        );
        if (!config) return [];
        return entry.voiceIds.map((voice) => ({
          ...config,
          voice,
          ...(resolved.defaultVoice?.providerId === entry.providerId &&
          resolved.defaultVoice.modelId === entry.modelId &&
          resolved.defaultVoice.voiceId === voice
            ? { default: true }
            : {}),
        }));
      })
    : providers.flatMap((config) => (config.voice ? [{ ...config, voice: config.voice }] : []));
  return available.sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
}

/** Resolve a roster binding or the explicit session default from the same directory. */
export function resolveEffectiveSessionVoice<T extends EffectiveSessionVoiceConfig>(
  source: readonly T[] | EffectiveSessionVoiceSource<T>,
  binding?: { providerId?: string; modelId?: string; voiceId?: string },
): (T & { voice: string }) | undefined {
  const available = effectiveSessionVoiceConfigs(source);
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
  source:
    | readonly EffectiveSessionVoiceConfig[]
    | EffectiveSessionVoiceSource<EffectiveSessionVoiceConfig>,
  registeredVoices: RegisteredVoiceInfo[] = [],
): SessionCatalogVoice[] {
  const modelAware = !Array.isArray(source) && !!source.voiceDirectory;
  const providers = new Map<string, VoiceCatalogProvider>();
  const configs = effectiveSessionVoiceConfigs(source).sort((left, right) => {
    if (!!left.default !== !!right.default) return left.default ? -1 : 1;
    return sortKey(left).localeCompare(sortKey(right));
  });
  const modelByVoice = new Map<string, string>();
  const fallbackModel = new Map<string, string>();
  for (const snapshot of configs) {
    const builtIn = TTS_PROVIDERS[snapshot.providerId as keyof typeof TTS_PROVIDERS];
    fallbackModel.set(snapshot.providerId, fallbackModel.get(snapshot.providerId) ?? snapshot.modelId);
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
      modelByVoice.set(`${snapshot.providerId}\0${voice.id}`, snapshot.modelId);
    }
    providers.set(snapshot.providerId, current);
  }
  const ordered = [...providers.values()].sort((left, right) => left.id.localeCompare(right.id));
  return buildVoiceCatalog(ordered, registeredVoices, {
    supportsClone: ordered.some((provider) => supportsVoiceRegistration(provider.id)),
  }).flatMap((voice) => {
    const modelId =
      modelByVoice.get(`${voice.providerId}\0${voice.id}`) ?? fallbackModel.get(voice.providerId);
    return modelId ? [{ ...voice, ...(modelAware ? { modelId } : {}) }] : [];
  });
}
