import { getLoginService } from '@/lib/model-gateway/auth/service';
import { modelAuthRoute } from '@/lib/server/model-auth-route';

export const runtime = 'nodejs';

/** Start (or restart) a subscription sign-in for one provider. */
export function POST(req: Request, context: { params: Promise<{ providerId: string }> }) {
  return modelAuthRoute(req, async (ownerId, headers) => {
    const { providerId } = await context.params;
    const session = await getLoginService().start(ownerId, providerId);
    return Response.json({ session }, { status: 201, headers });
  });
}
