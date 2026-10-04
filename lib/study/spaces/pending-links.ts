'use client';

/**
 * Courses generated from a study space (learning plan B01). The course id is
 * known when generation hands over to the classroom, but its document may
 * reach the server a moment later, so the link is queued per account in
 * localStorage and retried (on hand-over and on every classroom open) until
 * the server accepts it. Linking is idempotent server-side, so retries,
 * reloads and regenerated jobs never add a course twice.
 */
import { peekAccountUserId } from '@/lib/auth/account-environment';
import { StudyApiError, fetchStudyCapability, studyApi } from '@/lib/study/spaces/client';
import { isContentId, isStudyId } from '@/lib/study/spaces/contracts';

interface PendingLink {
  spaceId: string;
  stageId: string;
  createdAt: number;
}

/** A course document that has not reached the server yet is retried for this long. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 20;

function storageKey(): string | null {
  const userId = peekAccountUserId();
  return userId ? `zhiyu:study:pending-course-links:${userId}` : null;
}

function read(key: string): PendingLink[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is PendingLink =>
        isStudyId(item?.spaceId) && isContentId(item?.stageId) && Number.isFinite(item?.createdAt),
    );
  } catch {
    return [];
  }
}

function write(key: string, links: PendingLink[]): void {
  try {
    if (links.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(links.slice(-MAX_PENDING)));
  } catch {
    // Storage full or blocked: the link can still be added by hand from the space.
  }
}

export function rememberPendingStudyLink(spaceId: string | undefined, stageId: string): void {
  if (!spaceId || !isStudyId(spaceId) || !isContentId(stageId)) return;
  const key = storageKey();
  if (!key) return;
  const links = read(key).filter((link) => !(link.spaceId === spaceId && link.stageId === stageId));
  links.push({ spaceId, stageId, createdAt: Date.now() });
  write(key, links);
}

let flushing: Promise<void> | null = null;

/** Try every queued link (or only those for `stageId`). Never throws. */
export function flushPendingStudyLinks(stageId?: string): Promise<void> {
  flushing = (flushing ?? Promise.resolve()).then(() => flushOnce(stageId)).catch(() => {});
  return flushing;
}

async function flushOnce(stageId?: string): Promise<void> {
  const key = storageKey();
  if (!key) return;
  const queued = read(key);
  const due = queued.filter((link) => !stageId || link.stageId === stageId);
  if (due.length === 0 || !(await fetchStudyCapability())) return;
  const settled = new Set<PendingLink>();
  for (const link of due) {
    try {
      await studyApi.linkCourse(link.spaceId, link.stageId, 'generation');
      settled.add(link);
    } catch (error) {
      if (!(error instanceof StudyApiError) || error.status >= 500) continue;
      // Not stored yet: keep retrying for a while. Anything else is final.
      const notYet = error.code === 'STUDY_COURSE_NOT_FOUND';
      if (!notYet || Date.now() - link.createdAt > PENDING_TTL_MS) settled.add(link);
    }
  }
  // Re-read: another tab may have queued links meanwhile.
  write(
    key,
    read(key).filter(
      (link) =>
        ![...settled].some(
          (done) => done.spaceId === link.spaceId && done.stageId === link.stageId,
        ),
    ),
  );
}

const handedOver = new Set<string>();

/** Generation hand-over: queue the link, then try it once right away (once per page session). */
export function linkGeneratedCourseToStudySpace(
  spaceId: string | undefined,
  stageId: string,
): void {
  if (!spaceId || handedOver.has(`${spaceId}\n${stageId}`)) return;
  handedOver.add(`${spaceId}\n${stageId}`);
  rememberPendingStudyLink(spaceId, stageId);
  void flushPendingStudyLinks(stageId);
}
