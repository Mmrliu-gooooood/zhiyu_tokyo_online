import { cookies } from 'next/headers';
import { apiSuccess } from '@/lib/server/api-response';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { verifyAccessToken } from '@/lib/server/access-token';

export async function GET() {
  const accessCode = process.env.ACCESS_CODE;
  const enabled = isHostedAuthEnabled() ? false : !!accessCode;

  let authenticated = false;
  if (enabled && accessCode) {
    const cookieStore = await cookies();
    const token = cookieStore.get('openmaic_access')?.value;
    authenticated = !!token && verifyAccessToken(token, accessCode);
  }

  return apiSuccess({ enabled, authenticated });
}
