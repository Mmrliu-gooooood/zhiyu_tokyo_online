import {
  getServerProviders,
  getServerTTSProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
} from '@/lib/server/provider-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { GenerationJobError, type GenerationInput } from './contracts';

/** Checks configuration without starting a paid operation or accepting secrets. */
export async function validateBackgroundProviders(input: GenerationInput): Promise<void> {
  if (process.env.ASSET_S3_BUCKET?.trim())
    throw new GenerationJobError('BACKGROUND_ASSET_BACKEND_UNSUPPORTED', 422);
  try {
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
      const resolved = await resolveModel({ ...input.model, stage });
      const managed = providers[resolved.providerId];
      if (
        !managed ||
        (managed.models?.length && !managed.models.includes(resolved.modelId)) ||
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
      requireProvider(input.tts.providerId, getServerTTSProviders());
      for (const voice of Object.values(input.tts.agentVoiceOverrides ?? {}))
        requireProvider(voice.providerId, getServerTTSProviders());
    }
    if (input.enableImageGeneration)
      requireProvider(input.media?.image?.providerId, getServerImageProviders());
    if (input.enableVideoGeneration)
      requireProvider(input.media?.video?.providerId, getServerVideoProviders());
    if (input.enableWebSearch || input.requirements.webSearch)
      requireProvider(input.webSearch?.providerId, getServerWebSearchProviders());
  } catch {
    throw new GenerationJobError('BACKGROUND_PROVIDER_UNAVAILABLE', 422);
  }
}
