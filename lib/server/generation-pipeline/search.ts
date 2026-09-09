import type { GenerationInput } from '@/lib/server/generation-jobs/contracts';
import type { GenerationSearchSnapshotContent } from '@/lib/server/generation-search-snapshots';
import { isServerConfiguredProvider, isServerProviderDisabled } from '@/lib/server/provider-config';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import type { WebSearchProviderId } from '@/lib/web-search/types';

/** Resolve only in server memory; the job and its checkpoints retain an opaque reference. */
export function resolveGenerationSearchConfig(
  input: GenerationInput,
  snapshot?: GenerationSearchSnapshotContent,
) {
  const selected = input.webSearch;
  if (input.searchConfigRef) {
    if (
      !snapshot ||
      !selected ||
      snapshot.providerId !== selected.providerId ||
      snapshot.modelId !== selected.modelId ||
      isServerProviderDisabled('webSearch', selected.providerId)
    )
      throw new Error('WEB_SEARCH_NOT_CONFIGURED');
  }
  const managed = selected && isServerConfiguredProvider('webSearch', selected.providerId);
  const config = resolveClassroomWebSearchConfig({
    webSearchProviderId: selected?.providerId as WebSearchProviderId | undefined,
    webSearchModelId: selected?.modelId,
    ...(input.searchConfigRef && snapshot
      ? {
          webSearchApiKey: managed ? undefined : snapshot.apiKey,
          webSearchBaseUrl: managed ? undefined : snapshot.baseUrl,
          baiduSubSources: snapshot.baiduSubSources,
        }
      : {}),
  });
  if (!config || (selected?.providerId && config.providerId !== selected.providerId)) {
    throw new Error('WEB_SEARCH_NOT_CONFIGURED');
  }
  return config;
}
