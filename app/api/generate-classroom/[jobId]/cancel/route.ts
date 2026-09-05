import { cancelCommand, generationResponse, parseCommand, readGenerationJson, withGenerationRequest } from '@/lib/server/generation-jobs/http';
export async function POST(req: Request, context: { params: Promise<{ jobId: string }> }) {
  return withGenerationRequest(req, async ({ ownerId, headers, repository }) => {
    const { jobId } = await context.params;
    const command = parseCommand(cancelCommand, await readGenerationJson(req));
    const job = await repository.cancel(ownerId, jobId, command);
    return generationResponse({ success: true, ...job }, headers, 200);
  });
}
