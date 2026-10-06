/**
 * POST raw image bytes (PNG, JPEG or WebP, already resized by the browser,
 * at most 96 KB) with a matching `content-type`. Answers `{ id, avatar }`,
 * where `avatar` is the owner-only path a classmate may use.
 */
import { CLASSMATE_LIMITS } from '@/lib/study/classmates/contracts';
import { studyClassmatesRoute, studyJson } from '@/lib/server/study/route';
import { saveClassmateAvatar } from '@/lib/server/study/classmates/repository';
import { StudyError } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

export function POST(req: Request) {
  return studyClassmatesRoute(req, async (ownerId, db, headers) => {
    if (Number(req.headers.get('content-length') ?? 0) > CLASSMATE_LIMITS.avatarBytes) {
      throw new StudyError('STUDY_AVATAR_INVALID');
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) throw new StudyError('STUDY_AVATAR_INVALID');
    const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    return studyJson(await saveClassmateAvatar(db, ownerId, bytes, type), 201, headers);
  });
}
