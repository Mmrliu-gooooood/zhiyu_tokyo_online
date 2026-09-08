import { Agent, fetch as undiciFetch } from 'undici';
import { createPinnedFetchAgent } from './pinned-fetch-agent';
import { validateUrlForSSRF } from './ssrf-guard';

function localNetworksAllowed(): boolean {
  return process.env.ALLOW_LOCAL_NETWORKS === 'true' || process.env.ALLOW_LOCAL_NETWORKS === '1';
}

function targetUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string' || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

/**
 * Run calls to one user-configured provider through a connection-time DNS
 * checked transport. Requests cannot escape the configured origin and
 * redirects remain disabled so bearer credentials never cross origins.
 */
export async function withMediaProviderFetch<T>(
  baseUrl: string,
  callback: (fetcher: typeof fetch) => Promise<T>,
): Promise<T> {
  if (process.env.NODE_ENV === 'test') return callback(fetch);
  const base = new URL(baseUrl);
  const unsafe = await validateUrlForSSRF(base.href);
  if (unsafe) throw new Error(unsafe);

  const dispatcher = localNetworksAllowed()
    ? new Agent({ headersTimeout: 10_000, bodyTimeout: 30_000, connect: { timeout: 5_000 } })
    : createPinnedFetchAgent();

  const restrictedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = targetUrl(input);
    if (target.origin !== base.origin) {
      throw new Error('Custom media provider request escaped the configured origin');
    }
    const hopUnsafe = await validateUrlForSSRF(target.href);
    if (hopUnsafe) throw new Error(hopUnsafe);
    return (await undiciFetch(target, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      redirect: 'manual',
      dispatcher,
    })) as unknown as Response;
  }) as typeof fetch;

  try {
    return await callback(restrictedFetch);
  } finally {
    await dispatcher.close();
  }
}
