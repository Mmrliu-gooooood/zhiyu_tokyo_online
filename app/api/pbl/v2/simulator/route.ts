/**
 * POST /api/pbl/v2/simulator   (SCENARIO ONLY)
 *
 * Streams one in-character Simulator turn back to the client as SSE,
 * mirroring the /instructor route's contract. The client posts the
 * full `PBLProjectV2` plus the learner's message; the server reads the
 * current roleplay milestone / beat, runs the role-play LLM loop, and
 * streams token deltas + a final `message` project_patch (the spoken
 * character line / scene narration) for the client to append to its
 * Simulator thread.
 *
 * Only relevant for scenario projects in a `scenarioStage === 'roleplay'`
 * milestone; `runSimulatorTurn` gates this and errors out otherwise.
 */

import { hostedAuthGate } from '@/lib/auth/api';
import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { resolveRequestBinding, type ModelBinding } from '@/lib/model-gateway';

import { createSSEResponse } from '@/lib/pbl/v2/api/sse';
import { applyRequestLocaleToProject } from '@/lib/pbl/v2/api/locale';
import { runSimulatorTurn, type SimulatorPhase } from '@/lib/pbl/v2/agents/simulator';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

export const maxDuration = 300;

const log = createLogger('PBL v2 Simulator API');

interface SimulatorRequest {
  project: PBLProjectV2;
  userMessage?: string;
  /** 'greeting' opens the scene (narration + character first line);
   *  'instructing' responds to the learner. Defaults to 'instructing'. */
  phase?: SimulatorPhase;
}

export async function POST(req: NextRequest) {
  const denied = await hostedAuthGate(req);
  if (denied) return denied;
  let body: SimulatorRequest;
  try {
    body = (await req.json()) as SimulatorRequest;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
  }

  if (!body?.project) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
  }

  let binding: ModelBinding;
  try {
    binding = await resolveRequestBinding(req, body, 'pbl-v2-runtime:simulator');
  } catch (err) {
    log.error('Model resolution failed:', err);
    return apiError('INVALID_REQUEST', 400, err instanceof Error ? err.message : String(err));
  }

  const phase: SimulatorPhase = body.phase === 'greeting' ? 'greeting' : 'instructing';
  applyRequestLocaleToProject(req, body.project);

  return createSSEResponse(
    runSimulatorTurn({
      project: body.project,
      userMessage: body.userMessage ?? '',
      phase,
      binding,
      signal: req.signal,
    }),
    { signal: req.signal },
  );
}
