import { describe, expect, it } from 'vitest';
import { describeWebSearchFailure, WebSearchHttpError } from '@/lib/web-search/failure';

describe('safe web search failure diagnostics', () => {
  it('identifies keyless Brave throttling without logging upstream content', () => {
    const result = describeWebSearchFailure(
      new WebSearchHttpError('secret query and token in upstream message', 429, 'public_html'),
    );
    expect(result).toEqual({
      reason: 'rate_limited',
      status: 429,
      mode: 'public_html',
      action: 'Configure a valid search API key in Web Search settings',
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|query|token/);
  });

  it.each([
    [401, 'authentication_failed'],
    [403, 'access_denied'],
    [429, 'rate_limited'],
    [503, 'upstream_http_error'],
  ])('classifies API status %i without claiming the key is absent', (status, reason) => {
    expect(
      describeWebSearchFailure(new WebSearchHttpError('upstream secret', status, 'api')),
    ).toEqual({
      reason,
      status,
      mode: 'api',
    });
  });

  it.each([
    ['ENOTFOUND', 'dns_failure'],
    ['EAI_AGAIN', 'dns_failure'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['ECONNREFUSED', 'connection_failure'],
  ])('classifies nested transport code %s without its message', (code, reason) => {
    expect(
      describeWebSearchFailure(new Error('fetch secret', { cause: { code, message: 'token' } })),
    ).toEqual({ reason });
  });

  it('does not copy untrusted fields from unrecognized errors', () => {
    expect(
      describeWebSearchFailure({ status: 'token', mode: 'secret', message: 'private' }),
    ).toEqual({
      reason: 'provider_error',
    });
  });
});
