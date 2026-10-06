/** Which study features this deployment serves (learning plan B01–B04). No identity needed. */
import {
  isStudyClassmatesEnabled,
  isStudyMaterialsEnabled,
  isStudyQaEnabled,
  isStudySpacesEnabled,
} from '@/lib/server/study/route';

export const runtime = 'nodejs';

export function GET() {
  return Response.json(
    {
      spaces: isStudySpacesEnabled(),
      materials: isStudyMaterialsEnabled(),
      qa: isStudyQaEnabled(),
      classmates: isStudyClassmatesEnabled(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
