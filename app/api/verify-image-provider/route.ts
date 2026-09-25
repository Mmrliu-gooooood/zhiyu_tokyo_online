/**
 * Verify Image Provider API
 *
 * Lightweight endpoint that validates provider credentials without generating images.
 *
 * POST /api/verify-image-provider
 *
 * Headers:
 *   x-model-source: platform | user | legacy-managed (optional)
 *   x-platform-default-id: string (required for platform source)
 *   x-image-provider: ImageProviderId (optional, server-configured default)
 *   x-image-model: string (optional)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Response: { success: boolean, message: string }
 */

import { hostedAuthGate } from '@/lib/auth/api';
import { NextRequest } from 'next/server';
import { IMAGE_PROVIDERS, testImageConnectivity } from '@/lib/media/image-providers';
import { resolveServerImageProviderId } from '@/lib/server/provider-config';
import type { ImageProviderId } from '@/lib/media/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  MediaProviderConfigError,
  parseCustomImageProviderConfig,
} from '@/lib/server/media-provider-config';
import {
  normalizeProviderSelectionSource,
  ProviderSelectionError,
  resolveProviderSelection,
} from '@/lib/server/resolve-provider-selection';

const log = createLogger('VerifyImageProvider');

// Connectivity probes are lightweight and each underlying request is bounded by
// its own AbortSignal, but the route had no ceiling at all — cap it so a stalled
// upstream can't tie up the function indefinitely.
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const denied = await hostedAuthGate(request);
  if (denied) return denied;
  try {
    const requestBody = (await request
      .clone()
      .json()
      .catch(() => ({}))) as {
      providerConfig?: unknown;
    };
    const source = normalizeProviderSelectionSource(
      request.headers.get('x-model-source')?.trim() || undefined,
    );
    const platformDefaultId = request.headers.get('x-platform-default-id')?.trim() || undefined;
    if (source !== 'platform' && platformDefaultId) {
      throw new ProviderSelectionError(
        'INVALID_MODEL_SOURCE',
        400,
        'A platform default ID can only be used with the platform model source',
      );
    }
    const providerId = (request.headers.get('x-image-provider')?.trim() ||
      (source === 'legacy-managed'
        ? resolveServerImageProviderId()
        : undefined)) as ImageProviderId;
    const clientModel = request.headers.get('x-image-model')?.trim() || undefined;
    if (source !== 'platform' && providerId?.startsWith('custom-image-')) {
      // Keep the server-wide disable policy in front of custom-provider
      // configuration checks, matching the legacy verification behavior.
      resolveProviderSelection({
        capability: 'image',
        source,
        providerId,
        modelId: clientModel,
      });
      const config = parseCustomImageProviderConfig(
        providerId,
        requestBody.providerConfig,
        clientModel,
      );
      const ssrfError = await validateUrlForSSRF(config.baseUrl || '');
      if (ssrfError) return apiError('INVALID_URL', 403, ssrfError);
      return apiSuccess({
        message: 'Configuration is complete; this protocol has no free generation probe.',
        verification: 'configuration' as const,
      });
    }
    const clientApiKey = request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = request.headers.get('x-base-url') || undefined;

    const selection = resolveProviderSelection({
      capability: 'image',
      source,
      defaultId: platformDefaultId,
      providerId,
      modelId: clientModel,
      apiKey: clientApiKey,
      baseUrl: clientBaseUrl,
    });
    const resolvedProviderId = selection.providerId as ImageProviderId;
    if (!selection.managed && selection.baseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(selection.baseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const provider = IMAGE_PROVIDERS[resolvedProviderId];
    if (provider?.requiresApiKey && !selection.apiKey) {
      return apiError('MISSING_API_KEY', 400, 'No API key configured');
    }

    const model = selection.modelId;
    // Workflow-based providers (e.g. comfyui-image) have no model catalog and
    // need no model; everyone else must resolve one.
    if (!model && provider?.models && provider.models.length > 0) {
      return apiError(
        'MISSING_MODEL',
        400,
        `No model configured for image provider: ${resolvedProviderId}`,
      );
    }

    const result = await testImageConnectivity({
      providerId: resolvedProviderId,
      apiKey: selection.apiKey,
      baseUrl: selection.baseUrl,
      model,
    });

    if (!result.success) {
      return apiError('UPSTREAM_ERROR', 500, result.message);
    }

    return apiSuccess({ message: result.message });
  } catch (err) {
    if (err instanceof ProviderSelectionError) {
      return apiError(err.code, err.httpStatus, err.message);
    }
    if (err instanceof MediaProviderConfigError) {
      return apiError(err.code, err.status, err.message);
    }
    log.error(`Image provider verification failed: ${err}`, err);
    return apiError('INTERNAL_ERROR', 500, `Connectivity test error: ${err}`);
  }
}
