import { webCredentialVault } from '@/lib/model-gateway/auth/service';
import { modelAuthRoute } from '@/lib/server/model-auth-route';

export const runtime = 'nodejs';

/** Disconnect a signed-in model account; its secret is deleted. */
export function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return modelAuthRoute(req, async (ownerId, headers) => {
    const { id } = await context.params;
    const revoked = await webCredentialVault(ownerId).revoke(id);
    if (!revoked) {
      return Response.json({ error: 'MODEL_CREDENTIAL_NOT_FOUND' }, { status: 404, headers });
    }
    return Response.json({ revoked: true }, { headers });
  });
}
