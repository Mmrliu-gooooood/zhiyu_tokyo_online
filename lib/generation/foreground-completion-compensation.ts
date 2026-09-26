/**
 * Reopen compensation for a foreground course whose completion request never
 * succeeded (the document says complete, the server mirror or the capacity
 * lease does not).
 *
 * `stage_meta.generation_complete` is a mirror only; the document outline is
 * the authority. Every `server-job` course (background worker, Pro agent
 * curriculum tools, PPTX import) has no foreground lease, and the direct Pro/
 * PPTX writers never write the mirror by design, so all of them are excluded.
 * The request is sent at most once per course per page lifetime, never polled,
 * and failures stay silent: this is background repair, not a user action.
 */
import type { StageMetaView } from '@/lib/classroom/stage-meta-client';
import type { DocumentProducer } from '@/lib/document-store/persistence-types';
import {
  completeForegroundGenerationRoot,
  hasPendingForegroundGenerationSession,
} from '@/lib/generation/foreground-root-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('ForegroundCompletionCompensation');

const attempted = new Set<string>();

export interface CompensationStageState {
  stageId: string | undefined;
  generationComplete: boolean;
  outlineProducer: DocumentProducer | null;
}

export interface CompensationDeps {
  persistenceEnabled: () => boolean;
  /** Resolves false when the load-time self-heal save of this stage failed. */
  awaitSelfHealSave: (stageId: string) => Promise<boolean>;
  complete?: (stageId: string) => Promise<void>;
  hasPendingSession?: (stageId: string) => boolean;
}

/** Pure eligibility check; see the module comment for each condition. */
export function needsForegroundCompletionCompensation(
  stageId: string,
  meta: StageMetaView,
  state: CompensationStageState,
  hasPendingSession: (stageId: string) => boolean = hasPendingForegroundGenerationSession,
): boolean {
  if (meta.isOwner !== true) return false;
  if (state.stageId !== stageId || state.generationComplete !== true) return false;
  if (state.outlineProducer === 'server-job') return false;
  return meta.generationComplete === false || hasPendingSession(stageId);
}

/**
 * Send the completion request if the reopened course needs it. Returns whether
 * a request was attempted (for tests and diagnostics).
 */
export async function compensateForegroundCompletion(
  stageId: string,
  meta: StageMetaView,
  getState: () => CompensationStageState,
  deps: CompensationDeps,
): Promise<boolean> {
  if (attempted.has(stageId) || !deps.persistenceEnabled()) return false;
  const hasPendingSession = deps.hasPendingSession ?? hasPendingForegroundGenerationSession;
  if (!needsForegroundCompletionCompensation(stageId, meta, getState(), hasPendingSession)) {
    return false;
  }
  attempted.add(stageId);
  if (!(await deps.awaitSelfHealSave(stageId))) return false;
  // The self-heal save may have been superseded by a newer load of another course.
  if (!needsForegroundCompletionCompensation(stageId, meta, getState(), hasPendingSession)) {
    return false;
  }
  try {
    await (deps.complete ?? completeForegroundGenerationRoot)(stageId);
    log.info('Repaired foreground generation completion on reopen:', stageId);
  } catch (error) {
    log.warn('Foreground generation completion repair failed:', error);
  }
  return true;
}

/** Test-only: forget which courses this page lifetime already repaired. */
export function resetForegroundCompletionCompensationForTests(): void {
  attempted.clear();
}
