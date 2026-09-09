import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sync: vi.fn(), managed: vi.fn() }));
vi.mock('@/lib/server/provider-config', () => ({ isServerConfiguredProvider: mocks.managed }));
vi.mock('@/lib/server/generation-search-snapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/generation-search-snapshots')>()),
  syncGenerationSearchSnapshot: mocks.sync,
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
import { POST } from '@/app/api/generate-classroom/search-snapshots/route';

const ref = { id: '123e4567-e89b-42d3-a456-426614174099', revision: 1 };
function request(content: unknown) {
  return new Request('http://localhost/api/generate-classroom/search-snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(content),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.managed.mockReturnValue(false);
  mocks.sync.mockResolvedValue(ref);
});

describe('normal generation search snapshot route', () => {
  it('freezes client search settings under the signed owner and returns only an opaque reference', async () => {
    const content = {
      version: 1,
      providerId: 'tavily',
      apiKey: 'client-key',
      baseUrl: 'https://api.tavily.com/',
    };
    const response = await POST(request(content));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, ref });
    expect(mocks.sync).toHaveBeenCalledWith('signed-owner', {
      ...content,
      baseUrl: 'https://api.tavily.com',
    });
  });

  it('ignores stale client key and private URL for an operator-managed provider', async () => {
    mocks.managed.mockReturnValue(true);
    await POST(
      request({
        version: 1,
        providerId: 'tavily',
        apiKey: 'stale',
        baseUrl: 'http://127.0.0.1/private',
      }),
    );
    expect(mocks.sync).toHaveBeenCalledWith('signed-owner', {
      version: 1,
      providerId: 'tavily',
      apiKey: undefined,
      baseUrl: undefined,
    });
  });

  it('keeps SearXNG URLs operator-managed', async () => {
    await POST(request({ version: 1, providerId: 'searxng', baseUrl: 'http://127.0.0.1/private' }));
    expect(mocks.sync).toHaveBeenCalledWith('signed-owner', {
      version: 1,
      providerId: 'searxng',
      apiKey: undefined,
      baseUrl: undefined,
    });
  });

  it.each([
    'http://127.0.0.1/private',
    'https://api.tavily.com.evil.test',
    'https://user:pass@api.tavily.com',
  ])('rejects unsupported client URL %s before storage', async (baseUrl) => {
    await expect(
      POST(request({ version: 1, providerId: 'tavily', apiKey: 'client-key', baseUrl })),
    ).rejects.toMatchObject({ code: 'GENERATION_SEARCH_BASE_URL_UNSUPPORTED', httpStatus: 400 });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('rejects unrecognized providers and client-supplied ownership', async () => {
    await expect(
      POST(request({ version: 1, providerId: 'unknown', ownerId: 'foreign' })),
    ).rejects.toMatchObject({ code: 'GENERATION_SEARCH_INVALID' });
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
