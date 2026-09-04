import { describe, expect, it, vi } from 'vitest';

import { resolveOptionalWebSearch } from '@/app/generation-preview/optional-web-search';

describe('resolveOptionalWebSearch', () => {
  it('continues without research context when the search provider rejects the request', async () => {
    const fetchSearch = vi.fn().mockResolvedValue(
      Response.json(
        {
          error: 'Brave Search error (429): <!doctype html><html>rate limit challenge</html>',
        },
        { status: 500 },
      ),
    );

    const result = await resolveOptionalWebSearch(fetchSearch);

    expect(result).toEqual({
      researchContext: '',
      researchSources: [],
      warning: 'Web search unavailable (HTTP 500)',
    });
    expect(result.warning).not.toContain('<html>');
  });

  it('continues without research context when the search request cannot be completed', async () => {
    const fetchSearch = vi.fn().mockRejectedValue(new Error('socket unavailable'));

    await expect(resolveOptionalWebSearch(fetchSearch)).resolves.toEqual({
      researchContext: '',
      researchSources: [],
      warning: 'Web search unavailable',
    });
  });

  it('preserves cancellation instead of converting it into a search fallback', async () => {
    const abortError = new DOMException('cancelled', 'AbortError');
    const fetchSearch = vi.fn().mockRejectedValue(abortError);

    await expect(resolveOptionalWebSearch(fetchSearch)).rejects.toBe(abortError);
  });

  it('preserves error-shaped cancellation from non-DOM fetch adapters', async () => {
    const abortError = { name: 'AbortError', message: 'cancelled' };
    const fetchSearch = vi.fn().mockRejectedValue(abortError);

    await expect(resolveOptionalWebSearch(fetchSearch)).rejects.toBe(abortError);
  });

  it('continues without research context when a successful response is not valid JSON', async () => {
    const fetchSearch = vi
      .fn()
      .mockResolvedValue(new Response('<html>upstream proxy page</html>', { status: 200 }));

    await expect(resolveOptionalWebSearch(fetchSearch)).resolves.toEqual({
      researchContext: '',
      researchSources: [],
      warning: 'Web search returned an invalid response',
    });
  });

  it('continues without research context when a JSON response has no result object', async () => {
    const fetchSearch = vi.fn().mockResolvedValue(Response.json(null));

    await expect(resolveOptionalWebSearch(fetchSearch)).resolves.toEqual({
      researchContext: '',
      researchSources: [],
      warning: 'Web search returned an invalid response',
    });
  });

  it('keeps the existing title-and-url persistence projection for successful search results', async () => {
    const fetchSearch = vi.fn().mockResolvedValue(
      Response.json({
        context: 'Research context',
        sources: [
          {
            title: 'Primary source',
            url: 'https://example.com/source',
            content: 'Provider-only excerpt',
            score: 0.98,
          },
        ],
      }),
    );

    await expect(resolveOptionalWebSearch(fetchSearch)).resolves.toEqual({
      researchContext: 'Research context',
      researchSources: [
        {
          title: 'Primary source',
          url: 'https://example.com/source',
        },
      ],
    });
  });

  it('does not persist a successful JSON response with invalid result fields', async () => {
    const fetchSearch = vi.fn().mockResolvedValue(
      Response.json({
        context: 42,
        sources: [{ title: 'Invalid source', url: false }],
      }),
    );

    await expect(resolveOptionalWebSearch(fetchSearch)).resolves.toEqual({
      researchContext: '',
      researchSources: [],
      warning: 'Web search returned an invalid response',
    });
  });
});
