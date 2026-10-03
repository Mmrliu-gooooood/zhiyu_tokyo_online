import {
  getServerProviders,
  getServerTTSProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
  isServerProviderDisabled,
} from '@/lib/server/provider-config';
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  getBindingResolutionError,
  isGatewayError,
  parseModelString,
  resolveBinding,
  selectionModelString,
  storedSelectionRequest,
} from '@/lib/model-gateway';
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
import { resolveProviderSelection } from '@/lib/server/resolve-provider-selection';

/** Bindings name models `provider:model`; legacy snapshots may hold a bare OpenAI id. */
function sameModelString(bound: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const { providerId, modelId } = parseModelString(stored);
  return bound === `${providerId}:${modelId}`;
}

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
  const intent = input.media?.image;
  if (!intent) throw new Error('Unavailable provider');
  if ('source' in intent && intent.source === 'platform') {
    const resolved = resolveProviderSelection({
      capability: 'image',
      source: intent.source,
      defaultId: intent.defaultId,
    });
    const config = snapshot?.image;
    if (
      snapshot?.imageEnabled === false ||
      !config ||
      !('source' in config) ||
      config.source !== 'platform' ||
      config.defaultId !== intent.defaultId ||
      (intent.revision && intent.revision !== resolved.revision) ||
      ('revision' in config && config.revision !== resolved.revision)
    ) {
      throw new Error('Unavailable provider');
    }
    return;
  }
  if (!('providerId' in intent)) throw new Error('Unavailable provider');
  const selected = intent;
  assertNotDisabled('image', selected.providerId);
  if (snapshot?.imageEnabled === false) throw new Error('Unavailable provider');
  const config = snapshot?.image;
  if (
    snapshot?.imageEnabled === true &&
    (!config ||
      !('providerId' in config) ||
      config.providerId !== selected.providerId ||
      config.modelId !== selected.modelId)
  ) {
    throw new Error('Unavailable provider');
  }
  const userOwned = 'source' in selected && selected.source === 'user';
  const managed = getServerImageProviders()[selected.providerId];
  if (managed && !userOwned) {
    if (
      managed.disabled ||
      (managed.models?.length && !managed.models.includes(selected.modelId))
    ) {
      throw new Error('Unavailable provider');
    }
    return;
  }
  if (
    !config ||
    !('providerId' in config) ||
    config.providerId !== selected.providerId ||
    config.modelId !== selected.modelId
  ) {
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
  const apiKey = userOwned ? config.apiKey : resolveImageApiKey(selected.providerId, config.apiKey);
  if (provider.requiresApiKey && !apiKey) {
    throw new Error('Unavailable provider');
  }
  if (
    provider.models.length &&
    !(userOwned ? selected.modelId : resolveImageModel(selected.providerId, selected.modelId))
  ) {
    throw new Error('Unavailable provider');
  }
}

function requireVideoProvider(
  input: GenerationInput,
  snapshot: MediaConfigSnapshotContent | undefined,
): void {
  const intent = input.media?.video;
  if (!intent) throw new Error('Unavailable provider');
  if ('source' in intent && intent.source === 'platform') {
    const resolved = resolveProviderSelection({
      capability: 'video',
      source: intent.source,
      defaultId: intent.defaultId,
    });
    const config = snapshot?.video;
    if (
      snapshot?.videoEnabled === false ||
      !config ||
      !('source' in config) ||
      config.source !== 'platform' ||
      config.defaultId !== intent.defaultId ||
      (intent.revision && intent.revision !== resolved.revision) ||
      ('revision' in config && config.revision !== resolved.revision)
    ) {
      throw new Error('Unavailable provider');
    }
    return;
  }
  if (!('providerId' in intent)) throw new Error('Unavailable provider');
  const selected = intent;
  assertNotDisabled('video', selected.providerId);
  if (snapshot?.videoEnabled === false) throw new Error('Unavailable provider');
  const config = snapshot?.video;
  if (
    snapshot?.videoEnabled === true &&
    (!config ||
      !('providerId' in config) ||
      config.providerId !== selected.providerId ||
      config.modelId !== selected.modelId)
  ) {
    throw new Error('Unavailable provider');
  }
  const userOwned = 'source' in selected && selected.source === 'user';
  const managed = getServerVideoProviders()[selected.providerId];
  if (managed && !userOwned) {
    if (managed.disabled) throw new Error('Unavailable provider');
    return;
  }
  if (
    !config ||
    !('providerId' in config) ||
    config.providerId !== selected.providerId ||
    config.modelId !== selected.modelId
  ) {
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
  const apiKey = userOwned ? config.apiKey : resolveVideoApiKey(selected.providerId, config.apiKey);
  if (provider.requiresApiKey && !apiKey) {
    throw new Error('Unavailable provider');
  }
  if (
    provider.models.length &&
    !(userOwned ? selected.modelId : resolveVideoModel(selected.providerId, selected.modelId))
  ) {
    throw new Error('Unavailable provider');
  }
}

function requireTTSProvider(
  selection: {
    source?: 'platform' | 'user' | 'legacy-managed';
    defaultId?: string;
    revision?: string;
    providerId?: string;
    modelId?: string;
  },
  voice: string | undefined,
  snapshot: MediaConfigSnapshotContent | undefined,
): void {
  if (selection.source === 'platform') {
    if (!selection.defaultId || snapshot?.version !== 3 || snapshot.ttsEnabled === false) {
      throw new Error('Unavailable provider');
    }
    const resolved = resolveProviderSelection({
      capability: 'tts',
      source: selection.source,
      defaultId: selection.defaultId,
      voiceId: voice,
    });
    const provider = snapshot.ttsProviders?.find(
      (candidate) => candidate.source === 'platform' && candidate.defaultId === selection.defaultId,
    );
    const directory = snapshot.ttsVoiceDirectory?.find(
      (candidate) => candidate.source === 'platform' && candidate.defaultId === selection.defaultId,
    );
    if (
      !provider ||
      !directory ||
      (voice && !directory.voiceIds.includes(voice)) ||
      (selection.revision && selection.revision !== resolved.revision) ||
      (provider.source === 'platform' ? provider.revision : undefined) !== resolved.revision ||
      (directory.source === 'platform' ? directory.revision : undefined) !== resolved.revision
    ) {
      throw new Error('Unavailable provider');
    }
    return;
  }
  const { providerId, modelId } = selection;
  if (!providerId) throw new Error('Unavailable provider');
  assertNotDisabled('tts', providerId);
  if (snapshot?.ttsEnabled === false) throw new Error('Unavailable provider');
  const config = snapshot
    ? snapshot.version === 2 || snapshot.version === 3
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
  const userOwned = selection.source === 'user';
  const managed = getServerTTSProviders()[providerId];
  if (managed && !userOwned) {
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
  const apiKey = userOwned ? config.apiKey : resolveTTSApiKey(providerId, config.apiKey);
  if (provider.requiresApiKey && !apiKey) {
    throw new Error('Unavailable provider');
  }
  if (!(userOwned ? config.modelId : resolveTTSModel(providerId, config.modelId, config.voice))) {
    throw new Error('Unavailable provider');
  }
}

/** Checks configuration without starting a paid operation or accepting secrets. */
export async function validateBackgroundProviders(
  input: GenerationInput,
  context?: BackgroundProviderValidationContext,
): Promise<void> {
  let capability: 'MEDIA' | 'MODEL' | 'TTS' | 'IMAGE' | 'VIDEO' | 'SEARCH' = 'MEDIA';
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
    capability = 'MODEL';
    const stored = input.modelConfigRef
      ? context
        ? (
            await new GenerationModelSnapshotStore(context.queryable).load(
              context.ownerId,
              input.modelConfigRef,
            )
          ).selection
        : (() => {
            throw new Error('Model snapshot context unavailable');
          })()
      : undefined;
    if (stored && input.model) {
      const inputSource = input.model.source ?? 'legacy-managed';
      const samePlatform =
        inputSource === 'platform' &&
        stored.source === 'platform' &&
        input.model.defaultId === stored.defaultId &&
        input.model.revision === stored.revision;
      const sameConcrete =
        inputSource !== 'platform' &&
        stored.source === inputSource &&
        (!input.model.modelString ||
          sameModelString(selectionModelString(stored), input.model.modelString));
      if (!samePlatform && !sameConcrete) {
        throw new Error('Model snapshot does not match the selected model');
      }
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
      const resolved = await resolveBinding({
        request: storedSelectionRequest(stored, input.model),
        stage,
        ownerId: context?.ownerId,
      });
      const managed = providers[resolved.providerId];
      // Only the authenticated owner snapshot authorizes an unmanaged model.
      // Explicit operator routes still require server configuration, even when
      // a route happens to select the same model as the client snapshot.
      const ownerConfigured =
        stored &&
        !getStageRoute(stage) &&
        (resolved.source === 'platform'
          ? stored.source === 'platform' &&
            resolved.defaultId === stored.defaultId &&
            resolved.revision === stored.revision
          : stored.source !== 'platform' &&
            resolved.source === stored.source &&
            sameModelString(resolved.modelString, selectionModelString(stored)));
      if (
        (!managed && !ownerConfigured && resolved.source !== 'platform') ||
        (resolved.source !== 'platform' &&
          managed?.models?.length &&
          !managed.models.includes(resolved.modelId)) ||
        !resolved.credentialReady
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
      capability = 'TTS';
      requireTTSProvider(input.tts, input.tts.voice, mediaSnapshot);
      for (const voice of Object.values(input.tts.agentVoiceOverrides ?? {})) {
        if (voice.providerId !== 'browser-native-tts') {
          requireTTSProvider(voice, voice.voiceId, mediaSnapshot);
        }
      }
    }
    if (input.enableImageGeneration) {
      capability = 'IMAGE';
      requireImageProvider(input, mediaSnapshot);
    }
    if (input.enableVideoGeneration) {
      capability = 'VIDEO';
      requireVideoProvider(input, mediaSnapshot);
    }
    if (input.enableWebSearch || input.requirements.webSearch) {
      capability = 'SEARCH';
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
  } catch (error) {
    // Client selection errors keep their status; unusable models are a 422 below.
    const resolutionError = isGatewayError(error) ? undefined : getBindingResolutionError(error);
    if (resolutionError) {
      throw new GenerationJobError(resolutionError.code, resolutionError.httpStatus);
    }
    const code = `BACKGROUND_${capability}_PROVIDER_UNAVAILABLE`;
    // Fixed capability codes are safe to log; upstream errors and snapshots may
    // contain credentials. Retain the precise public category without echoing them.
    console.warn('[generation-preflight] rejected', { code });
    throw new GenerationJobError(code, 422);
  }
}
