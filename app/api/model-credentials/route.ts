import { webCredentialVault } from '@/lib/model-gateway/auth/service';
import { modelAuthRoute } from '@/lib/server/model-auth-route';

export const runtime = 'nodejs';

/** The owner's signed-in model accounts (metadata only, never a token). */
export function GET(req: Request) {
  return modelAuthRoute(req, async (ownerId, headers) =>
    Response.json({ credentials: await webCredentialVault(ownerId).list() }, { headers }),
  );
}
