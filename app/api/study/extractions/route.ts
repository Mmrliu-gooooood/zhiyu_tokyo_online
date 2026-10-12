/**
 * GET ?spaceId= — a space's exercise extractions, newest first (learning plan B08).
 * POST { spaceId, materialId, versionId?, pageFrom?, pageTo? } — extract the
 * questions of a parsed material version (a page range of it) into
 * candidates. Rule-based, no model call. The same request returns the same
 * extraction (200 instead of 201).
 */
import { listSpaceExtractions, startExtraction } from '@/lib/server/study/extraction/service';
import {
  invalidInput,
  readStudyBody,
  studyExtractionRoute,
  studyJson,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isContentId, isStudyId } from '@/lib/study/spaces/contracts';

export const runtime = 'nodejs';

function pageOf(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100_000
    ? value
    : undefined;
}

export function GET(req: Request) {
  return studyExtractionRoute(req, async (ownerId, db, headers) => {
    const spaceId = new URL(req.url).searchParams.get('spaceId');
    if (!isContentId(spaceId)) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const extractions = await listSpaceExtractions(db, ownerId, spaceId);
    return studyJson({ extractions }, 200, headers);
  });
}

export function POST(req: Request) {
  return studyExtractionRoute(req, async (ownerId, db, headers) => {
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (!isContentId(body.spaceId)) return invalidInput('spaceId', headers);
    if (!isStudyId(body.materialId)) return invalidInput('materialId', headers);
    const versionId = body.versionId ?? null;
    if (versionId !== null && !isStudyId(versionId)) return invalidInput('versionId', headers);
    const pageFrom = pageOf(body.pageFrom);
    const pageTo = pageOf(body.pageTo);
    if (pageFrom === undefined) return invalidInput('pageFrom', headers);
    if (pageTo === undefined) return invalidInput('pageTo', headers);
    const result = await startExtraction(db, ownerId, {
      spaceId: body.spaceId,
      materialId: body.materialId,
      versionId: versionId as string | null,
      pageFrom,
      pageTo,
    });
    return studyJson(result, result.created ? 201 : 200, headers);
  });
}
