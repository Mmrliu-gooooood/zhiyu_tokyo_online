import { afterEach, describe, expect, it, vi } from 'vitest';

describe('authentication security boundaries', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not trust caller-supplied forwarding headers by default', async () => {
    const { clientRateKey } = await import('@/lib/auth/rate-limit');
    const request = new Request('http://localhost/api/auth/resend', {
      headers: { 'x-forwarded-for': '198.51.100.10', 'x-real-ip': '198.51.100.11' },
    });
    expect(clientRateKey(request, 'resend')).toBe('resend:untrusted-client');

    vi.stubEnv('TRUST_PROXY_HEADERS', '1');
    expect(clientRateKey(request, 'resend')).toBe('resend:198.51.100.10');

    vi.stubEnv('TRUST_PROXY_HEADERS', 'true');
    expect(clientRateKey(request, 'resend')).toBe('resend:198.51.100.10');
  });

  it('rejects render job ids that could escape the owner registry directory', async () => {
    const { recordRenderJobOwner, readRenderJobOwner } = await import(
      '@/lib/server/render-job-owners'
    );
    await expect(recordRenderJobOwner('../../package', 'user:test')).rejects.toThrow(
      'INVALID_RENDER_JOB_ID',
    );
    await expect(readRenderJobOwner('../../package')).resolves.toBeUndefined();
  });
});
