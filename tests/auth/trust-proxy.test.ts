import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { trustProxyHeaders } from '@/lib/auth/trust-proxy';

const mocks = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
}));

vi.mock('@/lib/auth/api', () => ({
  requirePrincipalIfHosted: vi.fn(async () => null),
}));
vi.mock('@/lib/server/render-service', () => ({
  resolveRenderServiceUrl: () => ({ url: 'http://render.test' }),
}));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.proxyFetch }));

describe('trustProxyHeaders', () => {
  it.each(['1', 'true', 'TRUE', ' 1 ', ' True '])('accepts %j', (value) => {
    expect(trustProxyHeaders({ TRUST_PROXY_HEADERS: value })).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'yes', 'on', '2'])('rejects %j', (value) => {
    const env = value === undefined ? {} : { TRUST_PROXY_HEADERS: value };
    expect(trustProxyHeaders(env)).toBe(false);
  });
});

describe('export-video render route client identity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.proxyFetch.mockReset();
  });

  async function submittedIdentity(): Promise<string | undefined> {
    mocks.proxyFetch.mockResolvedValue(Response.json({ jobId: 'job-1' }, { status: 202 }));
    const { POST } = await import('@/app/api/export-video/render/route');
    const request = new NextRequest('http://localhost/api/export-video/render', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=x',
        'x-forwarded-for': '198.51.100.10, 10.0.0.1',
      },
      body: '--x--',
    });
    const response = await POST(request);
    expect(response.status).toBe(202);
    const init = mocks.proxyFetch.mock.calls[0]?.[1] as RequestInit;
    return (init.headers as Record<string, string>)['x-openmaic-client'];
  }

  it('keeps the shared direct identity when unset', async () => {
    vi.stubEnv('TRUST_PROXY_HEADERS', '');
    await expect(submittedIdentity()).resolves.toBe('direct');
  });

  it.each(['1', 'true'])('honors x-forwarded-for when set to %j', async (value) => {
    vi.stubEnv('TRUST_PROXY_HEADERS', value);
    await expect(submittedIdentity()).resolves.toBe('198.51.100.10');
  });
});
