/**
 * P5-1: the browser encodes a Home model configuration once (headers or JSON
 * body), and the server's selection readers recover the same ModelSelection,
 * including the catalog connection fields (wire API, endpoint profile and
 * endpoint values).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/store/settings', () => ({ useSettingsStore: { getState: () => ({}) } }));

import { modelRequestBodyFields, modelRequestHeaders } from '@/lib/utils/model-config';
import { modelConfigSelection } from '@/lib/utils/model-selection';
import { modelParamsFromBody, readModelSelection, selectionFromParams } from '@/lib/model-gateway';
import type { ModelConfigInput } from '@/types/pro-model';

function headerSource(headers: Record<string, string>) {
  return { headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
}

const cloudflare: ModelConfigInput = {
  source: 'user',
  modelString: 'cloudflare-ai-gateway:claude-sonnet-5',
  apiKey: 'cf-key',
  providerType: 'anthropic',
  endpointParams: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_GATEWAY_ID: 'gw' },
};

const customResponses: ModelConfigInput = {
  source: 'user',
  modelString: 'custom-1759300000000:house-model',
  apiKey: 'sk-house',
  baseUrl: 'https://gateway.example.com/v1',
  providerType: 'openai',
  api: 'openai-responses',
};

describe('model request fields', () => {
  it('a platform selection sends only its stable id', () => {
    expect(
      modelRequestHeaders({ source: 'platform', defaultId: 'zhiyu-default-text', apiKey: 'x' }),
    ).toEqual({ 'x-model-source': 'platform', 'x-platform-default-id': 'zhiyu-default-text' });
    expect(
      modelRequestBodyFields({ source: 'platform', defaultId: 'zhiyu-default-text', apiKey: 'x' }),
    ).toEqual({ apiKey: '', modelSource: 'platform', platformDefaultId: 'zhiyu-default-text' });
  });

  it.each([
    ['catalog endpoint values', cloudflare],
    ['custom provider wire API', customResponses],
  ])('headers and body round-trip %s to the same selection', (_label, config) => {
    const expected = modelConfigSelection(config);
    expect(expected?.source).toBe('user');

    const fromHeaders = readModelSelection(headerSource(modelRequestHeaders(config)));
    expect(fromHeaders.error).toBeUndefined();
    expect(fromHeaders.selection).toEqual(expected);

    const fromBody = selectionFromParams(
      modelParamsFromBody(JSON.parse(JSON.stringify(modelRequestBodyFields(config)))),
    );
    expect(fromBody.error).toBeUndefined();
    expect(fromBody.selection).toEqual(expected);
  });

  it('carries the endpoint values and protocol into the connection', () => {
    const selection = modelConfigSelection(cloudflare);
    expect(selection).toMatchObject({
      providerId: 'cloudflare-ai-gateway',
      connection: {
        auth: 'api-key',
        endpointParams: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_GATEWAY_ID: 'gw' },
      },
    });
    expect(modelConfigSelection(customResponses)).toMatchObject({
      connection: { api: 'openai-responses', baseUrl: 'https://gateway.example.com/v1' },
    });
  });

  it('blank endpoint values are not sent', () => {
    const headers = modelRequestHeaders({
      ...cloudflare,
      endpointParams: { CLOUDFLARE_ACCOUNT_ID: ' ', CLOUDFLARE_GATEWAY_ID: '' },
    });
    expect(headers['x-model-endpoint-params']).toBeUndefined();
  });

  it('malformed body endpoint values are rejected by the selection schema', () => {
    const result = selectionFromParams(
      modelParamsFromBody({ ...modelRequestBodyFields(cloudflare), endpointParams: { A: 1 } }),
    );
    expect(result.error?.code).toBe('INVALID_MODEL_SELECTION');
  });
});
