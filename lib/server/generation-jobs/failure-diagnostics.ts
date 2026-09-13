/** Deliberately excludes messages, response bodies, URLs and request configuration. */
export interface ProviderFailureDiagnostic {
  providerId?: string;
  httpStatus?: number;
  providerCode?: number | string;
  traceId?: string;
  phase?: 'response' | 'decode';
  responseReceived?: boolean;
  retryClassification?: 'terminal' | 'transient' | 'rate_limit' | 'unknown';
}

/** Re-apply the whitelist at both the execution and persistence boundaries. */
export function providerFailureDiagnostic(value: unknown): ProviderFailureDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const result: ProviderFailureDiagnostic = {};
  const provider = source.providerId ?? source.provider;
  if (typeof provider === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(provider)) {
    result.providerId = provider;
  }
  if (
    Number.isInteger(source.httpStatus) &&
    Number(source.httpStatus) >= 100 &&
    Number(source.httpStatus) <= 599
  ) {
    result.httpStatus = source.httpStatus as number;
  }
  if (
    typeof source.providerCode === 'number' &&
    Number.isSafeInteger(source.providerCode) &&
    source.providerCode >= 0
  ) {
    result.providerCode = source.providerCode;
  } else if (
    typeof source.providerCode === 'string' &&
    /^[A-Z0-9_]{1,64}$/.test(source.providerCode)
  ) {
    result.providerCode = source.providerCode;
  }
  if (typeof source.traceId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(source.traceId)) {
    result.traceId = source.traceId;
  }
  if (source.phase === 'response' || source.phase === 'decode') result.phase = source.phase;
  if (typeof source.responseReceived === 'boolean')
    result.responseReceived = source.responseReceived;
  if (
    source.retryClassification === 'terminal' ||
    source.retryClassification === 'transient' ||
    source.retryClassification === 'rate_limit' ||
    source.retryClassification === 'unknown'
  ) {
    result.retryClassification = source.retryClassification;
  }
  return Object.keys(result).length ? result : undefined;
}
