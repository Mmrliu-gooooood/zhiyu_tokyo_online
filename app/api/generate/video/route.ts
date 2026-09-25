import { guardClientGeneration } from '@/lib/server/generation-jobs/route-guard';
import { withHostedProviderQuota } from '@/lib/auth/api';
/**
 * Video Generation API
 *
 * Generates a video from a text prompt using the specified provider.
 * Uses async task pattern (submit → poll) so maxDuration is set to 5 minutes.
 *
 * POST /api/generate/video
 *
 * Headers:
 *   x-video-provider: VideoProviderId (optional, server-configured default)
 *   x-video-model: string (optional model override)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Body: { prompt, duration?, aspectRatio?, resolution? }
 * Response: { success: boolean, result?: VideoGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import {
  isServerProviderDisabled,
  resolveServerVideoProviderId,
} from '@/lib/server/provider-config';
import type { VideoProviderId, VideoGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  MediaProviderConfigError,
  parseCustomVideoProviderConfig,
} from '@/lib/server/media-provider-config';
import { withMediaProviderFetch } from '@/lib/server/media-provider-fetch';
import { runIndependentHeavyTaskRequest } from '@/lib/server/heavy-task-admission/independent-request';
import {
  ProviderSelectionError,
  normalizeProviderSelectionSource,
  resolveProviderSelection,
} from '@/lib/server/resolve-provider-selection';

const log = createLogger('VideoGeneration API');

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  return withHostedProviderQuota(request, () =>
    runIndependentHeavyTaskRequest(request, 'media', (signal) => handlePost(request, signal)),
  );
}

async function handlePost(request: NextRequest, signal: AbortSignal) {
  const generationGuard = await guardClientGeneration(request);
  if (generationGuard) return generationGuard;
  try {
    const requestBody = (await request.json()) as VideoGenerationOptions & {
      providerConfig?: unknown;
    };
    const { providerConfig, ...body } = requestBody;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    // The client may express no provider preference (empty header) — fall back
    // to the first server-configured video provider, else fail loud.
    const modelSource = normalizeProviderSelectionSource(
      request.headers.get('x-model-source')?.trim() || undefined,
    );
    const platformDefaultId = request.headers.get('x-platform-default-id')?.trim() || undefined;
    let providerId = (request.headers.get('x-video-provider')?.trim() ||
      (modelSource === 'platform' ? undefined : resolveServerVideoProviderId())) as VideoProviderId;
    if (!providerId && modelSource !== 'platform') {
      return apiError('MISSING_PROVIDER', 400, 'No video provider configured');
    }
    // Enforce server precedence: a force-disabled provider is off for everyone,
    // regardless of any client key/selection — mirror the TTS contract (#665).
    if (providerId && isServerProviderDisabled('video', providerId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This video provider is disabled by the server');
    }
    if (modelSource !== 'platform' && String(providerId).startsWith('custom-video-')) {
      const runtimeConfig = parseCustomVideoProviderConfig(
        providerId,
        providerConfig,
        request.headers.get('x-video-model')?.trim() || undefined,
      );
      if (process.env.NODE_ENV === 'production') {
        const ssrfError = await validateUrlForSSRF(runtimeConfig.baseUrl || '');
        if (ssrfError) return apiError('INVALID_URL', 403, ssrfError);
      }
      const options = normalizeVideoOptions(providerId, { ...body, signal });
      const generated = await withMediaProviderFetch(runtimeConfig.baseUrl!, (fetcher) =>
        generateVideo({ ...runtimeConfig, fetcher }, options),
      );
      const { bytes, ...plainResult } = generated as typeof generated & {
        bytes?: Uint8Array;
        mimeType?: string;
      };
      // Authenticated content URLs are consumed server-side by the adapter.
      // The browser receives bytes, never the protected upstream URL or key.
      const result = bytes
        ? {
            ...plainResult,
            base64: Buffer.from(bytes).toString('base64'),
            mimeType: plainResult.mimeType || 'video/mp4',
          }
        : plainResult;
      void recordGenerationUsage({
        kind: 'video',
        unit: 'second',
        providerId,
        modelId: runtimeConfig.model,
        quantity: generated.duration,
      });
      return apiSuccess({ result });
    }
    const selection = resolveProviderSelection({
      capability: 'video',
      source: modelSource,
      defaultId: platformDefaultId,
      providerId,
      modelId: request.headers.get('x-video-model')?.trim() || undefined,
      apiKey: request.headers.get('x-api-key') || undefined,
      baseUrl: request.headers.get('x-base-url') || undefined,
    });
    providerId = selection.providerId as VideoProviderId;
    const clientBaseUrl = selection.managed ? undefined : selection.baseUrl;

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = selection.apiKey;
    if (!apiKey) {
      return apiError(
        'MISSING_API_KEY',
        401,
        `No API key configured for video provider: ${providerId}`,
      );
    }

    const baseUrl = selection.baseUrl;

    // A managed provider may pin its model list server-side
    // (VIDEO_<PREFIX>_MODELS): an allowlisted client choice wins, otherwise the
    // first pinned entry is the managed default; unmanaged providers use the
    // client header directly.
    const model = selection.modelId;
    if (!model) {
      return apiError(
        'MISSING_MODEL',
        400,
        `No model configured for video provider: ${providerId}`,
      );
    }

    if (selection.source === 'platform') {
      if (body.duration !== undefined && body.duration !== 6) {
        return apiError(
          'INVALID_REQUEST',
          400,
          'The ZHIYU default video model supports 6-second requests',
        );
      }
      if (body.resolution !== undefined && body.resolution !== '720p') {
        return apiError(
          'INVALID_REQUEST',
          400,
          'The ZHIYU default video model supports the 768P output tier',
        );
      }
      body.duration = 6;
      // The shared internal label 720p maps to MiniMax 768P in the adapter.
      body.resolution = '720p';
    }

    // Normalize options against provider capabilities
    const options = normalizeVideoOptions(providerId, { ...body, signal });

    log.info(
      `Generating video: provider=${providerId}, model=${model || 'default'}, ` +
        `prompt="${body.prompt.slice(0, 80)}...", duration=${options.duration ?? 'auto'}, ` +
        `aspect=${options.aspectRatio ?? 'auto'}, resolution=${options.resolution ?? 'auto'}`,
    );

    const result = await generateVideo({ providerId, apiKey, baseUrl, model }, options);

    log.info(
      `Video generated: url=${result.url ? 'yes' : 'no'}, ${result.width}x${result.height}, ${result.duration}s`,
    );

    void recordGenerationUsage({
      kind: 'video',
      unit: 'second',
      providerId,
      modelId: model,
      quantity: result.duration,
    });

    return apiSuccess({ result });
  } catch (error) {
    if (error instanceof ProviderSelectionError) {
      return apiError(error.code, error.httpStatus, error.message);
    }
    if (error instanceof MediaProviderConfigError) {
      return apiError(error.code, error.status, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    // Detect content safety filter rejections (e.g. Seedance SensitiveContent errors)
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      log.warn(`Video blocked by content safety filter: ${message}`);
      return apiError('CONTENT_SENSITIVE', 400, message);
    }
    log.error(`Video generation failed: ${message}`, error);
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
