import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/model-gateway', async (importOriginal) =>
  (await import('@/tests/helpers/model-gateway-mock')).mockGatewayModule(await importOriginal(), {
    resolveParamsBinding: mocks.resolveModel,
    complete: mocks.callLLM,
  }),
);

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postVerifyModel(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const { POST } = await import('@/app/api/verify-model/route');
  const request = new Request('http://localhost/api/verify-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/verify-model', () => {
  beforeEach(() => {
    mocks.resolveModel.mockReset();
    mocks.callLLM.mockReset();
    mocks.resolveModel.mockImplementation(async () =>
      (await import('@/tests/helpers/legacy-stream-gateway')).testBinding(),
    );
    mocks.callLLM.mockResolvedValue({ text: 'OK' });
  });

  it('rejects requests without a model name', async () => {
    const res = await postVerifyModel({});
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'MISSING_REQUIRED_FIELD',
    });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('calls the gateway once with thinking disabled for connection checks', async () => {
    const res = await postVerifyModel({
      model: 'xiaomi:mimo-v2.5-pro',
      apiKey: 'tp-test',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      providerType: 'openai',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      message: 'Connection successful',
      response: 'OK',
    });
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      modelString: 'xiaomi:mimo-v2.5-pro',
      apiKey: 'tp-test',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      providerType: 'openai',
    });
    expect(mocks.callLLM).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: { mode: 'disabled', enabled: false } }),
      {
        messages: [
          expect.objectContaining({ role: 'user', content: 'Say "OK" if you can hear me.' }),
        ],
        maxOutputTokens: 64,
      },
      expect.objectContaining({ source: 'verify-model', retry: 'none' }),
    );
  });

  it('verifies a platform default by stable ID without forwarding client overrides', async () => {
    const res = await postVerifyModel(
      {
        model: 'deepseek/attacker-model',
        apiKey: 'attacker-key',
        baseUrl: 'https://attacker.example/v1',
        providerType: 'anthropic',
      },
      {
        'x-model-source': 'platform',
        'x-platform-default-id': 'zhiyu-default-text',
      },
    );

    expect(res.status).toBe(200);
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      source: 'platform',
      platformDefaultId: 'zhiyu-default-text',
    });
  });

  it('keeps an explicit user selection on its own same-vendor credentials', async () => {
    const res = await postVerifyModel(
      {
        model: 'deepseek/deepseek-chat',
        apiKey: 'user-key',
        baseUrl: 'https://user.example/v1',
        providerType: 'openai',
      },
      { 'x-model-source': 'user' },
    );

    expect(res.status).toBe(200);
    expect(mocks.resolveModel).toHaveBeenCalledWith({
      modelString: 'deepseek/deepseek-chat',
      apiKey: 'user-key',
      baseUrl: 'https://user.example/v1',
      providerType: 'openai',
      source: 'user',
    });
  });

  it.each([
    ['MODEL_AUTH_FAILED', 401, 'API key is invalid or expired'],
    ['MODEL_RATE_LIMITED', 429, 'API rate limit exceeded, please try again later'],
    ['MODEL_NETWORK', 502, 'Cannot connect to API server, please check the Base URL'],
  ] as const)('maps %s to a fixed message without upstream text', async (code, status, message) => {
    const { GatewayError } = await import('@/lib/model-gateway');
    mocks.callLLM.mockRejectedValue(
      new GatewayError(code, {
        providerId: 'openai',
        modelId: 'test-model',
        cause: new Error('upstream body sk-secret'),
      }),
    );
    const res = await postVerifyModel({ model: 'openai:test-model', apiKey: 'k' });
    const json = await res.json();
    expect(res.status).toBe(status);
    expect(json.error).toBe(message);
    expect(JSON.stringify(json)).not.toContain('sk-secret');
  });

  it('rejects a platform default ID mixed with a user source', async () => {
    const res = await postVerifyModel(
      { model: 'deepseek/deepseek-chat', apiKey: 'user-key' },
      {
        'x-model-source': 'user',
        'x-platform-default-id': 'zhiyu-default-text',
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errorCode: 'INVALID_MODEL_SOURCE' });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });
});
