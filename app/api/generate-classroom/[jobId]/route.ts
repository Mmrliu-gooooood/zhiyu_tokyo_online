import { GenerationJobError } from '@/lib/server/generation-jobs/contracts';
import { generationResponse, withGenerationRequest } from '@/lib/server/generation-jobs/http';
import { generationRequestReadiness } from '@/lib/server/generation-jobs/runtime';
export const dynamic = 'force-dynamic';
export async function GET(req: Request, context: { params: Promise<{ jobId: string }> }) {
  return withGenerationRequest(req, async ({ ownerId, headers, repository }) => {
    const { jobId } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new GenerationJobError('JOB_NOT_FOUND', 404);
    const cursor = Number(new URL(req.url).searchParams.get('cursor') ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new GenerationJobError('INVALID_CURSOR', 400);
    const job = await repository.getJobDetail(ownerId, jobId, cursor);
    if (!job) throw new GenerationJobError('JOB_NOT_FOUND', 404);
    const readiness = await generationRequestReadiness();
    return generationResponse(
      {
        success: true,
        ...job,
        ...(['queued', 'running', 'retry_wait'].includes(job.status) && !readiness.worker
          ? { queueReason: 'service_unavailable' as const }
          : {}),
      },
      headers,
    );
  });
}
