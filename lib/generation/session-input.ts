import type { GenerationSessionState } from '@/app/generation-preview/types';
import type { GenerationInput } from '@/lib/server/generation-jobs/contracts';
import type { ModelConfigInput } from '@/types/pro-model';
import type { ModelSelection } from '@/lib/types/platform-default-models';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { loadDocumentBlob } from '@/lib/utils/image-storage';
import { resolveSessionDocumentSources } from '@/lib/document/session-sources';
import { resolveStoredBytes } from '@/lib/media/resolve-stored-bytes';
import { GenerationJobRequestError, generationJobRequest } from './job-client';
import { syncCurrentMediaConfigSnapshot } from '@/lib/workbench/media-config-snapshot-client';
import { prepareGenerationModelSnapshot } from './model-snapshot-client';
import { syncGenerationSearchSnapshot } from './search-snapshot-client';
import { CLASSMATE_LIMITS } from '@/lib/study/classmates/contracts';
import { countClassmates, rosterAgentId } from '@/lib/study/classmates/roster';

export interface GenerationUploadedAsset {
  assetId: string;
  revision: number;
  digest: string;
}

function platformRevision(
  settings: ReturnType<typeof useSettingsStore.getState>,
  defaultId: string,
) {
  return settings.platformDefaults?.entries.find((entry) => entry.defaultId === defaultId)
    ?.revision;
}

function rejectClientProvider(config?: {
  apiKey?: string;
  baseUrl?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
}) {
  if (
    config?.apiKey?.trim() ||
    config?.baseUrl?.trim() ||
    config?.accessKeyId?.trim() ||
    config?.accessKeySecret?.trim()
  ) {
    throw new GenerationJobRequestError(422, 'BACKGROUND_CLIENT_PROVIDER_UNSUPPORTED');
  }
}

/** Freeze configuration while credentials travel only through an owner-scoped encrypted snapshot. */
export async function buildGenerationJobInput(
  session: GenerationSessionState,
  locale: string,
  signal: AbortSignal,
  onAsset: (key: string, asset: GenerationUploadedAsset) => void,
): Promise<GenerationInput> {
  let model: ModelConfigInput = getCurrentModelConfig();
  if (resolveSessionDocumentSources(session).length)
    rejectClientProvider(session.pdfProviderConfig);
  if (session.sceneOutlines?.length || session.researchContext) {
    throw new GenerationJobRequestError(422, 'BACKGROUND_LEGACY_SESSION_UNSUPPORTED');
  }
  // Establish the signed owner before uploading any source bytes.
  await generationJobRequest('', { signal });
  // A signed-in account travels as its credential id; the snapshot carries it to the worker.
  const preparedModel =
    model.source === 'platform' ||
    model.apiKey?.trim() ||
    model.baseUrl?.trim() ||
    model.credentialId
      ? await prepareGenerationModelSnapshot(model, signal)
      : undefined;
  if (preparedModel) model = preparedModel.context;
  const modelConfigRef = preparedModel?.ref;
  // A rejected platform snapshot may have refreshed the entire catalog. Freeze
  // media settings only now, so their revisions match the refreshed snapshots.
  const settings = useSettingsStore.getState();
  const imageSelection = settings.imageSelection ?? {
    source: 'user' as const,
    providerId: settings.imageProviderId,
    modelId: settings.imageModelId,
  };
  const videoSelection = settings.videoSelection ?? {
    source: 'user' as const,
    providerId: settings.videoProviderId,
    modelId: settings.videoModelId,
  };
  const ttsSelection = settings.ttsSelection ?? {
    source: 'user' as const,
    providerId: settings.ttsProviderId,
    modelId: settings.ttsProvidersConfig[settings.ttsProviderId]?.modelId,
  };
  const searchConfig = settings.webSearchProvidersConfig[settings.webSearchProviderId];
  const searchModelId = searchConfig?.modelId?.trim() || undefined;
  const searchConfigRef = session.requirements.webSearch
    ? await syncGenerationSearchSnapshot(
        {
          version: 1,
          providerId: settings.webSearchProviderId,
          apiKey: searchConfig?.apiKey,
          baseUrl: searchConfig?.baseUrl,
          modelId: searchModelId,
          baiduSubSources:
            settings.webSearchProviderId === 'baidu' ? settings.baiduSubSources : undefined,
        },
        signal,
      )
    : undefined;
  const selected =
    settings.agentMode === 'auto'
      ? []
      : settings.selectedAgentIds
          .map((id) => useAgentRegistry.getState().getAgent(id))
          .filter((agent) => agent && !agent.isGenerated);
  if (
    countClassmates(selected.filter((agent) => !!agent)) > CLASSMATE_LIMITS.classmatesPerClassroom
  )
    throw new GenerationJobRequestError(422, 'BACKGROUND_AGENT_ROLE_UNSUPPORTED');
  const items = selected.map((agent) => {
    if (!agent || !['teacher', 'assistant', 'student'].includes(agent.role))
      throw new GenerationJobRequestError(422, 'BACKGROUND_AGENT_ROLE_UNSUPPORTED');
    const savedVoice = settings.agentVoiceOverrides[agent.id] ?? agent.voiceConfig;
    const voiceDefault =
      savedVoice?.source === 'platform'
        ? settings.platformDefaults?.entries.find(
            (entry) =>
              entry.capability === 'tts' &&
              entry.available &&
              entry.defaultId === savedVoice.defaultId,
          )
        : undefined;
    const voiceConfig = voiceDefault
      ? { ...savedVoice!, revision: voiceDefault.revision }
      : savedVoice;
    return {
      // A classmate (B04) enters as the snapshot of its current revision.
      id: rosterAgentId(agent),
      name: agent.name,
      role: agent.role as 'teacher' | 'assistant' | 'student',
      persona: agent.persona,
      avatar: agent.avatar,
      color: agent.color,
      priority: agent.priority,
      voiceConfig,
    };
  });
  const mediaConfigRef = await syncCurrentMediaConfigSnapshot(
    items.flatMap((agent) => {
      const voice = agent.voiceConfig;
      if (!voice) return [];
      // Role voice bindings store their source at the top level; the media
      // snapshot builder expects an explicit selection envelope. Preserve it
      // so the global narrator cannot reinterpret a role's chosen provider.
      let selection: ModelSelection | undefined;
      if (voice.source === 'platform') {
        if (voice.defaultId !== 'zhiyu-default-tts') {
          throw new GenerationJobRequestError(422, 'BACKGROUND_TTS_PROVIDER_UNAVAILABLE');
        }
        selection = { source: voice.source, defaultId: voice.defaultId };
      } else if (voice.source) {
        selection = { source: voice.source, providerId: voice.providerId, modelId: voice.modelId };
      }
      return [{ ...voice, selection }];
    }),
  );
  // Stored overrides may belong to old or unselected rosters. Only voices used
  // by this job are included in its media snapshot and may be required by preflight.
  const agentVoiceOverrides = Object.fromEntries(
    items.flatMap((agent, index) => {
      const sourceId = selected[index]!.id;
      const voice = settings.agentVoiceOverrides[sourceId] ? agent.voiceConfig : undefined;
      return voice ? [[agent.id, voice]] : [];
    }),
  );
  const uploaded = { ...session.backgroundAssets };
  const upload = async (
    key: string,
    blob: Blob | null,
    name: string,
  ): Promise<GenerationUploadedAsset> => {
    if (uploaded[key]) return uploaded[key];
    if (!blob?.size) throw new GenerationJobRequestError(422, 'BACKGROUND_MATERIAL_UNAVAILABLE');
    const response = await fetch('/api/generate-classroom/assets', {
      method: 'POST',
      credentials: 'same-origin',
      signal,
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'X-Asset-Name': encodeURIComponent(name),
        'Idempotency-Key': `generation:${session.sessionId}:${key}`,
      },
      body: blob,
    });
    const result = await response.json();
    if (!response.ok)
      throw new GenerationJobRequestError(
        response.status,
        result.error ?? 'BACKGROUND_ASSET_UPLOAD_FAILED',
      );
    const asset: GenerationUploadedAsset = {
      assetId: result.assetId,
      digest: result.digest,
      revision: result.revision,
    };
    uploaded[key] = asset;
    onAsset(key, asset);
    return asset;
  };
  const loadAsset = (assetId: string) =>
    resolveStoredBytes(assetId, { fetchPolicy: { requireOk: true, requireNonEmpty: true } });
  const sources: NonNullable<NonNullable<GenerationInput['materials']>['sources']> = [];
  for (const source of resolveSessionDocumentSources(session).sort((a, b) => a.order - b.order)) {
    const key = `source:${source.id}`;
    const blob = uploaded[key]
      ? null
      : ((source.assetId ? await loadAsset(source.assetId) : null) ??
        (await loadDocumentBlob(source.storageKey)));
    const asset = await upload(key, blob, source.name);
    sources.push({
      ...asset,
      name: source.name,
      providerId: source.providerId || session.pdfProviderId,
    });
  }
  const images: NonNullable<NonNullable<GenerationInput['materials']>['images']> = [];
  let quotaReached = false;
  for (const image of session.pdfImages ?? []) {
    // Images enrich the course: once the account's asset quota is full, the
    // rest are left out and the job runs on the text and sources alone.
    if (quotaReached && !uploaded[`image:${image.id}`]) continue;
    const key = `image:${image.id}`;
    let blob: Blob | null = null;
    if (!uploaded[key]) {
      blob = image.assetId
        ? await loadAsset(image.assetId)
        : image.storageId
          ? await loadDocumentBlob(image.storageId)
          : null;
      if (!blob && image.src?.startsWith('data:'))
        blob = await (await fetch(image.src, { signal })).blob();
    }
    let asset: GenerationUploadedAsset;
    try {
      asset = await upload(key, blob, `${image.id}.png`);
    } catch (error) {
      if (error instanceof GenerationJobRequestError && error.code === 'ASSET_QUOTA_EXCEEDED') {
        quotaReached = true;
        continue;
      }
      throw error;
    }
    images.push({
      id: image.id,
      assetId: asset.assetId,
      pageNumber: image.pageNumber,
      description: image.description,
      width: image.width,
      height: image.height,
      originalId: image.originalId,
      sourceDocumentId: image.sourceDocumentId,
      sourceDocumentName: image.sourceDocumentName,
      sourceDocumentOrder: image.sourceDocumentOrder,
      visionPriority: image.visionPriority,
    });
  }
  return {
    version: 1,
    requirements: session.requirements,
    locale,
    model:
      model.source === 'platform'
        ? {
            source: model.source,
            defaultId: model.defaultId,
            revision: model.revision,
          }
        : {
            source: model.source,
            modelString: model.modelString,
            thinkingConfig: model.thinkingConfig,
          },
    ...(modelConfigRef ? { modelConfigRef } : {}),
    ...(searchConfigRef ? { searchConfigRef } : {}),
    materials: { text: session.pdfText || undefined, sources, images },
    agents: settings.agentMode === 'auto' ? { mode: 'generate' } : { mode: 'custom', items },
    review: { mode: settings.reviewOutlineEnabled ? 'manual' : 'auto', autoConfirmSeconds: 2.5 },
    enableWebSearch: session.requirements.webSearch === true,
    enableImageGeneration: settings.imageGenerationEnabled,
    enableVideoGeneration: settings.videoGenerationEnabled,
    media: {
      image: settings.imageGenerationEnabled
        ? imageSelection.source === 'platform'
          ? {
              source: imageSelection.source,
              defaultId: imageSelection.defaultId,
              revision: platformRevision(settings, imageSelection.defaultId),
            }
          : {
              source: imageSelection.source,
              providerId: settings.imageProviderId,
              modelId: settings.imageModelId,
            }
        : undefined,
      video: settings.videoGenerationEnabled
        ? videoSelection.source === 'platform'
          ? {
              source: videoSelection.source,
              defaultId: videoSelection.defaultId,
              revision: platformRevision(settings, videoSelection.defaultId),
            }
          : {
              source: videoSelection.source,
              providerId: settings.videoProviderId,
              modelId: settings.videoModelId,
            }
        : undefined,
    },
    ...(mediaConfigRef ? { mediaConfigRef } : {}),
    webSearch: session.requirements.webSearch
      ? {
          providerId: settings.webSearchProviderId,
          modelId: searchModelId,
        }
      : undefined,
    tts: settings.ttsEnabled
      ? {
          enabled: settings.ttsEnabled,
          source: ttsSelection.source,
          ...(ttsSelection.source === 'platform'
            ? {
                defaultId: ttsSelection.defaultId,
                revision: platformRevision(settings, ttsSelection.defaultId),
              }
            : {
                providerId: settings.ttsProviderId,
                modelId: settings.ttsProvidersConfig[settings.ttsProviderId]?.modelId,
              }),
          voice: settings.ttsVoice,
          speed: settings.ttsSpeed,
          agentVoiceOverrides,
        }
      : { enabled: false },
  };
}
