import {
  generationResponse,
  readGenerationJson,
  withGenerationRequest,
} from '@/lib/server/generation-jobs/http';
import {
  normalizeModelConnectionContext,
  ProModelConnectionError,
} from '@/lib/server/agent-runtime/model-connections';
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
        const ref = await syncGenerationModelSnapshot(
          ownerId,
          generationModelSnapshotContent(normalized),
        );
        return generationResponse({ success: true, ref }, headers, 201);
      } catch (error) {
        if (
          error instanceof GenerationModelSnapshotError ||
          error instanceof ProModelConnectionError
        ) {
          throw new GenerationJobError(error.code, error.status);
        }
        throw error;
      }
    },
    { createSession: true, submitting: true },
  );
}
