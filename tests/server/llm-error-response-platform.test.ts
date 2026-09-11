import { describe, expect, it } from 'vitest';
import { llmApiError } from '@/lib/server/llm-error-response';
import { ModelSelectionError } from '@/lib/server/resolve-model';
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
});
