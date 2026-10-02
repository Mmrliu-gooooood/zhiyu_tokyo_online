/**
 * POST /api/pbl/v2/instructor
 *
 * Streams one Instructor turn back to the client as Server-Sent
 * Events. The client posts the full `PBLProjectV2` (small enough
 * that round-tripping it is fine, and it keeps the server stateless),
 * plus the learner's message text.
 *
 * The server agent reads the current milestone / microtask out of the
 * project, decides which tools to expose, runs the LLM loop, and
 * streams back token deltas + tool-call records + project_patch
 * events. The client applies the patches to its own copy of
 * `scene.content.projectV2`.
 */

import { withHostedProviderQuota } from '@/lib/auth/api';
import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { resolveRequestBinding, type ModelBinding } from '@/lib/model-gateway';

import { createSSEResponse } from '@/lib/pbl/v2/api/sse';
import { applyRequestLocaleToProject } from '@/lib/pbl/v2/api/locale';
import { runInstructorTurn, type InstructorPhase } from '@/lib/pbl/v2/agents/instructor';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

export const maxDuration = 300;

const log = createLogger('PBL v2 Instructor API');

interface InstructorRequest {
  project: PBLProjectV2;
  userMessage: string;
  /** Optional override; defaults to 'instructing'. */
  phase?: InstructorPhase;
}

export async function POST(req: NextRequest) {
  // Model calls take provider quota as the signed-in owner (hosted RLS).
  return withHostedProviderQuota(req, () => handlePOST(req));
}

async function handlePOST(req: NextRequest) {
  let body: InstructorRequest;
  try {
    body = (await req.json()) as InstructorRequest;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
  }

  if (!body?.project) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
  }
  if (typeof body.userMessage !== 'string' || body.userMessage.trim().length === 0) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`userMessage` is required.');
  }

  let binding: ModelBinding;
  try {
    binding = await resolveRequestBinding(req, body, 'pbl-v2-runtime:instructor');
  } catch (err) {
    log.error('Model resolution failed:', err);
    return apiError('INVALID_REQUEST', 400, err instanceof Error ? err.message : String(err));
  }

  const phase = body.phase ?? 'instructing';
  applyRequestLocaleToProject(req, body.project);

  return createSSEResponse(
    runInstructorTurn({
      project: body.project,
      userMessage: body.userMessage,
      phase,
      binding,
      signal: req.signal,
    }),
    { signal: req.signal },
  );
}
