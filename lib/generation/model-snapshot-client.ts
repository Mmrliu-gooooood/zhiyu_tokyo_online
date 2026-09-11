import type { GenerationModelRef } from '@/lib/server/generation-jobs/contracts';
import type { ProModelContext } from '@/types/pro-model';
import { GenerationJobRequestError } from './job-client';

export async function syncGenerationModelSnapshot(
  context: ProModelContext,
  signal?: AbortSignal,
): Promise<GenerationModelRef> {
  const payload =
    context.source === 'platform'
      ? {
          source: context.source,
          defaultId: context.defaultId,
          ...(context.revision ? { revision: context.revision } : {}),
          ...(context.thinkingConfig ? { thinkingConfig: context.thinkingConfig } : {}),
        }
      : context;
  const response = await fetch('/api/generate-classroom/model-snapshots', {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
