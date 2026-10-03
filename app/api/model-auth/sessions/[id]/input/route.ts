import { getLoginService } from '@/lib/model-gateway/auth/service';
import { LoginSessionError } from '@/lib/model-gateway/auth/login-sessions';
import { modelAuthRoute, readSmallJsonObject } from '@/lib/server/model-auth-route';

export const runtime = 'nodejs';

/** The user's answer to the current sign-in prompt (pasted code or redirect URL). */
export function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return modelAuthRoute(req, async (ownerId, headers) => {
    const { id } = await context.params;
    const body = await readSmallJsonObject(req);
    if (!body) throw new LoginSessionError('MODEL_AUTH_INPUT_INVALID');
    const session = await getLoginService().submitInput(ownerId, id, body.value);
    return Response.json({ session }, { headers });
  });
}
