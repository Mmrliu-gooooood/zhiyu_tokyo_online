import { hostedAuthGate } from '@/lib/auth/api';
import { NextRequest } from 'next/server';
import { transcribeAudio } from '@/lib/audio/asr-providers';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveASRApiKey,
  resolveASRBaseUrl,
  resolveASRModel,
  resolveServerASRProviderId,
} from '@/lib/server/provider-config';
import type { ASRProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  CUSTOM_TRANSCRIPTION_PROTOCOL,
  MediaProviderConfigError,
  parseCustomASRProviderConfig,
} from '@/lib/server/media-provider-config';
import { withMediaProviderFetch } from '@/lib/server/media-provider-fetch';
import { assertGenerationOrigin } from '@/lib/server/generation-jobs/auth';
const log = createLogger('Transcription');

export const maxDuration = 60;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_AUDIO_BYTES + 256 * 1024;

export async function POST(req: NextRequest) {
  const denied = await hostedAuthGate(req);
  if (denied) return denied;
  let resolvedProviderId: string | undefined;
  let resolvedModelId: string | undefined;
  try {
    if (process.env.NODE_ENV === 'production') assertGenerationOrigin(req);
    const declaredLength = Number(req.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
      return apiError('INVALID_REQUEST', 413, 'Audio upload is too large');
    }
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;
    const providerId = formData.get('providerId') as ASRProviderId | null;
    // Trim the client model id and normalize empty → undefined, matching the
    // image/video generation routes (a pinned server model must never be
    // shadowed by a whitespace-padded client id).
    const modelId = (formData.get('modelId') as string | null)?.trim() || undefined;
    const language = formData.get('language') as string | null;
    const apiKey = formData.get('apiKey') as string | null;
    const baseUrl = formData.get('baseUrl') as string | null;
    const protocol = formData.get('protocol') as string | null;
    const requiresApiKeyValue = formData.get('requiresApiKey') as string | null;

    if (!audioFile) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Audio file is required');
    }
    if (!(audioFile instanceof File) || audioFile.size > MAX_AUDIO_BYTES) {
      return apiError('INVALID_REQUEST', 413, 'Audio upload is too large');
    }

    // Prefer an enabled operator-configured backend when the client omitted its
    // selection. Never guess a vendor: fail loudly when no backend is enabled.
    const effectiveProviderId =
      providerId || (resolveServerASRProviderId() as ASRProviderId | undefined);
    if (!effectiveProviderId) {
      return apiError('MISSING_PROVIDER', 400, 'No enabled ASR provider is configured');
    }
    resolvedProviderId = effectiveProviderId;
    resolvedModelId = modelId;

    // Enforce server precedence: a force-disabled provider is off for everyone,
    // regardless of any client key/selection — mirror the TTS contract (#665).
    if (isServerProviderDisabled('asr', effectiveProviderId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This ASR provider is disabled by the server');
    }

    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('asr', effectiveProviderId);
    const clientBaseUrl = managed ? undefined : baseUrl || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const config = String(effectiveProviderId).startsWith('custom-asr-')
      ? parseCustomASRProviderConfig(effectiveProviderId, {
          id: effectiveProviderId,
          protocol: protocol || CUSTOM_TRANSCRIPTION_PROTOCOL,
          apiKey: managed ? '' : apiKey || '',
          baseUrl: clientBaseUrl || '',
          enabled: true,
          // Multipart callers created before protocol persistence have no
          // requiresApiKey field, so an omitted key remains a keyless gateway.
          requiresApiKey:
            requiresApiKeyValue === null ? Boolean(apiKey?.trim()) : requiresApiKeyValue === 'true',
          modelId: modelId || '',
          language: language || undefined,
        })
      : {
          providerId: effectiveProviderId,
          // A managed provider may pin its model list server-side
          // (ASR_<PREFIX>_MODELS): an allowlisted client choice wins, otherwise the
          // first pinned entry is the managed default; unmanaged providers use the
          // client model directly.
          modelId: resolveASRModel(effectiveProviderId, modelId),
          language: language || 'auto',
          apiKey: resolveASRApiKey(effectiveProviderId, managed ? undefined : apiKey || undefined),
          baseUrl: resolveASRBaseUrl(effectiveProviderId, clientBaseUrl),
        };
    // Reflect the resolved (possibly server-pinned) model in failure logs.
    resolvedModelId = config.modelId;

    // Transcribe using the provider system
    const result = String(effectiveProviderId).startsWith('custom-asr-')
      ? await withMediaProviderFetch(config.baseUrl!, (fetcher) =>
          transcribeAudio({ ...config, fetcher }, audioFile),
        )
      : await transcribeAudio(config, audioFile);

    return apiSuccess({ text: result.text });
  } catch (error) {
    log.error(
      `Transcription failed [provider=${resolvedProviderId ?? 'unknown'}, model=${resolvedModelId ?? 'default'}]:`,
      error,
    );
    if (error instanceof MediaProviderConfigError) {
      return apiError(error.code, error.status, error.message);
    }
    return apiError(
      'TRANSCRIPTION_FAILED',
      500,
      'Transcription failed',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
