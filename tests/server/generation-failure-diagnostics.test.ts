import { describe, expect, it } from 'vitest';
import { providerFailureDiagnostic } from '@/lib/server/generation-jobs/failure-diagnostics';

describe('safe provider failure diagnostic boundary', () => {
  it('never serializes provider messages, response bodies or credential fields', () => {
    expect(
      providerFailureDiagnostic({
        provider: 'minimax-tts',
        httpStatus: 200,
        providerCode: 1004,
        traceId: 'trace-123',
        message: 'private text',
        apiKey: 'private-secret',
        response: { private: true },
      }),
    ).toEqual({
      providerId: 'minimax-tts',
      httpStatus: 200,
      providerCode: 1004,
      traceId: 'trace-123',
    });
  });
  it('rejects URLs, free text, invalid statuses and unbounded identifiers', () => {
    expect(
      providerFailureDiagnostic({
        providerId: 'https://private.test',
        httpStatus: 0,
        providerCode: 'Bearer private',
        traceId: 'x'.repeat(129),
        phase: 'private data',
      }),
    ).toBeUndefined();
  });
  it('keeps only supported response phases and retry classifications', () => {
    expect(
      providerFailureDiagnostic({
        phase: 'decode',
        retryClassification: 'unknown',
        responseReceived: true,
      }),
    ).toEqual({ phase: 'decode', retryClassification: 'unknown', responseReceived: true });
  });
});
