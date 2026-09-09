import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  managed: vi.fn(),
  unsafe: vi.fn<(url: string) => Promise<string | null>>(),
}));
vi.mock('@/lib/server/provider-config', () => ({ isServerConfiguredProvider: mocks.managed }));
vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: mocks.unsafe,
}));
vi.mock('@/lib/server/generation-model-snapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/generation-model-snapshots')>()),
  syncGenerationModelSnapshot: mocks.sync,
}));
vi.mock('@/lib/server/generation-jobs/http', () => ({
  readGenerationJson: (req: Request) => req.json(),
  generationResponse: (body: unknown, headers: Headers, status: number) =>
    Response.json(body, { headers, status }),
  withGenerationRequest: async (
    _req: Request,
    handler: (context: { ownerId: string; headers: Headers }) => Promise<Response>,
    options: { createSession: boolean; submitting: boolean },
  ) => {
    expect(options).toEqual({ createSession: true, submitting: true });
    return handler({ ownerId: 'signed-owner', headers: new Headers() });
  },
}));
import { POST } from '@/app/api/generate-classroom/model-snapshots/route';

const ref = { id: '123e4567-e89b-42d3-a456-426614174099', revision: 1 };

function request(content: unknown) {
  return new Request('http://localhost/api/generate-classroom/model-snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(content),
  });
}

function model(baseUrl?: string) {
  return {
    modelString: 'openai:gpt-4.1',
    apiKey: 'diagnostic-placeholder',
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.managed.mockReturnValue(false);
  mocks.unsafe.mockResolvedValue(null);
  mocks.sync.mockResolvedValue(ref);
});

describe('normal generation model snapshot route', () => {
  it('accepts an omitted optional base URL', async () => {
    const response = await POST(request(model()));

    expect(response.status).toBe(201);
    expect(mocks.sync).toHaveBeenCalledWith('signed-owner', {
      version: 1,
      modelString: 'openai:gpt-4.1',
      apiKey: 'diagnostic-placeholder',
    });
  });

  it.each(['', '   '])('treats an empty optional base URL as omitted (%j)', async (baseUrl) => {
    const response = await POST(request(model(baseUrl)));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, ref });
    expect(mocks.sync).toHaveBeenCalledWith('signed-owner', {
      version: 1,
      modelString: 'openai:gpt-4.1',
      apiKey: 'diagnostic-placeholder',
    });
  });

  it('preserves a valid custom base URL', async () => {
    const response = await POST(request(model('  https://gateway.example.com/v1  ')));

    expect(response.status).toBe(201);
    expect(mocks.sync).toHaveBeenCalledWith('signed-owner', {
      version: 1,
      modelString: 'openai:gpt-4.1',
      apiKey: 'diagnostic-placeholder',
      baseUrl: 'https://gateway.example.com/v1',
    });
  });

  it('keeps operator-managed provider credentials and endpoints server-owned', async () => {
    mocks.managed.mockReturnValue(true);

    await POST(request(model('http://127.0.0.1/stale-client-endpoint')));

    expect(mocks.sync).toHaveBeenCalledWith('signed-owner', {
      version: 1,
      modelString: 'openai:gpt-4.1',
    });
  });

  it('continues to reject unsafe non-empty base URLs before storage', async () => {
    mocks.unsafe.mockResolvedValue('loopback address');

    await expect(POST(request(model('http://127.0.0.1/private')))).rejects.toMatchObject({
      code: 'PRO_MODEL_UNSAFE_ENDPOINT',
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
