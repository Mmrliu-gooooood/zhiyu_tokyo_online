import type { EngineMode } from './types';

/**
 * Where a chat-session cleanup originated. Explicitly ending a discussion or
 * completing an eligible soft close may resume an interrupted lecture.
 */
export type CleanupSource =
  | 'soft_close_enter'
  | 'soft_close_confirmed'
  | 'soft_close_timeout'
  | 'manual_stop'
  | 'scene_switch'
  | 'error'
  | 'turn_complete';

export interface AutoResumeArgs {
  /** Which cleanup path is running. */
  source: CleanupSource;
  /** Director-provided reason the Q&A/discussion ended, if any. */
  endReason?: string;
  /** Whether this session interrupted an active lecture (read before cleanup). */
  hadLectureInterruption: boolean;
  /** Engine mode AFTER cleanup restored the saved lecture position. */
  engineMode: EngineMode;
  /** Whether the course has no more content to play. */
  isExhausted: boolean;
  /** Whether playback already reached completion. */
  playbackCompleted: boolean;
}

/**
 * Decide whether an ended Q&A/discussion should auto-resume the lecture it
 * interrupted. A manual end is an explicit return to the lesson; automatic
 * soft closes still need a satisfied/back-to-lesson reason. Both require an
 * interrupted lecture and an idle engine with content still remaining.
 */
export function shouldAutoResumeLecture(args: AutoResumeArgs): boolean {
  const manualEnd = args.source === 'manual_stop';
  if (
    !manualEnd &&
    args.source !== 'soft_close_confirmed' &&
    args.source !== 'soft_close_timeout'
  ) {
    return false;
  }
  if (!args.hadLectureInterruption) return false;
  if (!manualEnd && args.endReason !== 'user_done' && args.endReason !== 'back_to_lesson')
    return false;
  if (args.engineMode !== 'idle') return false;
  if (args.isExhausted || args.playbackCompleted) return false;
  return true;
}
