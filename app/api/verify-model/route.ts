import { hostedAuthGate, withHostedProviderQuota } from '@/lib/auth/api';
import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, type ApiErrorCode } from '@/lib/server/api-response';
import {
  gateway,
  getBindingResolutionError,
  isGatewayError,
  resolveParamsBinding,
  userText,
  withThinking,
  type GatewayErrorCode,
} from '@/lib/model-gateway';
const log = createLogger('Verify Model');

/** Settings-dialog messages for classified failures (no upstream text is echoed). */
const VERIFY_FAILURES: Partial<
  Record<GatewayErrorCode, { code: ApiErrorCode; status: number; message: string }>
> = {
  MODEL_CONFIGURATION: {
    code: 'MISSING_API_KEY',
    status: 400,
    message: 'The model is not configured correctly (API key or endpoint missing)',
  },
  MODEL_UNSAFE_ENDPOINT: {
    code: 'UNSAFE_BASE_URL',
    status: 400,
    message: 'This Base URL is not allowed',
  },
  MODEL_AUTH_FAILED: {
    code: 'INVALID_CREDENTIALS',
    status: 401,
    message: 'API key is invalid or expired',
  },
  MODEL_REAUTH_REQUIRED: {
    code: 'INVALID_CREDENTIALS',
    status: 401,
    message: 'The account must be signed in again',
  },
  MODEL_NOT_FOUND: {
    code: 'UPSTREAM_ERROR',
    status: 404,
    message: 'Model not found or API endpoint error',
  },
  MODEL_RATE_LIMITED: {
    code: 'RATE_LIMITED',
    status: 429,
    message: 'API rate limit exceeded, please try again later',
  },
  MODEL_NETWORK: {
    code: 'UPSTREAM_ERROR',
    status: 502,
    message: 'Cannot connect to API server, please check the Base URL',
  },
  MODEL_TIMEOUT: {
    code: 'UPSTREAM_ERROR',
    status: 504,
    message: 'Connection timed out, please check your network',
  },
};

export async function POST(req: NextRequest) {
  return withHostedProviderQuota(req, () => handlePOST(req));
}

async function handlePOST(req: NextRequest) {
  const denied = await hostedAuthGate(req);
  if (denied) return denied;
  let model: string | undefined;
  try {
    const body = await req.json();
    const { apiKey, baseUrl, providerType, api } = body;
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

    let binding;
    try {
      binding = await resolveParamsBinding(
        // A platform selection is represented only by its stable ID. Do not
        // forward client model/credential/address fields into the resolver.
        source === 'platform'
          ? { source, platformDefaultId }
          : {
              modelString: model,
              apiKey: apiKey || '',
              baseUrl: baseUrl || undefined,
              providerType,
              ...(typeof api === 'string' ? { api } : {}),
              ...(source ? { source } : {}),
            },
      );
    } catch (error) {
      const resolutionError = getBindingResolutionError(error);
      if (resolutionError) {
        return apiError(resolutionError.code, resolutionError.httpStatus, resolutionError.message);
      }
      throw error;
    }

    // A minimal request with thinking off; one try (the user retries by hand).
    const { text } = await gateway.complete(
      withThinking(binding, { mode: 'disabled', enabled: false }),
      { messages: [userText('Say "OK" if you can hear me.')], maxOutputTokens: 64 },
      { source: 'verify-model', retry: 'none', signal: req.signal },
    );

    return apiSuccess({
      message: 'Connection successful',
      response: text,
    });
  } catch (error) {
    log.error(`Model verification failed [model="${model ?? 'unknown'}"]:`, error);
    const failure = isGatewayError(error) ? VERIFY_FAILURES[error.code] : undefined;
    if (failure) return apiError(failure.code, failure.status, failure.message);
    return apiError(
      'INTERNAL_ERROR',
      500,
      isGatewayError(error) ? error.message : 'Connection failed',
    );
  }
}
