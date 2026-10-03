import { getLoginService } from '@/lib/model-gateway/auth/service';
import { modelAuthRoute } from '@/lib/server/model-auth-route';

export const runtime = 'nodejs';

/** Sign-in progress: status and the non-secret challenge to show. */
export function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return modelAuthRoute(req, async (ownerId, headers) => {
    const { id } = await context.params;
    return Response.json({ session: await getLoginService().get(ownerId, id) }, { headers });
  });
}

/** Cancel a sign-in in progress. */
export function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return modelAuthRoute(req, async (ownerId, headers) => {
    const { id } = await context.params;
    return Response.json({ session: await getLoginService().cancel(ownerId, id) }, { headers });
  });
}
