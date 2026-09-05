import { confirmCommand, generationResponse, parseCommand, readGenerationJson, withGenerationRequest } from '@/lib/server/generation-jobs/http';
export async function POST(req: Request, context: { params: Promise<{ jobId: string }> }) {
  return withGenerationRequest(req, async ({ ownerId, headers, repository }) => {
    const { jobId } = await context.params;
    const command = parseCommand(confirmCommand, await readGenerationJson(req));
    const job = await repository.confirm(ownerId, jobId, command);
    return generationResponse({ success: true, ...job }, headers, 202);
  });
}
