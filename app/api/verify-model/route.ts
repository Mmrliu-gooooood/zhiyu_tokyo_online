import { hostedAuthGate, withHostedProviderQuota } from '@/lib/auth/api';
import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getModelResolutionError, resolveModel } from '@/lib/server/resolve-model';
import { callLLM } from '@/lib/ai/llm';
const log = createLogger('Verify Model');

export async function POST(req: NextRequest) {
  return withHostedProviderQuota(req, () => handlePOST(req));
}

async function handlePOST(req: NextRequest) {
  const denied = await hostedAuthGate(req);
  if (denied) return denied;
  let model: string | undefined;
  try {
    const body = await req.json();
    const { apiKey, baseUrl, providerType } = body;
    model = body.model;
    const sourceHeader = req.headers.get('x-model-source')?.trim();
    const platformDefaultId = req.headers.get('x-platform-default-id')?.trim() || undefined;
    if (
      sourceHeader &&
      sourceHeader !== 'platform' &&
      sourceHeader !== 'user' &&
      sourceHeader !== 'legacy-managed'
    ) {
      return apiError('INVALID_MODEL_SOURCE', 400, `Invalid model source: ${sourceHeader}`);
    }
    const source = sourceHeader as 'platform' | 'user' | 'legacy-managed' | undefined;
    if (source === 'platform' && !platformDefaultId) {
      return apiError(
        'INVALID_MODEL_SOURCE',
        400,
        'A platform model selection requires a platform default ID',
      );
    }
    if (source !== 'platform' && platformDefaultId) {
      return apiError(
        'INVALID_MODEL_SOURCE',
        400,
        'A platform default ID can only be used with the platform model source',
      );
    }

    if (!model && source !== 'platform') {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Model name is required');
    }

    // Parse model string and resolve server-side fallback
    let languageModel;
    try {
      const result = await resolveModel({
        // A platform selection is represented only by its stable ID. Do not
        // forward client model/credential/address fields into the resolver.
        modelString: source === 'platform' ? `platform:${platformDefaultId}` : model,
        apiKey: source === 'platform' ? undefined : apiKey || '',
        baseUrl: source === 'platform' ? undefined : baseUrl || undefined,
        providerType: source === 'platform' ? undefined : providerType,
        source,
        platformDefaultId,
      });
      languageModel = result.model;
    } catch (error) {
      const resolutionError = getModelResolutionError(error);
      if (resolutionError) {
        return apiError(resolutionError.code, resolutionError.httpStatus, resolutionError.message);
      }
      return apiError(
        'INVALID_REQUEST',
        401,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Send a minimal test message. Use the unified wrapper so compatible
    // providers can receive provider-specific request options.
    const { text } = await callLLM(
      {
        model: languageModel,
        prompt: 'Say "OK" if you can hear me.',
        maxOutputTokens: 64,
      },
      'verify-model',
      undefined,
      { mode: 'disabled', enabled: false },
    );

    return apiSuccess({
      message: 'Connection successful',
      response: text,
    });
  } catch (error) {
    log.error(`Model verification failed [model="${model ?? 'unknown'}"]:`, error);

    let errorMessage = 'Connection failed';
    if (error instanceof Error) {
      // Parse common error messages
      if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        errorMessage = 'API key is invalid or expired';
      } else if (error.message.includes('404') || error.message.includes('not found')) {
        errorMessage = 'Model not found or API endpoint error';
      } else if (error.message.includes('429')) {
        errorMessage = 'API rate limit exceeded, please try again later';
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        errorMessage = 'Cannot connect to API server, please check the Base URL';
      } else if (error.message.includes('timeout')) {
        errorMessage = 'Connection timed out, please check your network';
      } else {
        errorMessage = error.message;
      }
    }

    return apiError('INTERNAL_ERROR', 500, errorMessage);
  }
}
