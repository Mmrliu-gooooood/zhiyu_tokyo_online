/** Which study features this deployment serves (learning plan B01/B02). No identity needed. */
import { isStudyMaterialsEnabled, isStudySpacesEnabled } from '@/lib/server/study/route';

export const runtime = 'nodejs';

export function GET() {
  return Response.json(
    { spaces: isStudySpacesEnabled(), materials: isStudyMaterialsEnabled() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
