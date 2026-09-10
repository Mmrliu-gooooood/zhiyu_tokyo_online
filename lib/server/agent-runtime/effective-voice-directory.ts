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
  protocol?: 'openai-speech';
  apiKey: string;
  baseUrl?: string;
  requiresApiKey: boolean;
  enabled: boolean;
  modelId: string;
  voice?: string;
  default?: boolean;
  speed?: number;
  format?: string;
  providerOptions?: Record<string, unknown>;
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

export interface EffectiveSessionMediaVoiceConfig {
  version: 1 | 2;
  tts?: readonly EffectiveSessionVoiceConfig[];
  ttsProviders?: readonly EffectiveSessionVoiceConfig[];
  ttsDefault?: EffectiveVoiceBinding;
  ttsVoiceDirectory?: readonly EffectiveVoiceDirectoryEntry[];
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
  content: EffectiveSessionMediaVoiceConfig,
): EffectiveSessionVoiceSource<EffectiveSessionVoiceConfig> {
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
  const providers = resolved.providerConfigs.filter(
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
            ? { default: true, speed: resolved.defaultVoice.speed ?? config.speed }
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
  const modelAware = !!asVoiceSource(source).voiceDirectory;
  const configs = effectiveSessionVoiceConfigs(source).sort((left, right) => {
    if (!!left.default !== !!right.default) return left.default ? -1 : 1;
    return sortKey(left).localeCompare(sortKey(right));
  });

  if (modelAware) {
    const providerShells = new Map<string, VoiceCatalogProvider>();
    const modelsByProvider = new Map<string, Set<string>>();
    const catalog: SessionCatalogVoice[] = [];

    for (const snapshot of configs) {
      const builtIn = TTS_PROVIDERS[snapshot.providerId as keyof typeof TTS_PROVIDERS];
      const models = modelsByProvider.get(snapshot.providerId) ?? new Set<string>();
      models.add(snapshot.modelId);
      modelsByProvider.set(snapshot.providerId, models);

      if (builtIn?.excludeFromAgentVoiceCatalog === true) {
        if (supportsVoiceRegistration(snapshot.providerId)) {
          providerShells.set(snapshot.providerId, {
            id: snapshot.providerId,
            voices: [],
            ...(builtIn.requiresRegisteredVoice ? { requiresRegisteredVoice: true } : {}),
          });
        }
        continue;
      }

      providerShells.set(snapshot.providerId, {
        id: snapshot.providerId,
        voices: [],
        ...(builtIn?.requiresRegisteredVoice ? { requiresRegisteredVoice: true } : {}),
      });
      const voice = builtIn?.voices.find((candidate) => candidate.id === snapshot.voice) ?? {
        id: snapshot.voice,
        name: snapshot.voice,
        language: 'auto',
      };
      catalog.push({
        ...voice,
        providerId: snapshot.providerId,
        modelId: snapshot.modelId,
        binding: '',
      });
    }

    const resolvedSource = asVoiceSource(source);
    const registeredCatalog = buildVoiceCatalog([...providerShells.values()], registeredVoices, {
      supportsClone: [...providerShells.values()].some((provider) =>
        supportsVoiceRegistration(provider.id),
      ),
    });
    for (const voice of registeredCatalog) {
      const models = [...(modelsByProvider.get(voice.providerId) ?? [])].sort();
      const defaultModel =
        resolvedSource.defaultVoice?.providerId === voice.providerId
          ? resolvedSource.defaultVoice.modelId
          : undefined;
      const modelId = defaultModel && models.includes(defaultModel) ? defaultModel : models[0];
      if (modelId) catalog.push({ ...voice, modelId, binding: '' });
    }

    const byTuple = new Map<string, SessionCatalogVoice>();
    for (const voice of catalog) {
      const tuple = `${voice.providerId}\0${voice.modelId}\0${voice.id}`;
      if (!byTuple.has(tuple)) byTuple.set(tuple, voice);
    }
    const distinct = [...byTuple.values()];
    const identityCounts = new Map<string, number>();
    for (const voice of distinct) {
      const legacyIdentity = `${voice.providerId}\0${voice.id}`;
      identityCounts.set(legacyIdentity, (identityCounts.get(legacyIdentity) ?? 0) + 1);
    }

    return distinct
      .map((voice) => ({
        ...voice,
        binding:
          identityCounts.get(`${voice.providerId}\0${voice.id}`) === 1
            ? `${voice.providerId}::${voice.id}`
            : `${voice.providerId}::${voice.modelId}::${voice.id}`,
      }))
      .sort((left, right) =>
        `${left.providerId}\0${left.modelId}\0${left.id}`.localeCompare(
          `${right.providerId}\0${right.modelId}\0${right.id}`,
        ),
      );
  }

  const providers = new Map<string, VoiceCatalogProvider>();
  const modelByVoice = new Map<string, string>();
  const fallbackModel = new Map<string, string>();
  for (const snapshot of configs) {
    const builtIn = TTS_PROVIDERS[snapshot.providerId as keyof typeof TTS_PROVIDERS];
    fallbackModel.set(
      snapshot.providerId,
      fallbackModel.get(snapshot.providerId) ?? snapshot.modelId,
    );
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
