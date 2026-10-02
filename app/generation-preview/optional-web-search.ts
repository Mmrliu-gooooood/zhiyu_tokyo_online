export interface GenerationResearchSource {
  title: string;
  url: string;
}

export interface OptionalWebSearchResult {
  researchContext: string;
  researchSources: GenerationResearchSource[];
  warning?: string;
}

export async function resolveOptionalWebSearch(
  fetchSearch: () => Promise<Response>,
): Promise<OptionalWebSearchResult> {
  let response: Response;
  try {
    response = await fetchSearch();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      researchContext: '',
      researchSources: [],
      warning: 'Web search unavailable',
    };
  }

  if (!response.ok) {
    return {
      researchContext: '',
      researchSources: [],
      warning: `Web search unavailable (HTTP ${response.status})`,
    };
  }

  let rawData: unknown;
  try {
    rawData = await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      researchContext: '',
      researchSources: [],
      warning: 'Web search returned an invalid response',
    };
  }

  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    return {
      researchContext: '',
      researchSources: [],
      warning: 'Web search returned an invalid response',
    };
  }

  const data = rawData as Record<string, unknown>;
  const context = data.context;
  const sources = data.sources;
  const validSources =
    sources === undefined ||
    (Array.isArray(sources) &&
      sources.every(
        (source) =>
          !!source &&
          typeof source === 'object' &&
          !Array.isArray(source) &&
          typeof (source as Record<string, unknown>).title === 'string' &&
          typeof (source as Record<string, unknown>).url === 'string',
      ));

  if ((context !== undefined && typeof context !== 'string') || !validSources) {
    return {
      researchContext: '',
      researchSources: [],
      warning: 'Web search returned an invalid response',
    };
  }

  const normalizedSources = Array.isArray(sources) ? sources : [];

  return {
    researchContext: context || '',
    researchSources: normalizedSources.map((source) => ({
      title: (source as Record<string, string>).title,
      url: (source as Record<string, string>).url,
    })),
  };
}
import { isAbortError } from '@openmaic/generation/generation-retry';
