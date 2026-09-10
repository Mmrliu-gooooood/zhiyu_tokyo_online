import {
  getServerProviders,
  getServerTTSProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
  isServerProviderDisabled,
} from '@/lib/server/provider-config';
import type { Queryable } from '@openmaic/storage/document/pg';
import { resolveModel } from '@/lib/server/resolve-model';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import {
  parseCustomImageProviderConfig,
  parseCustomTTSProviderConfig,
  parseCustomVideoProviderConfig,
} from '@/lib/server/media-provider-config';
import {
  resolveImageApiKey,
  resolveImageModel,
  resolveVideoApiKey,
  resolveVideoModel,
  resolveTTSApiKey,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import {
  MediaConfigSnapshotStore,
  type MediaConfigSnapshotContent,
} from '@/lib/server/media-config-snapshots';
import { GenerationJobError, type GenerationInput } from './contracts';
import { GenerationModelSnapshotStore } from '@/lib/server/generation-model-snapshots';
import { GenerationSearchSnapshotStore } from '@/lib/server/generation-search-snapshots';
import { resolveGenerationSearchConfig } from '@/lib/server/generation-pipeline/search';
import { getStageRoute } from '@/lib/server/model-routes';
import {
  mediaConfigVoiceSource,
  resolveEffectiveSessionVoice,
} from '@/lib/server/agent-runtime/effective-voice-directory';

export interface BackgroundProviderValidationContext {
  ownerId: string;
  queryable: Queryable;
}

function snapshotInput<T extends { providerId: string }>(
  config: T,
): Omit<T, 'providerId'> & { id: string } {
  const { providerId, ...value } = config;
  return { ...value, id: providerId };
}

function assertNotDisabled(section: 'image' | 'video' | 'tts', providerId: string): void {
  if (isServerProviderDisabled(section, providerId)) throw new Error('Unavailable provider');
}

function requireImageProvider(
  input: GenerationInput,
  snapshot: MediaConfigSnapshotContent | undefined,
): void {
  const selected = input.media?.image;
  if (!selected) throw new Error('Unavailable provider');
  assertNotDisabled('image', selected.providerId);
  if (snapshot?.imageEnabled === false) throw new Error('Unavailable provider');
  const config = snapshot?.image;
  if (
    snapshot?.imageEnabled === true &&
    (!config || config.providerId !== selected.providerId || config.modelId !== selected.modelId)
  ) {
    throw new Error('Unavailable provider');
  }
  const managed = getServerImageProviders()[selected.providerId];
  if (managed) {
    if (
      managed.disabled ||
      (managed.models?.length && !managed.models.includes(selected.modelId))
    ) {
      throw new Error('Unavailable provider');
    }
    return;
  }
  if (!config || config.providerId !== selected.providerId || config.modelId !== selected.modelId) {
    throw new Error('Unavailable provider');
  }
  if (selected.providerId.startsWith('custom-image-')) {
    parseCustomImageProviderConfig(
      selected.providerId as Parameters<typeof parseCustomImageProviderConfig>[0],
      snapshotInput(config),
      selected.modelId,
    );
    return;
  }
  const provider = IMAGE_PROVIDERS[selected.providerId as keyof typeof IMAGE_PROVIDERS];
  if (!provider || !config.enabled) throw new Error('Unavailable provider');
  if (provider.requiresApiKey && !resolveImageApiKey(selected.providerId, config.apiKey)) {
    throw new Error('Unavailable provider');
  }
  if (provider.models.length && !resolveImageModel(selected.providerId, selected.modelId)) {
    throw new Error('Unavailable provider');
  }
}

function requireVideoProvider(
  input: GenerationInput,
  snapshot: MediaConfigSnapshotContent | undefined,
): void {
  const selected = input.media?.video;
  if (!selected) throw new Error('Unavailable provider');
  assertNotDisabled('video', selected.providerId);
  if (snapshot?.videoEnabled === false) throw new Error('Unavailable provider');
  const config = snapshot?.video;
  if (
    snapshot?.videoEnabled === true &&
    (!config || config.providerId !== selected.providerId || config.modelId !== selected.modelId)
  ) {
    throw new Error('Unavailable provider');
  }
  const managed = getServerVideoProviders()[selected.providerId];
  if (managed) {
    if (managed.disabled) throw new Error('Unavailable provider');
    return;
  }
  if (!config || config.providerId !== selected.providerId || config.modelId !== selected.modelId) {
    throw new Error('Unavailable provider');
  }
  if (selected.providerId.startsWith('custom-video-')) {
    parseCustomVideoProviderConfig(
      selected.providerId as Parameters<typeof parseCustomVideoProviderConfig>[0],
      snapshotInput(config),
      selected.modelId,
    );
    return;
  }
  const provider = VIDEO_PROVIDERS[selected.providerId as keyof typeof VIDEO_PROVIDERS];
  if (!provider || !config.enabled) throw new Error('Unavailable provider');
  if (provider.requiresApiKey && !resolveVideoApiKey(selected.providerId, config.apiKey)) {
    throw new Error('Unavailable provider');
  }
  if (provider.models.length && !resolveVideoModel(selected.providerId, selected.modelId)) {
    throw new Error('Unavailable provider');
  }
}

function requireTTSProvider(
  providerId: string | undefined,
  modelId: string | undefined,
  voice: string | undefined,
  snapshot: MediaConfigSnapshotContent | undefined,
): void {
  if (!providerId) throw new Error('Unavailable provider');
  assertNotDisabled('tts', providerId);
  if (snapshot?.ttsEnabled === false) throw new Error('Unavailable provider');
  const config = snapshot
    ? snapshot.version === 2
      ? resolveEffectiveSessionVoice(mediaConfigVoiceSource(snapshot), {
          providerId,
          modelId,
          voiceId: voice,
        })
      : snapshot.tts?.find(
          (candidate) =>
            candidate.providerId === providerId &&
            (!modelId || candidate.modelId === modelId) &&
            (!voice || candidate.voice === voice),
        )
    : undefined;
  if (snapshot?.ttsEnabled === true && !config) throw new Error('Unavailable provider');
  const managed = getServerTTSProviders()[providerId];
  if (managed) {
    if (managed.disabled) throw new Error('Unavailable provider');
    return;
  }
  if (!config) throw new Error('Unavailable provider');
  if (providerId.startsWith('custom-tts-')) {
    parseCustomTTSProviderConfig(
      providerId as Parameters<typeof parseCustomTTSProviderConfig>[0],
      snapshotInput(config),
    );
    return;
  }
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (!provider || !config.enabled) throw new Error('Unavailable provider');
  if (provider.requiresApiKey && !resolveTTSApiKey(providerId, config.apiKey)) {
    throw new Error('Unavailable provider');
  }
  if (!resolveTTSModel(providerId, config.modelId, config.voice)) {
    throw new Error('Unavailable provider');
  }
}

/** Checks configuration without starting a paid operation or accepting secrets. */
export async function validateBackgroundProviders(
  input: GenerationInput,
  context?: BackgroundProviderValidationContext,
): Promise<void> {
  if (process.env.ASSET_S3_BUCKET?.trim())
    throw new GenerationJobError('BACKGROUND_ASSET_BACKEND_UNSUPPORTED', 422);
  try {
    const mediaSnapshot = input.mediaConfigRef
      ? context
        ? await new MediaConfigSnapshotStore(context.queryable).load(
            context.ownerId,
            input.mediaConfigRef,
          )
        : (() => {
            throw new Error('Media snapshot context unavailable');
          })()
      : undefined;
    const modelSnapshot = input.modelConfigRef
      ? context
        ? await new GenerationModelSnapshotStore(context.queryable).load(
            context.ownerId,
            input.modelConfigRef,
          )
        : (() => {
            throw new Error('Model snapshot context unavailable');
          })()
      : undefined;
    if (
      modelSnapshot &&
      input.model?.modelString &&
      input.model.modelString !== modelSnapshot.modelString
    ) {
      throw new Error('Model snapshot does not match the selected model');
    }
    const providers = getServerProviders();
    for (const stage of [
      'scene-outlines-stream',
      'agent-profiles',
      'scene-content',
      'scene-content:slide',
      'scene-content:quiz',
      'scene-content:interactive',
      'scene-content:pbl',
      'scene-actions',
    ] as const) {
      const { version: _version, ...modelContext } = modelSnapshot ?? { version: 1 as const };
      const resolved = await resolveModel({ ...input.model, ...modelContext, stage });
      const managed = providers[resolved.providerId];
      // Only the authenticated owner snapshot authorizes an unmanaged model.
      // Explicit operator routes still require server configuration, even when
      // a route happens to select the same model as the client snapshot.
      const ownerConfigured =
        modelSnapshot &&
        !getStageRoute(stage) &&
        resolved.modelString === modelSnapshot.modelString;
      if (
        (!managed && !ownerConfigured) ||
        (managed?.models?.length && !managed.models.includes(resolved.modelId)) ||
        (isProviderKeyRequired(resolved.providerId) && !resolved.apiKey)
      )
        throw new Error('Unavailable provider');
    }
    const requireProvider = (
      id: string | undefined,
      available: Record<string, { disabled?: boolean }>,
    ) => {
      if (!id || !available[id] || available[id].disabled) throw new Error('Unavailable provider');
    };
    if (input.tts?.enabled && input.tts.providerId !== 'browser-native-tts') {
      requireTTSProvider(input.tts.providerId, input.tts.modelId, input.tts.voice, mediaSnapshot);
      for (const voice of Object.values(input.tts.agentVoiceOverrides ?? {})) {
        if (voice.providerId !== 'browser-native-tts') {
          requireTTSProvider(voice.providerId, voice.modelId, voice.voiceId, mediaSnapshot);
        }
      }
    }
    if (input.enableImageGeneration) requireImageProvider(input, mediaSnapshot);
    if (input.enableVideoGeneration) requireVideoProvider(input, mediaSnapshot);
    if (input.enableWebSearch || input.requirements.webSearch) {
      if (input.searchConfigRef) {
        if (!context) throw new Error('Search snapshot context unavailable');
        const searchSnapshot = await new GenerationSearchSnapshotStore(context.queryable).load(
          context.ownerId,
          input.searchConfigRef,
        );
        resolveGenerationSearchConfig(input, searchSnapshot);
      } else {
        requireProvider(input.webSearch?.providerId, getServerWebSearchProviders());
      }
    }
  } catch {
    throw new GenerationJobError('BACKGROUND_PROVIDER_UNAVAILABLE', 422);
  }
}
