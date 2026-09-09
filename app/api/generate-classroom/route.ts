import {
  commandKey,
  generationResponse,
  parseCommand,
  readGenerationJson,
  withGenerationRequest,
} from '@/lib/server/generation-jobs/http';
import { parseGenerationInput } from '@/lib/server/generation-jobs/contracts';
import { validateBackgroundProviders } from '@/lib/server/generation-jobs/preflight';
import {
  generationProviderConfigVersion,
  generationRequestHash,
} from '@/lib/server/generation-jobs/config-snapshot';
import { getGenerationPool } from '@/lib/server/generation-jobs/runtime';
import { GenerationJobError } from '@/lib/server/generation-jobs/contracts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function POST(req: Request) {
  return withGenerationRequest(
    req,
    async ({ ownerId, headers, repository }) => {
      const key = parseCommand(commandKey, req.headers.get('Idempotency-Key'));
      const input = parseGenerationInput(await readGenerationJson(req));
      const found = await getGenerationPool().query(
        'SELECT id,request_hash FROM generation_jobs WHERE owner_id=$1 AND idempotency_key=$2',
        [ownerId, key],
      );
      if (found.rows[0]) {
        if (found.rows[0].request_hash !== generationRequestHash(input))
          throw new GenerationJobError('IDEMPOTENCY_CONFLICT', 409);
        const previous = await repository.getJob(ownerId, found.rows[0].id);
        if (!previous) throw new GenerationJobError('JOB_NOT_FOUND', 404);
        headers.set('Location', previous.pollUrl);
        return generationResponse({ success: true, ...previous }, headers, 202);
      }
      await validateBackgroundProviders(input, {
        ownerId,
        queryable: getGenerationPool(),
      });
      input.model = { ...input.model, configVersion: generationProviderConfigVersion() };
      const job = await repository.createJob(ownerId, key, input);
      headers.set('Location', job.pollUrl);
      return generationResponse({ success: true, ...job }, headers, 202);
    },
    { createSession: true, submitting: true },
  );
}
export async function GET(req: Request) {
  return withGenerationRequest(
    req,
    async ({ ownerId, headers, repository }) => {
      const params = new URL(req.url).searchParams;
      const result = await repository.listJobs(ownerId, {
        active: params.get('active') === '1',
        limit: 30,
        cursor: params.get('cursor') ?? undefined,
      });
      return generationResponse({ success: true, ...result }, headers);
    },
    { createSession: true },
  );
}
