import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ validateUrlForSSRF: vi.fn() }));

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: mocks.validateUrlForSSRF,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postProbeModels(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const { POST } = await import('@/app/api/provider/probe-models/route');
  const request = new Request('http://localhost/api/provider/probe-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/provider/probe-models', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.validateUrlForSSRF.mockReset();
    mocks.validateUrlForSSRF.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps an upstream redirect to the exact redirect-not-allowed contract without reading it', async () => {
    const text = vi.fn().mockResolvedValue('redirect response body');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      text,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const res = await postProbeModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toEqual({
      success: false,
      errorCode: 'REDIRECT_NOT_ALLOWED',
      error: 'Redirects are not allowed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
  });

  it('preserves successful model filtering and response metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: 'chat-model', owned_by: 'provider' },
              { id: 'text-embedding-3-small', owned_by: 'provider' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const res = await postProbeModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      success: true,
      models: [{ id: 'chat-model', ownedBy: 'provider' }],
      total: 2,
      filtered: 1,
    });
  });

  it.each([401, 403])('preserves the API-key error contract for upstream %i', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        text: vi.fn().mockResolvedValue('invalid key'),
      } as unknown as Response),
    );

    const res = await postProbeModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'bad-key',
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'API key is invalid or expired',
    });
  });

  it('preserves the manual-entry response when no model endpoint exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: vi.fn(),
      } as unknown as Response),
    );

    const res = await postProbeModels({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toEqual({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'This provider does not expose a model list',
    });
  });

  it('does not send platform credentials or client overrides through model probing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await postProbeModels(
      {
        baseUrl: 'https://attacker.example/v1',
        apiKey: 'attacker-key',
      },
      {
        'x-model-source': 'platform',
        'x-platform-default-id': 'zhiyu-default-text',
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errorCode: 'INVALID_MODEL_SOURCE' });
    expect(mocks.validateUrlForSSRF).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers catalog providers on their default endpoint from the reviewed catalog', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await postProbeModels({
      providerId: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'k',
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.models.length).toBeGreaterThan(0);
    expect(json.models.map((model: { id: string }) => model.id)).toContain('claude-sonnet-4-5');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for manual entry for providers without model discovery', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await postProbeModels({
      providerId: 'azure',
      baseUrl: 'https://example.openai.azure.com/openai',
      apiKey: 'k',
    });

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
