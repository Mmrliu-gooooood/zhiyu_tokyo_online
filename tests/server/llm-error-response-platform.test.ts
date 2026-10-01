import { describe, expect, it } from 'vitest';
import { llmApiError } from '@/lib/server/llm-error-response';
import { GatewayError, ModelSelectionError } from '@/lib/model-gateway';
import { PlatformDefaultModelError } from '@/lib/server/provider-config';

describe('LLM platform model error responses', () => {
  it('preserves a disabled platform default error code and status', async () => {
    const response = llmApiError(
      new PlatformDefaultModelError(
        'PLATFORM_DEFAULT_DISABLED',
        'Platform default zhiyu-default-text is disabled',
        403,
      ),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'PLATFORM_DEFAULT_DISABLED',
    });
  });

  it('preserves invalid source semantics instead of returning an internal error', async () => {
    const response = llmApiError(
      new ModelSelectionError('INVALID_MODEL_SOURCE', 400, 'Invalid model source'),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_MODEL_SOURCE',
    });
  });

  it.each([
    ['MODEL_RATE_LIMITED', undefined, 429, 'RATE_LIMITED'],
    ['MODEL_AUTH_FAILED', 403, 403, 'UPSTREAM_ERROR'],
    ['MODEL_AUTH_FAILED', undefined, 401, 'UPSTREAM_ERROR'],
    ['MODEL_ENTITLEMENT_DENIED', undefined, 402, 'UPSTREAM_ERROR'],
    ['MODEL_UPSTREAM_UNAVAILABLE', 500, 500, 'UPSTREAM_ERROR'],
    ['MODEL_NETWORK', undefined, 502, 'UPSTREAM_ERROR'],
    ['MODEL_CONFIGURATION', undefined, 400, 'MODEL_CONFIGURATION'],
  ] as const)(
    'maps gateway %s (status %s) to HTTP %s',
    async (code, upstream, status, errorCode) => {
      const response = llmApiError(
        new GatewayError(code, {
          providerId: 'deepseek',
          modelId: 'deepseek-flash',
          ...(upstream ? { status: upstream } : {}),
          cause: new Error('upstream body with sk-secret'),
        }),
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toMatchObject({ success: false, errorCode });
      expect(JSON.stringify(body)).not.toContain('sk-secret');
    },
  );
});
