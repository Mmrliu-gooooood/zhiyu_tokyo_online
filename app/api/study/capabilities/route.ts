/** Which study features this deployment serves (learning plan B01–B05). No identity needed. */
import {
  isStudyClassmatesEnabled,
  isStudyCompanionChatEnabled,
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
      companionChat: isStudyCompanionChatEnabled(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
