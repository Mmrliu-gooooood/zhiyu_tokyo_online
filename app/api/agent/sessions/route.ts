/**
 * Agent runtime control plane for session creation and listing.
 *
 * These handlers only use the durable session store. A separately running
 * worker claims queued sessions after the request has returned.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { refuseForeignStagePost } from '@/lib/auth/stage-owner-gate';
import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { MAX_SESSION_TEXT_LENGTH } from '@/lib/server/agent-runtime/limits';
import { findSkill, inferSkillIdFromPrompt, listSkills } from '@/lib/server/agent-runtime/skills';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { validateSessionModelBinding } from '@/lib/server/agent-runtime/session-model-binding';
import {
  bindOwnerMaterialsToSession,
  SessionMaterialBindingError,
} from '@/lib/server/agent-runtime/session-materials';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { buildRequestOrigin, isValidClassroomId } from '@/lib/server/classroom-storage';
import { decodeCourseRefs } from '@/lib/workbench/course-refs';
import { HeavyTaskCapacityError } from '@/lib/server/heavy-task-admission';

export const runtime = 'nodejs';

interface CreateSessionBody {
  mediaConfigRef?: unknown;
  modelRef?: unknown;
  prompt?: string;
  stageId?: string;
  skill?: string;
  /** Attach to an already-built classroom instead of starting a new course. */
  existingCourse?: boolean;
  /** Existing owner-library uploads to bind before the first run is queued. */
  materialIds?: unknown;
  /** Classrooms named on the opening message. */
  courseRefs?: unknown;
}

interface MediaConfigRef {
  id: string;
  revision: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseMediaConfigRef(value: unknown): { ok: true; ref?: MediaConfigRef } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== 'id' && key !== 'revision') ||
    typeof record.id !== 'string' ||
    !UUID_PATTERN.test(record.id) ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1
  ) {
    return { ok: false };
  }
  return { ok: true, ref: { id: record.id, revision: record.revision as number } };
}

export async function POST(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) {
    return new Response('Not found', { status: 404 });
  }

  let body: CreateSessionBody = {};
  try {
    body = ((await req.json()) ?? {}) as CreateSessionBody;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }

  const existingCourse = body.existingCourse === true;
  const stageId = body.stageId?.toString().trim() || undefined;
  if (existingCourse && !stageId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'existingCourse requires stageId');
  }

  const prompt =
    (body.prompt ?? '').toString().trim() || (existingCourse ? (stageId ?? 'existing-course') : '');
  if (!prompt) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'prompt is required');
  }
  if (prompt.length > MAX_SESSION_TEXT_LENGTH) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `prompt exceeds the ${MAX_SESSION_TEXT_LENGTH} character limit`,
    );
  }
  if (
    body.materialIds !== undefined &&
    (!Array.isArray(body.materialIds) || body.materialIds.some((id) => typeof id !== 'string'))
  ) {
    return apiError('INVALID_REQUEST', 400, 'materialIds must be an array of strings');
  }
  const materialIds = [...new Set(((body.materialIds ?? []) as string[]).map((id) => id.trim()))];
  if (materialIds.length > 20 || materialIds.some((id) => !id)) {
    return apiError('INVALID_REQUEST', 400, 'materialIds are invalid');
  }
  if (existingCourse && materialIds.length > 0) {
    return apiError(
      'INVALID_REQUEST',
      400,
      'existingCourse does not accept attachments; send them on the first message instead',
    );
  }
  const decodedCourseRefs = decodeCourseRefs(body.courseRefs ?? []);
  if (!decodedCourseRefs.ok) {
    return apiError('INVALID_REQUEST', 400, decodedCourseRefs.error);
  }
  const parsedMediaConfigRef = parseMediaConfigRef(body.mediaConfigRef);
  if (!parsedMediaConfigRef.ok) {
    return apiError(
      'INVALID_REQUEST',
      400,
      'mediaConfigRef must contain only a UUID id and a positive integer revision',
    );
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    // An EXPLICIT skill — a `?skill=` launch link, not composer UI — is
    // rejected here rather than at claim time: a session created with a typo'd
    // skill would otherwise sit queued and then quietly build an ordinary
    // conversation. The runner's `findSkill` matches a reference by id OR name
    // (a user skill's natural handle is `name`, `my-*`), so the route validates
    // with the same lookup and freezes the resolved id.
    let explicitSkillId = (body.skill ?? '').toString().trim() || undefined;
    if (explicitSkillId) {
      const found = await findSkill(explicitSkillId, ownerId);
      if (!found) {
        const known = await listSkills(ownerId);
        return new NextResponse(
          JSON.stringify({
            success: false as const,
            errorCode: 'INVALID_REQUEST',
            error: `unknown skill "${explicitSkillId}"; installed: ${
              known.map((s) => s.id).join(', ') || '(none)'
            }`,
          }),
          { status: 400, headers: responseHeaders },
        );
      }
      explicitSkillId = found.id;
    }
    /**
     * Otherwise, read the skill off the message itself.
     *
     * Skills are written as `/handle` TEXT — there is no chip and no skill
     * field in the UI, because an input box is an input box. Nothing needs to
     * parse that text for the agent (skills are listed in the system prompt
     * and opened with pi's native `read`), but the session's `skillId` still
     * feeds the outline-constraint pointer. So the SERVER recognises the
     * structure in the text and records it.
     *
     * Forgiving by design: an unrecognised handle simply means no skill — never
     * an error, never a fallback to a default — and the text stays in the
     * prompt either way, so the model still sees what the user asked for.
     */
    const skillId = explicitSkillId ?? (await inferSkillIdFromPrompt(prompt, ownerId));

    if (stageId) {
      const deniedStage = await refuseForeignStagePost(req, stageId, {
        ownerId,
        headers: responseHeaders,
        requireExisting: existingCourse,
      });
      if (deniedStage) return deniedStage;
    }
    if (existingCourse && stageId && !isValidClassroomId(stageId)) {
      const response = apiError(
        'INVALID_REQUEST',
        400,
        'existingCourse stageId has an invalid format',
      );
      responseHeaders.forEach((value, name) => response.headers.append(name, value));
      return response;
    }

    const modelRef = existingCourse
      ? undefined
      : await validateSessionModelBinding(ownerId, body.modelRef);
    const store = await getAgentSessionStore(ownerId);
    const hasOpeningContext = materialIds.length > 0 || decodedCourseRefs.refs.length > 0;
    let meta;
    try {
      meta = await store.createSession({
        ownerId,
        prompt,
        ...(modelRef ? { modelRef } : {}),
        ...(parsedMediaConfigRef.ref ? { mediaConfigRef: parsedMediaConfigRef.ref } : {}),
        ...(stageId ? { stageId } : {}),
        ...(skillId ? { skillId } : {}),
        existingCourse,
        origin: buildRequestOrigin(req),
        // Keep the runner from claiming the session until its opening materials
        // and references are durable. postUserMessage below atomically requeues it.
        ...(existingCourse || hasOpeningContext ? { status: 'succeeded' as const } : {}),
      });
    } catch (error) {
      if (error instanceof HeavyTaskCapacityError) {
        return capacityErrorResponse(error, responseHeaders);
      }
      throw error;
    }

    if (!hasOpeningContext) {
      return NextResponse.json(meta, { status: 202, headers: responseHeaders });
    }

    try {
      const materials = materialIds.length
        ? await bindOwnerMaterialsToSession(meta.id, ownerId, materialIds)
        : [];
      await store.postUserMessage(
        meta.id,
        {
          text: prompt,
          ...(materials.length ? { materials } : {}),
          ...(decodedCourseRefs.refs.length ? { courseRefs: decodedCourseRefs.refs } : {}),
        },
        {
          expectedOwnerId: ownerId,
          ...(modelRef ? { modelRef } : {}),
          ...(parsedMediaConfigRef.ref ? { mediaConfigRef: parsedMediaConfigRef.ref } : {}),
        },
      );
      return NextResponse.json(
        {
          ...meta,
          status: 'queued',
          ...(decodedCourseRefs.refs.length ? { courseRefs: decodedCourseRefs.refs } : {}),
        },
        { status: 202, headers: responseHeaders },
      );
    } catch (error) {
      await store.softDeleteSession(meta.id, ownerId).catch(() => false);
      if (error instanceof SessionMaterialBindingError) {
        return new Response('Not found', { status: 404, headers: responseHeaders });
      }
      if (error instanceof HeavyTaskCapacityError) {
        return capacityErrorResponse(error, responseHeaders);
      }
      throw error;
    }
  });
}

function capacityErrorResponse(error: HeavyTaskCapacityError, headers: Headers): Response {
  const code = error.reason.startsWith('personal_')
    ? 'HEAVY_TASK_PERSONAL_CAPACITY_LIMIT'
    : 'HEAVY_TASK_SITE_CAPACITY_LIMIT';
  const response = apiError(code, error.httpStatus, error.reason);
  headers.forEach((value, name) => response.headers.append(name, value));
  return response;
}

export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) {
    return new Response('Not found', { status: 404 });
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const store = await getAgentSessionStore(ownerId);
    const sessions = await store.listSessionsByOwner(ownerId);
    return NextResponse.json(sessions, { headers: responseHeaders });
  });
}
