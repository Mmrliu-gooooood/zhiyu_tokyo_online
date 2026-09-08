import type { GenerationSessionState } from '@/app/generation-preview/types';
import type { GenerationInput } from '@/lib/server/generation-jobs/contracts';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { loadDocumentBlob } from '@/lib/utils/image-storage';
import { resolveSessionDocumentSources } from '@/lib/document/session-sources';
import { resolveStoredBytes } from '@/lib/media/resolve-stored-bytes';
import { GenerationJobRequestError, generationJobRequest } from './job-client';
import { syncCurrentMediaConfigSnapshot } from '@/lib/workbench/media-config-snapshot-client';
import { syncGenerationModelSnapshot } from './model-snapshot-client';

export interface GenerationUploadedAsset {
  assetId: string;
  revision: number;
  digest: string;
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
  const settings = useSettingsStore.getState();
  const model = getCurrentModelConfig();
  rejectClientProvider(session.pdfProviderConfig);
  if (session.sceneOutlines?.length || session.researchContext) {
    throw new GenerationJobRequestError(422, 'BACKGROUND_LEGACY_SESSION_UNSUPPORTED');
  }
  if (session.requirements.webSearch)
    rejectClientProvider(settings.webSearchProvidersConfig[settings.webSearchProviderId]);

  // Establish the signed owner before uploading any source bytes.
  await generationJobRequest('', { signal });
  const modelConfigRef =
    model.apiKey?.trim() || model.baseUrl?.trim()
      ? await syncGenerationModelSnapshot(model, signal)
      : undefined;
  const selected = settings.selectedAgentIds
    .map((id) => useAgentRegistry.getState().getAgent(id))
    .filter((agent) => agent && !agent.isGenerated);
  const items = selected.map((agent) => {
    if (!agent || !['teacher', 'assistant', 'student'].includes(agent.role))
      throw new GenerationJobRequestError(422, 'BACKGROUND_AGENT_ROLE_UNSUPPORTED');
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role as 'teacher' | 'assistant' | 'student',
      persona: agent.persona,
      avatar: agent.avatar,
      color: agent.color,
      priority: agent.priority,
      voiceConfig: settings.agentVoiceOverrides[agent.id] ?? agent.voiceConfig,
    };
  });
  const mediaConfigRef = await syncCurrentMediaConfigSnapshot(
    items.flatMap((agent) => (agent.voiceConfig ? [agent.voiceConfig] : [])),
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
  for (const image of session.pdfImages ?? []) {
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
    const asset = await upload(key, blob, `${image.id}.png`);
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
    model: { modelString: model.modelString, thinkingConfig: model.thinkingConfig },
    ...(modelConfigRef ? { modelConfigRef } : {}),
    materials: { text: session.pdfText || undefined, sources, images },
    agents:
      settings.agentMode === 'auto'
        ? { mode: 'generate', count: settings.autoAgentCount }
        : { mode: 'custom', items },
    review: { mode: settings.reviewOutlineEnabled ? 'manual' : 'auto', autoConfirmSeconds: 2.5 },
    enableWebSearch: session.requirements.webSearch === true,
    enableImageGeneration: settings.imageGenerationEnabled,
    enableVideoGeneration: settings.videoGenerationEnabled,
    media: {
      image: settings.imageGenerationEnabled
        ? { providerId: settings.imageProviderId, modelId: settings.imageModelId }
        : undefined,
      video: settings.videoGenerationEnabled
        ? { providerId: settings.videoProviderId, modelId: settings.videoModelId }
        : undefined,
    },
    ...(mediaConfigRef ? { mediaConfigRef } : {}),
    webSearch: session.requirements.webSearch
      ? {
          providerId: settings.webSearchProviderId,
          modelId: settings.webSearchProvidersConfig[settings.webSearchProviderId]?.modelId,
        }
      : undefined,
    tts: settings.ttsEnabled
      ? {
          enabled: settings.ttsEnabled,
          providerId: settings.ttsProviderId,
          modelId: settings.ttsProvidersConfig[settings.ttsProviderId]?.modelId,
          voice: settings.ttsVoice,
          speed: settings.ttsSpeed,
          agentVoiceOverrides: settings.agentVoiceOverrides,
        }
      : { enabled: false },
  };
}
