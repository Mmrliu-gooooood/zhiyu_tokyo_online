import type { GenerationModelRef } from '@/lib/server/generation-jobs/contracts';
import type { ProModelContext } from '@/types/pro-model';
import { GenerationJobRequestError } from './job-client';

export async function syncGenerationModelSnapshot(
  context: ProModelContext,
  signal?: AbortSignal,
): Promise<GenerationModelRef> {
  const response = await fetch('/api/generate-classroom/model-snapshots', {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(context),
  });
  const body = await response.json();
  if (!response.ok || !body?.ref) {
    throw new GenerationJobRequestError(
      response.status,
      body?.errorCode ?? body?.error ?? 'GENERATION_MODEL_SNAPSHOT_UNAVAILABLE',
    );
  }
  return body.ref as GenerationModelRef;
}
