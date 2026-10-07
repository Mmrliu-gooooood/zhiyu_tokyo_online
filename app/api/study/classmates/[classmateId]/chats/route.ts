/**
 * After-class chats with one classmate (learning plan B05).
 *
 * GET  ?spaceId= — this classmate's chats, newest first.
 * POST { spaceId, question, discuss?, origin?, modelRef? } — open a chat: a
 *      durable agent session bound to this classmate and study space. Later
 *      messages go to /api/study/companion-chats/[sessionId]/messages; the
 *      event stream, cancel and resume are the agent-session APIs.
 */
import type { NextRequest } from 'next/server';

import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { listCompanionChats } from '@/lib/server/study/companion/repository';
import {
  cleanQuestion,
  companionFailure,
  openCompanionChat,
  parseDiscuss,
  parseOrigin,
} from '@/lib/server/study/companion/service';
import {
  invalidInput,
  readStudyBody,
  studyCompanionRoute,
  studyJson,
} from '@/lib/server/study/route';
import { StudyError } from '@/lib/server/study/spaces/repository';
import { isClassmateId } from '@/lib/study/classmates/contracts';

export const runtime = 'nodejs';

type Context = { params: Promise<{ classmateId: string }> };

const SPACE_ID = /^[\w-]{1,64}$/;

export function GET(req: NextRequest, context: Context) {
  return studyCompanionRoute(req, async (ownerId, db, headers) => {
    const { classmateId } = await context.params;
    if (!isClassmateId(classmateId)) throw new StudyError('STUDY_CLASSMATE_NOT_FOUND');
    const spaceId = req.nextUrl.searchParams.get('spaceId');
    if (spaceId !== null && !SPACE_ID.test(spaceId)) return invalidInput('spaceId', headers);
    const chats = await listCompanionChats(db, ownerId, {
      classmateId,
      ...(spaceId ? { spaceId } : {}),
    });
    return studyJson({ chats }, 200, headers);
  });
}

export function POST(req: NextRequest, context: Context) {
  return studyCompanionRoute(req, async (ownerId, db, headers) => {
    const { classmateId } = await context.params;
    if (!isClassmateId(classmateId)) throw new StudyError('STUDY_CLASSMATE_NOT_FOUND');
    const body = await readStudyBody(req);
    if (!body) return invalidInput('body', headers);
    if (typeof body.spaceId !== 'string' || !SPACE_ID.test(body.spaceId)) {
      return invalidInput('spaceId', headers);
    }
    const question = cleanQuestion(body.question);
    if (!question) return invalidInput('question', headers);
    const discuss = parseDiscuss(body.discuss);
    if (!discuss) return invalidInput('discuss', headers);
    const origin = parseOrigin(body.origin);
    if (origin === undefined) return invalidInput('origin', headers);
    try {
      const opened = await openCompanionChat(db, ownerId, {
        classmateId,
        spaceId: body.spaceId,
        question,
        discuss,
        origin,
        modelRef: body.modelRef,
        requestOrigin: buildRequestOrigin(req),
      });
      return studyJson(opened, 202, headers);
    } catch (error) {
      const mapped = companionFailure(error, headers);
      if (mapped) return mapped;
      throw error;
    }
  });
}
