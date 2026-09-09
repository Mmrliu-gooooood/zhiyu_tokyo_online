import {
  generationResponse,
  readGenerationJson,
  withGenerationRequest,
} from '@/lib/server/generation-jobs/http';
import { normalizeModelConnectionContext } from '@/lib/server/agent-runtime/model-connections';
import {
  generationModelSnapshotContent,
  GenerationModelSnapshotError,
  syncGenerationModelSnapshot,
} from '@/lib/server/generation-model-snapshots';
import { GenerationJobError } from '@/lib/server/generation-jobs/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return withGenerationRequest(
    req,
    async ({ ownerId, headers }) => {
      try {
        const normalized = await normalizeModelConnectionContext(await readGenerationJson(req));
        const { baseUrl, ...modelContext } = normalized;
        const endpoint = baseUrl?.trim();
        const ref = await syncGenerationModelSnapshot(
          ownerId,
          generationModelSnapshotContent({
            ...modelContext,
            ...(endpoint ? { baseUrl: endpoint } : {}),
          }),
        );
        return generationResponse({ success: true, ref }, headers, 201);
      } catch (error) {
        if (error instanceof GenerationModelSnapshotError) {
          throw new GenerationJobError(error.code, error.status);
        }
        throw error;
      }
    },
    { createSession: true, submitting: true },
  );
}
