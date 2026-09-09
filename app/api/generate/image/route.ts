import { guardClientGeneration } from '@/lib/server/generation-jobs/route-guard';
/**
 * Image Generation API
 *
 * Generates an image from a text prompt using the specified provider.
 * Called by the client during media generation after slides are produced.
 *
 * POST /api/generate/image
 *
 * Headers:
 *   x-image-provider: ImageProviderId (optional, server-configured default)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Body: { prompt, negativePrompt?, width?, height?, aspectRatio?, style? }
 * Response: { success: boolean, result?: ImageGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import {
  generateImage,
  aspectRatioToDimensions,
  IMAGE_PROVIDERS,
} from '@/lib/media/image-providers';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  resolveServerImageProviderId,
} from '@/lib/server/provider-config';
import type { ImageProviderId, ImageGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  MediaProviderConfigError,
  parseCustomImageProviderConfig,
} from '@/lib/server/media-provider-config';
import { withMediaProviderFetch } from '@/lib/server/media-provider-fetch';
import { runIndependentHeavyTaskRequest } from '@/lib/server/heavy-task-admission/independent-request';

const log = createLogger('ImageGeneration API');

// The ComfyUI adapter polls up to GENERATION_TIMEOUT_MS (5 min) and real
// workflows can take 3–5 min. 60s would let platforms that enforce maxDuration
// (e.g. Vercel) kill the request ~4 min before the adapter finishes. 300s is
// the practical ceiling on most managed platforms and matches the poll budget.
// (Self-hosted Node servers ignore this value entirely.)
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  return runIndependentHeavyTaskRequest(request, 'media', () => handlePost(request));
}

async function handlePost(request: NextRequest) {
  const generationGuard = await guardClientGeneration(request);
  if (generationGuard) return generationGuard;
  try {
    const requestBody = (await request.json()) as ImageGenerationOptions & {
      providerConfig?: unknown;
    };
    const { providerConfig, ...body } = requestBody;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    // The client may express no provider preference (empty header) — fall back
    // to the first server-configured image provider, else fail loud.
    const providerId = (request.headers.get('x-image-provider')?.trim() ||
      resolveServerImageProviderId()) as ImageProviderId;
    if (!providerId) {
      return apiError('MISSING_PROVIDER', 400, 'No image provider configured');
    }
    // Enforce server precedence: a force-disabled provider is off for everyone,
    // regardless of any client key/selection — mirror the TTS contract (#665).
    if (isServerProviderDisabled('image', providerId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This image provider is disabled by the server');
    }
    if (String(providerId).startsWith('custom-image-')) {
      const runtimeConfig = parseCustomImageProviderConfig(
        providerId,
        providerConfig,
        request.headers.get('x-image-model')?.trim() || undefined,
      );
      if (process.env.NODE_ENV === 'production') {
        const ssrfError = await validateUrlForSSRF(runtimeConfig.baseUrl || '');
        if (ssrfError) return apiError('INVALID_URL', 403, ssrfError);
      }
      if (!body.width && !body.height && body.aspectRatio) {
        const dims = aspectRatioToDimensions(body.aspectRatio);
        body.width = dims.width;
        body.height = dims.height;
      }
      const generated = await withMediaProviderFetch(runtimeConfig.baseUrl!, (fetcher) =>
        generateImage({ ...runtimeConfig, fetcher }, body),
      );
      const { bytes: _bytes, ...result } = generated as typeof generated & {
        bytes?: Uint8Array;
      };
      void recordGenerationUsage({
        kind: 'image',
        unit: 'image',
        providerId,
        modelId: runtimeConfig.model,
        quantity: 1,
      });
      return apiSuccess({ result });
    }
    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('image', providerId);
    const clientApiKey = managed ? undefined : request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : request.headers.get('x-base-url') || undefined;
    const clientModel = request.headers.get('x-image-model')?.trim() || undefined;

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveImageApiKey(providerId, clientApiKey);
    const provider = IMAGE_PROVIDERS[providerId];
    if (provider?.requiresApiKey && !apiKey) {
      return apiError(
        'MISSING_API_KEY',
        401,
        `No API key configured for image provider: ${providerId}`,
      );
    }

    const baseUrl = resolveImageBaseUrl(providerId, clientBaseUrl);

    // A managed provider may pin its model list server-side
    // (IMAGE_<PREFIX>_MODELS): an allowlisted client choice wins, otherwise the
    // first pinned entry is the managed default; unmanaged providers use the
    // client header directly.
    const model = resolveImageModel(providerId, clientModel);
    // Workflow-based providers (e.g. comfyui-image) have no model catalog and
    // need no model; everyone else must resolve one.
    if (!model && provider?.models && provider.models.length > 0) {
      return apiError(
        'MISSING_MODEL',
        400,
        `No model configured for image provider: ${providerId}`,
      );
    }

    // Resolve dimensions from aspect ratio if not explicitly set
    if (!body.width && !body.height && body.aspectRatio) {
      const dims = aspectRatioToDimensions(body.aspectRatio);
      body.width = dims.width;
      body.height = dims.height;
    }

    log.info(
      `Generating image: provider=${providerId}, model=${model || 'default'}, ` +
        `prompt="${body.prompt.slice(0, 80)}...", size=${body.width ?? 'auto'}x${body.height ?? 'auto'}`,
    );

    const result = await generateImage({ providerId, apiKey, baseUrl, model }, body);

    void recordGenerationUsage({
      kind: 'image',
      unit: 'image',
      providerId,
      modelId: model,
      quantity: 1,
    });

    return apiSuccess({ result });
  } catch (error) {
    if (error instanceof MediaProviderConfigError) {
      return apiError(error.code, error.status, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    // Detect content safety filter rejections (e.g. Seedream OutputImageSensitiveContentDetected)
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      log.warn(`Image blocked by content safety filter: ${message}`);
      return apiError('CONTENT_SENSITIVE', 400, message);
    }
    log.error(`Image generation failed: ${message}`, error);
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
