import { hostedAuthGate } from '@/lib/auth/api';
import { apiSuccess } from '@/lib/server/api-response';
import { checkRenderServiceHealth } from '@/lib/server/render-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const denied = await hostedAuthGate(request);
  if (denied) return denied;
  const enabled = await checkRenderServiceHealth();
  return apiSuccess({ enabled });
}
