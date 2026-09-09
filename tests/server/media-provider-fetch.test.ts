import { afterEach, describe, expect, it, vi } from 'vitest';
import { withMediaProviderFetch } from '@/lib/server/media-provider-fetch';

describe('restricted custom media provider transport', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('rejects private endpoints before invoking the provider', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const callback = vi.fn();
    await expect(withMediaProviderFetch('http://127.0.0.1/v1', callback)).rejects.toThrow(
      /Local\/private network/,
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects attempts to leave the configured provider origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      withMediaProviderFetch('https://8.8.8.8/v1', (fetcher) =>
        fetcher('https://1.1.1.1/v1/images'),
      ),
    ).rejects.toThrow(/escaped the configured origin/);
  });
});
