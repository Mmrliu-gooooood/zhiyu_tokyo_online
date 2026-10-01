/**
 * Structured gateway errors. `message` is always a fixed, sanitized sentence:
 * upstream bodies, URLs and headers never reach it or the logs.
 */
import type { GatewayErrorLike } from '../types';

export type GatewayErrorCode =
  | 'MODEL_CONFIGURATION'
  | 'MODEL_UNSAFE_ENDPOINT'
  | 'MODEL_AUTH_FAILED'
  | 'MODEL_REAUTH_REQUIRED'
  | 'MODEL_ENTITLEMENT_DENIED'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_BAD_REQUEST'
  | 'MODEL_CONTEXT_OVERFLOW'
  | 'MODEL_CONTENT_FILTERED'
  | 'MODEL_UPSTREAM_UNAVAILABLE'
  | 'MODEL_NETWORK'
  | 'MODEL_TIMEOUT'
  | 'MODEL_ABORTED';

const MESSAGES: Record<GatewayErrorCode, string> = {
  MODEL_CONFIGURATION: 'The model is not configured correctly.',
  MODEL_UNSAFE_ENDPOINT: 'The model endpoint is not allowed.',
  MODEL_AUTH_FAILED: 'The model provider rejected the credentials.',
  MODEL_REAUTH_REQUIRED: 'The model account must be signed in again.',
  MODEL_ENTITLEMENT_DENIED: 'This model is not available for the current account.',
  MODEL_RATE_LIMITED: 'The model provider is rate limiting requests.',
  MODEL_NOT_FOUND: 'The model or endpoint was not found.',
  MODEL_BAD_REQUEST: 'The model provider rejected the request.',
  MODEL_CONTEXT_OVERFLOW: 'The request exceeds the model context window.',
  MODEL_CONTENT_FILTERED: 'The model provider filtered the content.',
  MODEL_UPSTREAM_UNAVAILABLE: 'The model provider is unavailable.',
  MODEL_NETWORK: 'The model provider could not be reached.',
  MODEL_TIMEOUT: 'The model request timed out.',
  MODEL_ABORTED: 'The model request was cancelled.',
};

export interface GatewayErrorInit {
  status?: number;
  retryAfterMs?: number;
  requestSent?: boolean;
  outputObserved?: boolean;
  safeToRetry?: boolean;
  providerId: string;
  modelId: string;
  /** Sanitized upstream request id for support, if present. */
  upstreamRequestId?: string;
  cause?: unknown;
}

export class GatewayError extends Error implements GatewayErrorLike {
  readonly code: GatewayErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestSent: boolean;
  readonly outputObserved: boolean;
  readonly safeToRetry: boolean;
  readonly providerId: string;
  readonly modelId: string;
  readonly upstreamRequestId?: string;

  constructor(code: GatewayErrorCode, init: GatewayErrorInit) {
    super(MESSAGES[code], init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'GatewayError';
    this.code = code;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.requestSent = init.requestSent ?? false;
    this.outputObserved = init.outputObserved ?? false;
    this.safeToRetry = init.safeToRetry ?? false;
    this.providerId = init.providerId;
    this.modelId = init.modelId;
    this.upstreamRequestId = init.upstreamRequestId;
  }

  /** Compatibility with limiter.ts, which reads AI SDK APICallError fields. */
  get statusCode(): number | undefined {
    return this.code === 'MODEL_RATE_LIMITED' ? (this.status ?? 429) : this.status;
  }

  /** Compatibility with limiter.ts: `retry-after` in whole seconds. */
  get responseHeaders(): Record<string, string> {
    return this.retryAfterMs === undefined
      ? {}
      : { 'retry-after': String(Math.max(1, Math.ceil(this.retryAfterMs / 1000))) };
  }

  /** Never serialize the cause chain (it may contain upstream bodies). */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
      requestSent: this.requestSent,
      outputObserved: this.outputObserved,
      providerId: this.providerId,
      modelId: this.modelId,
    };
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError;
}

export function gatewayErrorMessage(code: GatewayErrorCode): string {
  return MESSAGES[code];
}
