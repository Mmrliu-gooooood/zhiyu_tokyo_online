import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

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
    vi.resetModules();
    mocks.resolveModel.mockReset();
    mocks.callLLM.mockReset();
    mocks.resolveModel.mockResolvedValue({ model: { id: 'language-model' } });
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

  it('uses the unified LLM wrapper with thinking disabled for connection checks', async () => {
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
      {
        model: { id: 'language-model' },
        prompt: 'Say "OK" if you can hear me.',
        maxOutputTokens: 64,
      },
      'verify-model',
      undefined,
      { mode: 'disabled', enabled: false },
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
      modelString: 'platform:zhiyu-default-text',
      apiKey: undefined,
      baseUrl: undefined,
      providerType: undefined,
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
      platformDefaultId: undefined,
    });
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
