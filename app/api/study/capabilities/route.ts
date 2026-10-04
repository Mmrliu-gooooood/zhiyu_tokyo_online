/** Which study features this deployment serves (learning plan B01). No identity needed. */
import { isStudySpacesEnabled } from '@/lib/server/study/route';

export const runtime = 'nodejs';

export function GET() {
  return Response.json(
    { spaces: isStudySpacesEnabled() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
