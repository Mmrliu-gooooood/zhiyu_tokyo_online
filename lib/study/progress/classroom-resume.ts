'use client';

/**
 * Classroom side of cross-device resume (learning plan B01).
 *
 * - Opened from a study space's "continue" (`?resume=study`): the server
 *   position is reconciled before the classroom loads, so it opens there.
 * - Opened any other way: the classroom opens at this device's position at
 *   once; a newer position from another device is then offered, not forced.
 */
import { flushPendingStudyLinks } from '@/lib/study/spaces/pending-links';
import {
  applyStudyResume,
  checkStudyResume,
  type StudyResumeCheck,
} from '@/lib/study/progress/resume';

export const STUDY_RESUME_PARAM = 'resume';
export const STUDY_RESUME_VALUE = 'study';

/** Before the classroom loads: honour `?resume=study` (and drop it from the URL). */
export async function prepareStudyResumeFromUrl(stageId: string): Promise<StudyResumeCheck | null> {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  if (url.searchParams.get(STUDY_RESUME_PARAM) !== STUDY_RESUME_VALUE) return null;
  url.searchParams.delete(STUDY_RESUME_PARAM);
  window.history.replaceState(window.history.state, '', url.toString());
  const check = await checkStudyResume(stageId);
  if (check?.progress && check.decision.kind === 'server-newer') {
    try {
      await applyStudyResume(stageId, check.decision, check.progress.observedAt);
    } catch {
      return null;
    }
  }
  return check;
}

export interface StudyResumeUi {
  /** 1-based page of a scene in the loaded course, or null when absent. */
  pageOf: (sceneId: string) => number | null;
  currentSceneId: () => string | null;
  jumpTo: (sceneId: string) => void;
  notify: (
    message:
      | { kind: 'resumed'; page: number }
      | { kind: 'scene-changed'; page: number | null }
      | { kind: 'scene-missing' }
      | { kind: 'offer'; page: number; jump: () => void },
  ) => void;
  isCurrent: () => boolean;
}

/** After the classroom loaded: finish pending links, explain or offer the resume. */
export async function settleStudyResume(
  stageId: string,
  prepared: StudyResumeCheck | null,
  ui: StudyResumeUi,
): Promise<void> {
  void flushPendingStudyLinks(stageId);
  if (prepared) {
    const decision = prepared.decision;
    if (decision.kind !== 'server-newer') return;
    if (decision.notice === 'scene-missing') ui.notify({ kind: 'scene-missing' });
    else if (decision.notice === 'scene-changed')
      ui.notify({
        kind: 'scene-changed',
        page: decision.sceneId ? ui.pageOf(decision.sceneId) : null,
      });
    else if (decision.sceneId) {
      const page = ui.pageOf(decision.sceneId);
      if (page) ui.notify({ kind: 'resumed', page });
    }
    return;
  }
  const check = await checkStudyResume(stageId);
  if (!ui.isCurrent() || !check?.progress || check.decision.kind !== 'server-newer') return;
  const decision = check.decision;
  const sceneId = decision.sceneId;
  if (!sceneId || sceneId === ui.currentSceneId()) return;
  const page = ui.pageOf(sceneId);
  if (!page) return;
  const observedAt = check.progress.observedAt;
  ui.notify({
    kind: 'offer',
    page,
    jump: () => {
      void applyStudyResume(stageId, decision, observedAt)
        .catch(() => {})
        .finally(() => {
          if (ui.isCurrent()) ui.jumpTo(sceneId);
        });
    },
  });
}

/** `?scene=<id>`: open the classroom at one page (the wrong-answer book's "look back", B10). */
export const STUDY_SCENE_PARAM = 'scene';

/** Before the classroom loads: read `?scene=` and drop it from the URL. */
export function takeStudySceneFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const sceneId = url.searchParams.get(STUDY_SCENE_PARAM);
  if (!sceneId) return null;
  url.searchParams.delete(STUDY_SCENE_PARAM);
  window.history.replaceState(window.history.state, '', url.toString());
  return /^[A-Za-z0-9_-]{1,200}$/.test(sceneId) ? sceneId : null;
}

/** After the classroom loaded: go to the requested page instead of resuming; false when it is gone. */
export function openStudyScene(stageId: string, sceneId: string, ui: StudyResumeUi): boolean {
  void flushPendingStudyLinks(stageId);
  if (!ui.pageOf(sceneId)) return false;
  ui.jumpTo(sceneId);
  return true;
}
