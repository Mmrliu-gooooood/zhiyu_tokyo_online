import type { GenerationModelRef } from '@/lib/server/generation-jobs/contracts';
import { modelConfigSelection } from '@/lib/utils/model-selection';
import type { ModelConfigInput } from '@/types/pro-model';
import { GenerationJobRequestError } from './job-client';

export async function syncGenerationModelSnapshot(
  context: ModelConfigInput,
  signal?: AbortSignal,
): Promise<GenerationModelRef> {
  return (await prepareGenerationModelSnapshot(context, signal)).ref;
}

/** Keep the accepted model and its encrypted reference together when freezing a new job. */
export async function prepareGenerationModelSnapshot(
  context: ModelConfigInput,
  signal?: AbortSignal,
): Promise<{ ref: GenerationModelRef; context: ModelConfigInput }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const selection = modelConfigSelection(context);
    if (!selection) throw new GenerationJobRequestError(400, 'PRO_MODEL_INVALID_CONFIG');
    const response = await fetch('/api/generate-classroom/model-snapshots', {
      method: 'POST',
      credentials: 'same-origin',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection }),
    });
    const body = await response.json();
    const code = body?.errorCode ?? body?.error ?? 'GENERATION_MODEL_SNAPSHOT_UNAVAILABLE';
    if (
      response.status === 409 &&
      code === 'PRO_MODEL_CONNECTION_STALE' &&
      context.source === 'platform' &&
      attempt === 0
    ) {
      const { refreshPlatformModelConfig } = await import('@/lib/utils/model-config');
      const refreshed = await refreshPlatformModelConfig(context, signal);
      if (refreshed) {
        context = refreshed;
        continue;
      }
    }
    if (!response.ok || !body?.ref) {
      throw new GenerationJobRequestError(response.status, code);
    }
    return { ref: body.ref as GenerationModelRef, context };
  }
  throw new GenerationJobRequestError(409, 'PRO_MODEL_CONNECTION_STALE');
}
