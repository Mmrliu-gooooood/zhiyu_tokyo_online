/**
 * POST /api/pbl/v2/open-task
 *
 * Drives the Instructor's GREETING (first time in the project) or
 * SETUP (a new microtask just became active) phase. Without this,
 * the workspace would silently wait for the learner to type first —
 * which contradicts the "Instructor speaks first when a new task
 * activates" UX rule.
 *
 * Returns the same SSE stream shape as `/instructor`; the client
 * just dispatches it differently (no learner message to record,
 * Instructor's reply is the only message that lands).
 */

import { hostedAuthGate } from '@/lib/auth/api';
import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { resolveRequestBinding, type ModelBinding } from '@/lib/model-gateway';

import { createSSEResponse } from '@/lib/pbl/v2/api/sse';
import { applyRequestLocaleToProject } from '@/lib/pbl/v2/api/locale';
import { runInstructorTurn } from '@/lib/pbl/v2/agents/instructor';
import { applyQuizSignalsToProject } from '@/lib/pbl/v2/operations/runtime/quiz-snapshot';
import type { PBLProjectV2, PriorQuizResult } from '@/lib/pbl/v2/types';

export const maxDuration = 300;

const log = createLogger('PBL v2 OpenTask API');

interface OpenTaskRequest {
  project: PBLProjectV2;
  phase: 'greeting' | 'setup';
  /** Optional pre-play quiz snapshot piggybacked from the Hero when
   *  the learner first opens the project. Folded into
   *  `project.proficiencyAssessment` before the Instructor runs. */
  priorQuizResults?: PriorQuizResult[];
}

export async function POST(req: NextRequest) {
  const denied = await hostedAuthGate(req);
  if (denied) return denied;
  let body: OpenTaskRequest;
  try {
    body = (await req.json()) as OpenTaskRequest;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
  }

  if (!body?.project) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
  }
  if (body.phase !== 'greeting' && body.phase !== 'setup') {
    return apiError('INVALID_REQUEST', 400, "`phase` must be 'greeting' or 'setup'.");
  }

  let binding: ModelBinding;
  try {
    binding = await resolveRequestBinding(req, body, 'pbl-v2-runtime:open-task');
  } catch (err) {
    log.error('Model resolution failed:', err);
    return apiError('INVALID_REQUEST', 400, err instanceof Error ? err.message : String(err));
  }

  applyRequestLocaleToProject(req, body.project);

  // Stage 2 (pre-play) recalibration: fold prior-quiz accuracy into
  // the adaptive engine before the Instructor turn runs. Only fires
  // on the GREETING (first entry into the project) — the SETUP
  // phase already has the up-to-date assessment from the previous
  // turn's dynamic signals.
  if (body.phase === 'greeting' && body.priorQuizResults && body.priorQuizResults.length > 0) {
    const { updated, tierChanged } = applyQuizSignalsToProject(body.project, body.priorQuizResults);
    if (updated) {
      log.info(
        `Pre-play quiz recalibration: tier=${body.project.proficiency} ` +
          `tierChanged=${tierChanged} ` +
          `quizzes=${body.priorQuizResults.length}`,
      );
    }
  }

  return createSSEResponse(
    runInstructorTurn({
      project: body.project,
      userMessage: '',
      phase: body.phase,
      binding,
      signal: req.signal,
    }),
    { signal: req.signal },
  );
}
