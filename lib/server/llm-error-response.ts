import { apiError } from '@/lib/server/api-response';
import {
  getBindingResolutionError,
  isGatewayError,
  type GatewayError,
  type GatewayErrorCode,
} from '@/lib/model-gateway';

const HTTP_ERROR_MIN = 400;
const HTTP_ERROR_MAX = 599;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toHttpErrorStatus(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;

  return Number.isInteger(parsed) && parsed >= HTTP_ERROR_MIN && parsed <= HTTP_ERROR_MAX
    ? parsed
    : undefined;
}

/** HTTP status for a classified gateway failure (plan 3.8). */
const GATEWAY_STATUS: Partial<Record<GatewayErrorCode, number>> = {
  MODEL_AUTH_FAILED: 401,
  MODEL_REAUTH_REQUIRED: 401,
  MODEL_ENTITLEMENT_DENIED: 402,
  MODEL_NOT_FOUND: 404,
  MODEL_BAD_REQUEST: 400,
  MODEL_CONTEXT_OVERFLOW: 400,
  MODEL_CONTENT_FILTERED: 400,
  MODEL_RATE_LIMITED: 429,
  MODEL_UPSTREAM_UNAVAILABLE: 503,
  MODEL_NETWORK: 502,
  MODEL_TIMEOUT: 504,
  MODEL_GATEWAY_UNAVAILABLE: 503,
};

function gatewayStatus(error: GatewayError): number | undefined {
  // The upstream status is authoritative when the provider sent one (403 vs 401, 500 vs 503).
  return toHttpErrorStatus(error.status) ?? GATEWAY_STATUS[error.code];
}

/** Other errors that carry a provider status (e.g. PBLGenerationError wrapping one). */
function statusFromError(error: unknown, seen = new Set<unknown>()): number | undefined {
  if (!error || seen.has(error)) return undefined;
  seen.add(error);
  if (isGatewayError(error)) return gatewayStatus(error);
  if (!isRecord(error)) return undefined;

  const status = toHttpErrorStatus(error.statusCode ?? error.status ?? error.status_code);
  if (status !== undefined) return status;

  return statusFromError(error.cause, seen) ?? statusFromError(error.lastError, seen);
}

function messageForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'Upstream authentication or authorization failed.';
  }
  if (status === 402) return 'This model is not available for the current account.';
  if (status === 404) return 'Upstream endpoint not found.';
  if (status === 429) return 'Upstream rate limit reached. Please try again shortly.';
  if (status >= 500) return 'Upstream model provider is temporarily unavailable. Please try again.';
  return 'Upstream provider rejected the request.';
}

/**
 * Preserve a provider's HTTP semantics for client retry classification without
 * exposing provider response bodies, URLs, or credential-adjacent details.
 */
export function llmApiError(error: unknown) {
  const resolutionError = getBindingResolutionError(error);
  if (resolutionError) {
    return apiError(resolutionError.code, resolutionError.httpStatus, resolutionError.message);
  }
  const status = statusFromError(error);
  if (status === undefined) {
    return apiError('INTERNAL_ERROR', 500, 'Scene generation failed. Please try again.');
  }

  return apiError(
    status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
    status,
    messageForStatus(status),
  );
}
