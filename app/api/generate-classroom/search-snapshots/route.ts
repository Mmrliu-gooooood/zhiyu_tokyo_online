import {
  generationResponse,
  readGenerationJson,
  withGenerationRequest,
} from '@/lib/server/generation-jobs/http';

import {
  generationSearchSnapshotContent,
  GenerationSearchSnapshotError,
  syncGenerationSearchSnapshot,
} from '@/lib/server/generation-search-snapshots';
import { GenerationJobError } from '@/lib/server/generation-jobs/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return withGenerationRequest(
    req,
    async ({ ownerId, headers }) => {
      try {
        const normalized = await readGenerationJson(req);
        const ref = await syncGenerationSearchSnapshot(
          ownerId,
          generationSearchSnapshotContent(normalized),
        );
        return generationResponse({ success: true, ref }, headers, 201);
      } catch (error) {
        if (error instanceof GenerationSearchSnapshotError) {
          throw new GenerationJobError(error.code, error.status);
        }
        throw error;
      }
    },
    { createSession: true, submitting: true },
  );
}
