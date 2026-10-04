/**
 * Presentation rules for study spaces (learning plan B01). Pure and shared by
 * the study pages and their tests.
 *
 * Progress shown here is a viewing fact: where the learner stopped and how
 * far they have looked. "Reached the end" means the last page was viewed, not
 * that anything was mastered.
 */
import type {
  StudyCourseProgressView,
  StudySpaceCourse,
  StudySpaceSummary,
} from '@/lib/study/spaces/contracts';

export type CourseViewStatus = 'not-started' | 'in-progress' | 'reached-end';

export function courseViewStatus(progress: StudyCourseProgressView | null): CourseViewStatus {
  if (!progress) return 'not-started';
  return progress.reachedEnd ? 'reached-end' : 'in-progress';
}

/** Share of pages viewed at least once, 0–100. */
export function viewedPercent(
  progress: StudyCourseProgressView | null,
  sceneCount: number,
): number {
  if (!progress || sceneCount <= 0) return 0;
  if (progress.reachedEnd) return 100;
  return Math.round(
    ((Math.min(progress.furthestSceneIndex, sceneCount - 1) + 1) / sceneCount) * 100,
  );
}

/** 1-based page where the learner stopped, or null when that page no longer exists. */
export function stoppedAtPage(progress: StudyCourseProgressView): number | null {
  return progress.sceneIndex === null ? null : progress.sceneIndex + 1;
}

/**
 * The course "continue" should open in a space: the most recently studied
 * unfinished course; else the most recently studied one; else the oldest
 * course not started yet.
 */
export function pickContinueCourse(courses: StudySpaceCourse[]): StudySpaceCourse | null {
  const studied = courses
    .filter((course) => course.progress)
    .sort((a, b) => b.progress!.updatedAt.localeCompare(a.progress!.updatedAt));
  const unfinished = studied.find((course) => !course.progress!.reachedEnd);
  if (unfinished) return unfinished;
  const fresh = courses
    .filter((course) => !course.progress)
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  return fresh[0] ?? studied[0] ?? null;
}

/** The space and course to show in the global "continue" card. */
export function pickGlobalContinue(
  spaces: StudySpaceSummary[],
): { space: StudySpaceSummary; progress: StudyCourseProgressView } | null {
  let best: { space: StudySpaceSummary; progress: StudyCourseProgressView } | null = null;
  for (const space of spaces) {
    if (space.status !== 'active' || !space.lastStudied) continue;
    if (!best || space.lastStudied.updatedAt > best.progress.updatedAt) {
      best = { space, progress: space.lastStudied };
    }
  }
  return best;
}

export function resumeHref(stageId: string): string {
  return `/classroom/${encodeURIComponent(stageId)}?resume=study`;
}
