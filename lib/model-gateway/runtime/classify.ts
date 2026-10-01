/**
 * Turn a failed pi attempt into a GatewayError. Priority (plan 3.8): side
 * channel status > network error code > pi context-overflow detection >
 * pi stop reason / message patterns (only for adapters without a side channel,
 * i.e. Google and Bedrock).
 */
import { GatewayError, type GatewayErrorCode } from './errors';
import { isContextOverflow } from './pi-registry';
import type { SideChannel } from './transport';
import type { AssistantMessage } from '../types';

export interface FailureContext {
  providerId: string;
  modelId: string;
  contextWindow?: number;
  channel?: SideChannel;
  /** pi's terminal message for the attempt, if one was produced. */
  message?: AssistantMessage;
  /** A thrown error (setup failure, ModelsError, abort reason). */
  thrown?: unknown;
  outputObserved: boolean;
  aborted: boolean;
}

const PRE_SEND_TIMEOUT = new Set(['UND_ERR_CONNECT_TIMEOUT']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ESOCKETTIMEDOUT',
]);

function parseRetryAfter(headers: SideChannel['headers']): number | undefined {
  const ms = Number(headers['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function fromStatus(status: number, overflow: boolean): GatewayErrorCode {
  if (status === 401 || status === 403) return 'MODEL_AUTH_FAILED';
  if (status === 402) return 'MODEL_ENTITLEMENT_DENIED';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 408) return 'MODEL_TIMEOUT';
  if (status === 429) return 'MODEL_RATE_LIMITED';
  if (overflow) return 'MODEL_CONTEXT_OVERFLOW';
  if (status === 413) return 'MODEL_CONTEXT_OVERFLOW';
  if (status >= 500) return 'MODEL_UPSTREAM_UNAVAILABLE';
  return 'MODEL_BAD_REQUEST';
}

function fromNetworkCode(code: string): GatewayErrorCode {
  if (code === 'UNSAFE_NETWORK_TARGET') return 'MODEL_UNSAFE_ENDPOINT';
  if (TIMEOUT_CODES.has(code) || PRE_SEND_TIMEOUT.has(code)) return 'MODEL_TIMEOUT';
  return 'MODEL_NETWORK';
}

const PATTERNS: Array<[RegExp, GatewayErrorCode]> = [
  [
    /\b(401|403)\b|unauthori[sz]ed|invalid[ _-]?api[ _-]?key|permission denied|authentication/i,
    'MODEL_AUTH_FAILED',
  ],
  [
    /\b429\b|rate[ _-]?limit|too many requests|quota exceeded|resource[ _-]?exhausted/i,
    'MODEL_RATE_LIMITED',
  ],
  [/content[ _-]?filter|safety|blocked|prohibited content/i, 'MODEL_CONTENT_FILTERED'],
  [/\b404\b|not[ _-]?found/i, 'MODEL_NOT_FOUND'],
  [/timed? ?out|timeout/i, 'MODEL_TIMEOUT'],
  [/\b5\d\d\b|overloaded|unavailable|internal error|bad gateway/i, 'MODEL_UPSTREAM_UNAVAILABLE'],
  [/\b(400|422)\b|invalid|bad request/i, 'MODEL_BAD_REQUEST'],
  [/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i, 'MODEL_NETWORK'],
];

/**
 * Bedrock: pi prefixes the AWS SDK exception (its `name`, or a fixed label
 * for a few) to the message: `ThrottlingException: …`, `Throttling error: …`.
 */
const BEDROCK_EXCEPTIONS: Record<string, GatewayErrorCode> = {
  ThrottlingException: 'MODEL_RATE_LIMITED',
  'Throttling error': 'MODEL_RATE_LIMITED',
  ServiceQuotaExceededException: 'MODEL_RATE_LIMITED',
  AccessDeniedException: 'MODEL_AUTH_FAILED',
  UnrecognizedClientException: 'MODEL_AUTH_FAILED',
  ExpiredTokenException: 'MODEL_AUTH_FAILED',
  ValidationException: 'MODEL_BAD_REQUEST',
  'Validation error': 'MODEL_BAD_REQUEST',
  ResourceNotFoundException: 'MODEL_NOT_FOUND',
  ModelTimeoutException: 'MODEL_TIMEOUT',
  ModelNotReadyException: 'MODEL_UPSTREAM_UNAVAILABLE',
  ModelErrorException: 'MODEL_UPSTREAM_UNAVAILABLE',
  ServiceUnavailableException: 'MODEL_UPSTREAM_UNAVAILABLE',
  'Service unavailable': 'MODEL_UPSTREAM_UNAVAILABLE',
  InternalServerException: 'MODEL_UPSTREAM_UNAVAILABLE',
  'Internal server error': 'MODEL_UPSTREAM_UNAVAILABLE',
  ModelStreamErrorException: 'MODEL_UPSTREAM_UNAVAILABLE',
  'Model stream error': 'MODEL_UPSTREAM_UNAVAILABLE',
};

/** Google RPC status names (the `error.status` of a Gemini API error body). */
const GOOGLE_STATUSES: Record<string, GatewayErrorCode> = {
  RESOURCE_EXHAUSTED: 'MODEL_RATE_LIMITED',
  UNAUTHENTICATED: 'MODEL_AUTH_FAILED',
  PERMISSION_DENIED: 'MODEL_AUTH_FAILED',
  INVALID_ARGUMENT: 'MODEL_BAD_REQUEST',
  FAILED_PRECONDITION: 'MODEL_BAD_REQUEST',
  OUT_OF_RANGE: 'MODEL_BAD_REQUEST',
  NOT_FOUND: 'MODEL_NOT_FOUND',
  DEADLINE_EXCEEDED: 'MODEL_TIMEOUT',
  UNAVAILABLE: 'MODEL_UPSTREAM_UNAVAILABLE',
  INTERNAL: 'MODEL_UPSTREAM_UNAVAILABLE',
};

interface StructuredFailure {
  code: GatewayErrorCode;
  status?: number;
  retryAfterMs?: number;
}

/** `"30s"` / `"1.5s"` (google.rpc.RetryInfo.retryDelay) → ms. */
function parseDuration(value: unknown): number | undefined {
  const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(value) : null;
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

function googleBody(text: string): StructuredFailure | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
  const error = (parsed as { error?: Record<string, unknown> } | null)?.error;
  if (!error || typeof error !== 'object') return undefined;
  const status = typeof error.code === 'number' ? error.code : undefined;
  const details = Array.isArray(error.details) ? (error.details as Record<string, unknown>[]) : [];
  // An invalid key is a 400 INVALID_ARGUMENT whose ErrorInfo reason names it.
  const badKey = details.some((detail) => detail.reason === 'API_KEY_INVALID');
  const named = typeof error.status === 'string' ? GOOGLE_STATUSES[error.status] : undefined;
  const code = badKey
    ? 'MODEL_AUTH_FAILED'
    : (named ?? (status !== undefined ? fromStatus(status, false) : undefined));
  if (!code) return undefined;
  const retryAfterMs = details
    .map((detail) => parseDuration(detail.retryDelay))
    .find((value) => value !== undefined);
  return { code, status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

/**
 * Structured failure details pi keeps in its error text for the SDK-transport
 * adapters (no side channel): the Bedrock exception name, the Google error
 * body (`code`, `status`, RetryInfo), or pi's `<status>: <body>` prefix.
 */
export function structuredFailure(text: string): StructuredFailure | undefined {
  const prefix = /^([A-Za-z][A-Za-z ]*?):\s/.exec(text)?.[1];
  if (prefix && BEDROCK_EXCEPTIONS[prefix]) return { code: BEDROCK_EXCEPTIONS[prefix] };
  const google = googleBody(text);
  if (google) return google;
  const status = /^(\d{3}):\s/.exec(text)?.[1] ?? /\((\d{3})\):\s/.exec(text)?.[1];
  if (status) return { code: fromStatus(Number(status), false), status: Number(status) };
  return undefined;
}

const CONFIGURATION_MESSAGE = /No API key for provider|Provider is not configured|Unknown provider/;

function isConfigurationError(thrown: unknown): boolean {
  const name = (thrown as { name?: unknown } | undefined)?.name;
  const code = (thrown as { code?: unknown } | undefined)?.code;
  const message = thrown instanceof Error ? thrown.message : '';
  return (
    (name === 'ModelsError' && (code === 'auth' || code === 'provider')) ||
    CONFIGURATION_MESSAGE.test(message)
  );
}

export function classifyFailure(ctx: FailureContext): GatewayError {
  const channel = ctx.channel;
  const message = ctx.message;
  const base = {
    providerId: ctx.providerId,
    modelId: ctx.modelId,
    outputObserved: ctx.outputObserved,
    upstreamRequestId: channel?.headers['x-request-id'] ?? channel?.headers['request-id'],
    cause: ctx.thrown,
  };

  if (ctx.aborted || message?.stopReason === 'aborted') {
    return new GatewayError('MODEL_ABORTED', {
      ...base,
      requestSent: channel?.requestSent ?? false,
    });
  }
  if (channel?.unsafeEndpoint) {
    return new GatewayError('MODEL_UNSAFE_ENDPOINT', { ...base, requestSent: false });
  }
  const configurationFailure =
    (ctx.thrown && isConfigurationError(ctx.thrown)) ||
    (!channel?.requestSent && CONFIGURATION_MESSAGE.test(message?.errorMessage ?? ''));
  if (configurationFailure) {
    return new GatewayError('MODEL_CONFIGURATION', { ...base, requestSent: false });
  }

  const overflow = message ? isContextOverflow(message, ctx.contextWindow) : false;
  if (channel?.status !== undefined && channel.status >= 400) {
    const code = fromStatus(channel.status, overflow);
    return new GatewayError(code, {
      ...base,
      status: channel.status,
      retryAfterMs: code === 'MODEL_RATE_LIMITED' ? parseRetryAfter(channel.headers) : undefined,
      requestSent: true,
    });
  }
  if (channel?.networkErrorCode) {
    const code = fromNetworkCode(channel.networkErrorCode);
    return new GatewayError(code, {
      ...base,
      requestSent: channel.requestSent,
      safeToRetry: !channel.requestSent && !ctx.outputObserved,
    });
  }
  if (overflow) {
    return new GatewayError('MODEL_CONTEXT_OVERFLOW', { ...base, requestSent: true });
  }

  // No side channel information (custom fetch unsupported, or a mid-stream
  // failure after a 200): fall back to the message text.
  const text = message?.errorMessage ?? (ctx.thrown instanceof Error ? ctx.thrown.message : '');
  const requestSent = channel?.requestSent ?? true;
  // Structured fields first (Bedrock exception name, Google error body), then patterns.
  const structured = channel?.status === undefined ? structuredFailure(text) : undefined;
  if (structured) {
    return new GatewayError(structured.code, {
      ...base,
      status: structured.status,
      retryAfterMs: structured.code === 'MODEL_RATE_LIMITED' ? structured.retryAfterMs : undefined,
      requestSent,
    });
  }
  const matched = PATTERNS.find(([pattern]) => pattern.test(text))?.[1];
  if (channel?.status !== undefined && channel.status < 400) {
    // The upstream accepted the request and the stream broke afterwards.
    // An in-band error frame names its cause; a broken body is a network failure.
    return new GatewayError(matched ?? 'MODEL_NETWORK', {
      ...base,
      requestSent: true,
    });
  }
  return new GatewayError(matched ?? 'MODEL_UPSTREAM_UNAVAILABLE', { ...base, requestSent });
}
