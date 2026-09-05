import { reviewCommand, generationResponse, parseCommand, readGenerationJson, withGenerationRequest } from '@/lib/server/generation-jobs/http';
import { validatePlan } from '@/lib/server/generation-jobs/contracts';
export async function PATCH(req: Request, context: { params: Promise<{ jobId: string }> }) {
  return withGenerationRequest(req, async ({ ownerId, headers, repository }) => {
    const { jobId } = await context.params;
    const command = parseCommand(reviewCommand, await readGenerationJson(req));
    const job = await repository.reviewOutline(ownerId, jobId, { ...command, outlines: command.outlines ? validatePlan(command.outlines) : undefined });
    return generationResponse({ success: true, ...job }, headers, 200);
  });
}
