import { getLoginService } from '@/lib/model-gateway/auth/service';
import { modelAuthRoute } from '@/lib/server/model-auth-route';

export const runtime = 'nodejs';

/** The provider's sign-in still in progress (or null), so a reloaded page can resume it. */
export function GET(req: Request, context: { params: Promise<{ providerId: string }> }) {
  return modelAuthRoute(req, async (ownerId, headers) => {
    const { providerId } = await context.params;
    const session = await getLoginService().current(ownerId, providerId);
    return Response.json({ session }, { headers });
  });
}
