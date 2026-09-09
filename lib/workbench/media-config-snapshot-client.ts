import type { MediaConfigRef } from '@/lib/server/generation-jobs/contracts';
import type { SettingsState } from '@/lib/store/settings';
import { TTS_PROVIDERS } from '@/lib/audio/constants';

const REVOKE_KEY = 'openmaic:media-config-revoke-pending';
let pendingRevocation: Promise<void> | undefined;

interface SnapshotConfig {
  version: 1;
  imageEnabled: boolean;
  videoEnabled: boolean;
  ttsEnabled: boolean;
  image?: Record<string, unknown>;
  video?: Record<string, unknown>;
  tts?: Array<Record<string, unknown>>;
}

interface SnapshotVoiceBinding {
  providerId: string;
  modelId?: string;
  voiceId: string;
}

function effectiveBaseUrl(config: { baseUrl?: string; customDefaultBaseUrl?: string }): string {
  return config.baseUrl?.trim() || config.customDefaultBaseUrl?.trim() || '';
}

/** Freeze the user's media intent and only the provider configurations referenced by the next run. */
export function buildMediaConfigSnapshot(
  settings: SettingsState,
  roleVoices: readonly SnapshotVoiceBinding[] = [],
): SnapshotConfig | undefined {
  const snapshot: SnapshotConfig = {
    version: 1,
    imageEnabled: settings.imageGenerationEnabled,
    videoEnabled: settings.videoGenerationEnabled,
    ttsEnabled: settings.ttsEnabled,
  };

  if (settings.imageGenerationEnabled) {
    const config = settings.imageProvidersConfig[settings.imageProviderId];
    snapshot.image = {
      providerId: settings.imageProviderId,
      ...(settings.imageProviderId.startsWith('custom-image-')
        ? { protocol: config?.protocol }
        : {}),
      apiKey: config?.apiKey || '',
      baseUrl: effectiveBaseUrl(config ?? {}),
      enabled: config?.enabled ?? false,
      requiresApiKey: config?.requiresApiKey ?? true,
      modelId: settings.imageModelId,
    };
  }

  if (settings.videoGenerationEnabled) {
    const config = settings.videoProvidersConfig[settings.videoProviderId];
    snapshot.video = {
      providerId: settings.videoProviderId,
      ...(settings.videoProviderId.startsWith('custom-video-')
        ? { protocol: config?.protocol }
        : {}),
      apiKey: config?.apiKey || '',
      baseUrl: effectiveBaseUrl(config ?? {}),
      enabled: config?.enabled ?? false,
      requiresApiKey: config?.requiresApiKey ?? true,
      modelId: settings.videoModelId,
    };
  }

  const tts = new Map<string, Record<string, unknown>>();
  const addTts = (
    providerId: string,
    modelId: string | undefined,
    voice: string,
    speed: number,
    isDefault = false,
  ) => {
    if (providerId === 'browser-native-tts') return;
    const config =
      settings.ttsProvidersConfig[providerId as keyof typeof settings.ttsProvidersConfig];
    const builtIn = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
    const item = {
      providerId,
      ...(providerId.startsWith('custom-tts-')
        ? { protocol: config?.protocol ?? 'openai-speech' }
        : {}),
      apiKey: config?.apiKey || '',
      baseUrl: effectiveBaseUrl(config ?? {}),
      enabled: config?.enabled ?? false,
      requiresApiKey: config?.requiresApiKey ?? builtIn?.requiresApiKey ?? true,
      modelId: modelId?.trim() || config?.modelId || builtIn?.defaultModelId || '',
      voice,
      ...(isDefault ? { default: true } : {}),
      speed,
      ...(config?.providerOptions ? { providerOptions: config.providerOptions } : {}),
    };
    tts.set(`${providerId}\0${item.modelId}\0${voice}`, item);
  };
  if (settings.ttsEnabled) {
    addTts(
      settings.ttsProviderId,
      settings.ttsProvidersConfig[settings.ttsProviderId]?.modelId,
      settings.ttsVoice,
      settings.ttsSpeed,
      true,
    );
    for (const voice of roleVoices) {
      addTts(voice.providerId, voice.modelId, voice.voiceId, settings.ttsSpeed);
    }
  }
  if (tts.size) snapshot.tts = [...tts.values()];

  return snapshot;
}

export async function syncCurrentMediaConfigSnapshot(
  roleVoices: readonly SnapshotVoiceBinding[] = [],
): Promise<MediaConfigRef | undefined> {
  await flushMediaConfigRevocations();
  const { useSettingsStore } = await import('@/lib/store/settings');
  const snapshot = buildMediaConfigSnapshot(useSettingsStore.getState(), roleVoices);
  if (!snapshot) return undefined;
  const response = await fetch('/api/agent/media-config-snapshots', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ref?.id || !Number.isInteger(body.ref?.revision)) {
    throw new Error(
      typeof body.error === 'string' ? body.error : 'MEDIA_CONFIG_SNAPSHOT_UNAVAILABLE',
    );
  }
  return body.ref as MediaConfigRef;
}

function localStorageOrUndefined(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function pendingRevocationIds(): string[] {
  try {
    const value = JSON.parse(localStorageOrUndefined()?.getItem(REVOKE_KEY) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

async function flushMediaConfigRevocations(): Promise<void> {
  const local = localStorageOrUndefined();
  if (!pendingRevocation && !pendingRevocationIds().length) return;
  const previous = pendingRevocation ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(async () => {
      while (true) {
        const providerInstanceId = pendingRevocationIds()[0];
        if (!providerInstanceId) return;
        const response = await fetch('/api/agent/media-config-snapshots', {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ providerInstanceId }),
        });
        if (!response.ok) throw new Error('MEDIA_CONFIG_REVOKE_FAILED');
        const remaining = pendingRevocationIds().filter((id) => id !== providerInstanceId);
        if (remaining.length) local?.setItem(REVOKE_KEY, JSON.stringify(remaining));
        else local?.removeItem(REVOKE_KEY);
      }
    });
  const tracked = queued.finally(() => {
    if (pendingRevocation === tracked) pendingRevocation = undefined;
  });
  pendingRevocation = tracked;
  return tracked;
}

export async function revokeMediaConfigSnapshotsForProvider(
  providerInstanceId: string,
): Promise<void> {
  const local = localStorageOrUndefined();
  if (!local) {
    const response = await fetch('/api/agent/media-config-snapshots', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerInstanceId }),
    });
    if (!response.ok) throw new Error('MEDIA_CONFIG_REVOKE_FAILED');
    return;
  }
  local.setItem(
    REVOKE_KEY,
    JSON.stringify([...new Set([...pendingRevocationIds(), providerInstanceId])]),
  );
  return flushMediaConfigRevocations();
}
