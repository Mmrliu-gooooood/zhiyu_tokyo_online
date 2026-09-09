import type { GenerationSearchRef } from '@/lib/server/generation-jobs/contracts';
import type { GenerationSearchSnapshotContent } from '@/lib/server/generation-search-snapshots';
import { GenerationJobRequestError } from './job-client';

export async function syncGenerationSearchSnapshot(
  snapshot: GenerationSearchSnapshotContent,
  signal: AbortSignal,
): Promise<GenerationSearchRef> {
  const response = await fetch('/api/generate-classroom/search-snapshots', {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  const body = await response.json();
  if (!response.ok || !body?.ref) {
    throw new GenerationJobRequestError(
      response.status,
      body?.errorCode ?? body?.error ?? 'GENERATION_SEARCH_SNAPSHOT_UNAVAILABLE',
    );
  }
  return body.ref as GenerationSearchRef;
}
