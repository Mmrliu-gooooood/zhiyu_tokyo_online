'use client';

/**
 * Server-side course progress for signed-in learners (learning plan B01).
 *
 * The device playback cursor stays the instant, local source while a course
 * plays; this module mirrors learner positions to the server at most once per
 * FLUSH_DELAY_MS per course, and immediately when the page is hidden.
 *
 * Concurrency: every write names the server revision it was based on. When
 * another tab or device wrote first, the server answers 409 with its current
 * progress; this client then retries on that revision only if its own
 * position was observed later. An old queued position therefore never
 * overwrites a newer one, while the latest real learner action wins.
 *
 * Only call `reportStudyProgress` for learner actions (playing, navigating).
 * The automatic restore of a saved position on open is not one: reporting it
 * would stamp an old position with "now" and override newer progress made on
 * another device.
 */
import { peekAccountUserId } from '@/lib/auth/account-environment';
import { StudyApiError, fetchStudyCapability, studyApi } from '@/lib/study/spaces/client';
import type { StudyCourseProgressView } from '@/lib/study/spaces/contracts';

export const FLUSH_DELAY_MS = 3000;
const RETRY_DELAY_MS = 15_000;

interface PendingPosition {
  sceneId: string;
  actionIndex: number | null;
  observedAt: string;
}

interface CourseSync {
  /** The last server revision this tab knows; null before any read or write. */
  revision: number | null;
  pending: PendingPosition | null;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
  /** The server will not accept positions for this course (not the account's, not stored). */
  disabled: boolean;
}

const courses = new Map<string, CourseSync>();
let account: string | undefined;
let listenersInstalled = false;

function courseState(stageId: string): CourseSync {
  const current = peekAccountUserId();
  if (current !== account) {
    // A different account never inherits another account's queue or revisions.
    for (const state of courses.values()) if (state.timer) clearTimeout(state.timer);
    courses.clear();
    account = current;
  }
  let state = courses.get(stageId);
  if (!state) {
    state = { revision: null, pending: null, timer: null, inflight: null, disabled: false };
    courses.set(stageId, state);
  }
  return state;
}

function installPageListeners(): void {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  const flushAll = () => {
    for (const stageId of courses.keys()) void flushStudyProgress(stageId, { keepalive: true });
  };
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
  window.addEventListener('auth-change', () => {
    for (const state of courses.values()) if (state.timer) clearTimeout(state.timer);
    courses.clear();
    account = undefined;
  });
}

/** Remember the server revision read on open, so the first write does not conflict. */
export function primeStudyProgress(
  stageId: string,
  progress: StudyCourseProgressView | null,
): void {
  const state = courseState(stageId);
  if (progress) state.revision = Math.max(state.revision ?? 0, progress.revision);
}

/** Stop syncing a course for this page session (e.g. the server does not hold it). */
function disable(state: CourseSync): void {
  state.disabled = true;
  state.pending = null;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

/**
 * Queue a learner position. `actionIndex` null means "this scene" (navigation)
 * and keeps the stored index when the scene is unchanged.
 */
export function reportStudyProgress(
  stageId: string,
  sceneId: string,
  actionIndex: number | null,
): void {
  if (typeof window === 'undefined' || !peekAccountUserId()) return;
  const state = courseState(stageId);
  if (state.disabled) return;
  installPageListeners();
  const keepIndex =
    actionIndex === null && state.pending?.sceneId === sceneId ? state.pending.actionIndex : null;
  state.pending = {
    sceneId,
    actionIndex: actionIndex ?? keepIndex,
    observedAt: new Date().toISOString(),
  };
  if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = null;
      void flushStudyProgress(stageId);
    }, FLUSH_DELAY_MS);
  }
}

/** Send the queued position now (if any). Never throws. */
export function flushStudyProgress(
  stageId: string,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  const state = courses.get(stageId);
  if (!state || state.disabled || !state.pending) return Promise.resolve();
  if (state.inflight) {
    // One request per course at a time; the queued position follows it.
    return state.inflight.then(() => flushStudyProgress(stageId, options));
  }
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const position = state.pending;
  state.pending = null;
  state.inflight = send(stageId, state, position, options.keepalive === true).finally(() => {
    state.inflight = null;
  });
  return state.inflight;
}

async function send(
  stageId: string,
  state: CourseSync,
  position: PendingPosition,
  keepalive: boolean,
): Promise<void> {
  if (!(await fetchStudyCapability())) {
    disable(state);
    return;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const progress = await studyApi.putProgress(
        stageId,
        { ...position, baseRevision: state.revision },
        { keepalive },
      );
      state.revision = progress.revision;
      return;
    } catch (error) {
      if (!(error instanceof StudyApiError) || error.status >= 500) {
        // Offline, interrupted or briefly unavailable: keep the newest position, retry later.
        state.pending ??= position;
        if (!state.timer) {
          state.timer = setTimeout(() => {
            state.timer = null;
            void flushStudyProgress(stageId);
          }, RETRY_DELAY_MS);
        }
        return;
      }
      if (error.code === 'STUDY_REVISION_CONFLICT') {
        const current = error.body?.current as StudyCourseProgressView | null | undefined;
        state.revision = current?.revision ?? null;
        // Retry only when this position is newer than what the server holds.
        if (current && Date.parse(position.observedAt) <= Date.parse(current.observedAt)) return;
        continue;
      }
      if (error.code === 'STUDY_SCENE_NOT_FOUND' || error.code === 'STUDY_ACTION_OUT_OF_RANGE') {
        // The course was edited under this tab; the next position will be valid again.
        return;
      }
      // Not available here: no account, feature off, or a course the server does not hold.
      disable(state);
      return;
    }
  }
}

/** Test hook. */
export function resetStudyProgressSync(): void {
  for (const state of courses.values()) if (state.timer) clearTimeout(state.timer);
  courses.clear();
  account = undefined;
}

/** Send every queued position now (leaving a classroom, opening a study page). */
export function flushAllStudyProgress(): Promise<void> {
  return Promise.all([...courses.keys()].map((stageId) => flushStudyProgress(stageId))).then(
    () => undefined,
  );
}
