/**
 * GET: an uploaded classmate avatar, for its owner only. Avatars never
 * change, but every use is re-authorised: the browser revalidates with the
 * ETag (304 when unchanged), so a signed-out or different account on the
 * same browser never gets a cached copy.
 */
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
    const etag = `"${avatar.sha256}"`;
    headers.set('Cache-Control', 'private, no-cache');
    headers.set('ETag', etag);
    headers.set('X-Content-Type-Options', 'nosniff');
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers });
    }
    headers.set('Content-Type', avatar.contentType);
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    return new Response(new Uint8Array(avatar.bytes), { status: 200, headers });
  });
}
