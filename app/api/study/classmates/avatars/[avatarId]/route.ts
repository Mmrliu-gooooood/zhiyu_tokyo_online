/** GET: an uploaded classmate avatar, for its owner only. Avatars never change, so browsers may keep them. */
import { isClassmateAvatarId } from '@/lib/study/classmates/contracts';
import { studyClassmatesRoute } from '@/lib/server/study/route';
import { readClassmateAvatar } from '@/lib/server/study/classmates/repository';
import { StudyError } from '@/lib/server/study/spaces/repository';

export const runtime = 'nodejs';

type Context = { params: Promise<{ avatarId: string }> };

export function GET(req: Request, context: Context) {
  return studyClassmatesRoute(req, async (ownerId, db, headers) => {
    const { avatarId } = await context.params;
    if (!isClassmateAvatarId(avatarId)) throw new StudyError('STUDY_AVATAR_NOT_FOUND');
    const avatar = await readClassmateAvatar(db, ownerId, avatarId);
    headers.set('Content-Type', avatar.contentType);
    headers.set('Cache-Control', 'private, max-age=31536000, immutable');
    headers.set('ETag', `"${avatar.sha256}"`);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    return new Response(new Uint8Array(avatar.bytes), { status: 200, headers });
  });
}
