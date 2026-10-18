/** Which study features this deployment serves (learning plan B01–B11). No identity needed. */
import {
  isStudyClassmatesEnabled,
  isStudyCompanionChatEnabled,
  isStudyExamsEnabled,
  isStudyExtractionEnabled,
  isStudyGradingEnabled,
  isStudyMaterialsEnabled,
  isStudyMemoryEnabled,
  isStudyPracticeEnabled,
  isStudyQaEnabled,
  isStudySpacesEnabled,
  isStudyWrongbookEnabled,
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
      memory: isStudyMemoryEnabled(),
      exams: isStudyExamsEnabled(),
      extraction: isStudyExtractionEnabled(),
      grading: isStudyGradingEnabled(),
      wrongbook: isStudyWrongbookEnabled(),
      practice: isStudyPracticeEnabled(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
