'use client';

/**
 * Cross-device resume (learning plan B01): reconcile the server position of a
 * course with this device's saved position.
 *
 * The classroom already opens at the device's saved scene and restores the
 * saved action within it, validating both against the loaded course. Resume
 * therefore only has to decide which position is newer and, when it is the
 * server's, write it into the device stores before the classroom loads. The
 * existing load path then applies it with its own validation (a vanished
 * scene falls back to the course start; an action that no longer exists falls
 * back to the scene start).
 */
import { peekAccountUserId } from '@/lib/auth/account-environment';
import { loadCurrentScene, saveCurrentScene } from '@/lib/document-store/current-scene';
import { loadCursor, saveCursor } from '@/lib/playback/cursor';
import { primeStudyProgress } from '@/lib/study/progress/sync';
import { fetchStudyCapability, studyApi } from '@/lib/study/spaces/client';
import type { StudyCourseProgressView } from '@/lib/study/spaces/contracts';

export type StudyResumeDecision =
  | { kind: 'none' }
  | { kind: 'local-newer' }
  | {
      kind: 'server-newer';
      sceneId: string | null;
      actionIndex: number;
      notice: 'scene-changed' | 'scene-missing' | null;
    };

/** When this device last recorded a position for the course, in epoch ms (0 when never). */
export function localPositionTime(
  currentScene: { updatedAt: string } | null,
  cursor: { updatedAt: string } | null,
): number {
  const times = [currentScene?.updatedAt, cursor?.updatedAt]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

/** Pure decision: which position should this device open at? */
export function decideStudyResume(
  progress: StudyCourseProgressView | null,
  localTime: number,
): StudyResumeDecision {
  if (!progress) return { kind: 'none' };
  if (Date.parse(progress.observedAt) <= localTime) return { kind: 'local-newer' };
  return {
    kind: 'server-newer',
    sceneId: progress.resumeSceneId,
    actionIndex: progress.resumeActionIndex,
    notice: progress.sceneMissing
      ? 'scene-missing'
      : progress.sceneChanged
        ? 'scene-changed'
        : null,
  };
}

export interface StudyResumeCheck {
  progress: StudyCourseProgressView | null;
  decision: StudyResumeDecision;
}

/**
 * Read the server position (bounded by `timeoutMs`) and decide against the
 * device position. Null when study progress is unavailable here (signed out,
 * feature off, local-only course, timeout).
 */
export async function checkStudyResume(
  stageId: string,
  timeoutMs = 2500,
): Promise<StudyResumeCheck | null> {
  if (typeof window === 'undefined' || !peekAccountUserId()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (!(await fetchStudyCapability())) return null;
    const progress = await studyApi.getProgress(stageId, controller.signal);
    primeStudyProgress(stageId, progress);
    const [currentScene, cursor] = await Promise.all([
      loadCurrentScene(stageId).catch(() => null),
      loadCursor(stageId).catch(() => null),
    ]);
    return {
      progress,
      decision: decideStudyResume(progress, localPositionTime(currentScene, cursor)),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Write a server-newer position into this device's stores so the classroom opens there. */
export async function applyStudyResume(
  stageId: string,
  decision: Extract<StudyResumeDecision, { kind: 'server-newer' }>,
  observedAt: string,
): Promise<void> {
  await saveCurrentScene(stageId, decision.sceneId);
  if (decision.sceneId) {
    await saveCursor(stageId, {
      sceneId: decision.sceneId,
      actionIndex: decision.actionIndex,
      updatedAt: observedAt,
    });
  }
}
