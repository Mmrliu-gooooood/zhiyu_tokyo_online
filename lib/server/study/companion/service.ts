/**
 * Web side of after-class classmate chats (learning plan B05): open a chat,
 * post a message, read a chat's header, and keep chats out of Pro lists.
 *
 * Opening a chat follows the agent-session route's opening-context pattern:
 * the session is created terminal (not claimable), the binding row is
 * written, and only then the opening message requeues it — so the runner can
 * never claim a chat before it knows it is one.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { parseOwnerUserId } from '@/lib/auth/principal';
import { createLogger } from '@/lib/logger';
import { resolveAgentDriverModel } from '@/lib/server/agent-runtime/agent-driver-model';
import { probeStageAccess } from '@/lib/server/agent-runtime/curriculum-tools';
import {
  ProModelConnectionError,
  parseProModelRef,
  resolveProModelContext,
} from '@/lib/server/agent-runtime/model-connections';
import { safeModelError } from '@/lib/server/agent-runtime/model-errors';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { getOwnerBoundStageAccessDb } from '@/lib/server/stage-access';
import { getClassmate } from '@/lib/server/study/classmates/repository';
import { isStudyWrongbookFlagOn } from '@/lib/server/study/flags';
import { StudyError, deleteStudySpace, type StudyDb } from '@/lib/server/study/spaces/repository';
import { wrongItemChatContext } from '@/lib/server/study/wrongbook/service';
import { parseClassmateStageAgentId } from '@/lib/study/classmates/contracts';
import {
  COMPANION_LIMITS,
  encodeCompanionMessage,
  type CompanionOrigin,
} from '@/lib/study/companion/contracts';
import { isWrongItemId } from '@/lib/study/wrongbook/contracts';
import type { ProModelRef } from '@/types/pro-model';

import {
  assertCompanionMessageBudget,
  companionSessionIds,
  getCompanionChat,
  insertCompanionChat,
} from './repository';
import { companionMaterials, readCompanionSpace } from './turn';

const log = createLogger('StudyCompanion');

export class CompanionModelRefError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CompanionModelRefError';
  }
}

/**
 * The session model connection for inherit mode. It must be the owner's and
 * resolve to a usable driver for chat (course generation readiness is not
 * required here, unlike Pro sessions).
 */
export async function validateCompanionModelRef(
  ownerId: string,
  value: unknown,
  previous?: ProModelRef,
): Promise<ProModelRef | undefined> {
  if (value === undefined) return previous;
  const ref = parseProModelRef(value);
  if (!ref) throw new CompanionModelRefError('PRO_MODEL_CONFIGURATION_REQUIRED');
  try {
    const context = await resolveProModelContext(ownerId, ref);
    const driver = await resolveAgentDriverModel(context, 'study-companion');
    if (!driver.binding.credentialReady) {
      throw new CompanionModelRefError('PRO_MODEL_CONFIGURATION_REQUIRED');
    }
  } catch (error) {
    if (error instanceof CompanionModelRefError) throw error;
    if (error instanceof ProModelConnectionError) throw new CompanionModelRefError(error.code);
    throw new CompanionModelRefError(safeModelError(error).split(':')[0] ?? 'PRO_MODEL_EXECUTION');
  }
  return ref;
}

/**
 * Lookups that only shape Pro lists and route the generic message API. A
 * missing table (before v26) or an unavailable study database means "no
 * chats": the runner still treats a bound session as a chat on its own.
 */
async function lookupOr<T>(fallback: T, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if ((error as { code?: string }).code !== '42P01') {
      log.warn('after-class chat lookup unavailable', {
        name: error instanceof Error ? error.name : typeof error,
      });
    }
    return fallback;
  }
}

/** Whether a session is an after-class chat (account owners only). */
export async function isCompanionSession(ownerId: string, sessionId: string): Promise<boolean> {
  if (!parseOwnerUserId(ownerId)) return false;
  return lookupOr(false, async () => {
    const db = await getOwnerBoundStageAccessDb(ownerId);
    return Boolean(await getCompanionChat(db as Queryable, ownerId, sessionId));
  });
}

/** Drop after-class chats from a Pro session list. */
export async function withoutCompanionSessions<T extends { id: string }>(
  ownerId: string,
  sessions: T[],
): Promise<T[]> {
  if (!parseOwnerUserId(ownerId) || sessions.length === 0) return sessions;
  const chats = await lookupOr(new Set<string>(), async () => {
    const db = await getOwnerBoundStageAccessDb(ownerId);
    return companionSessionIds(
      db as Queryable,
      ownerId,
      sessions.map((session) => session.id),
    );
  });
  return chats.size ? sessions.filter((session) => !chats.has(session.id)) : sessions;
}

/**
 * Delete a space and retire its after-class chats. Their bindings cascade
 * with the space, and nothing would then keep the sessions out of Pro lists,
 * so each one is soft-deleted (as a failed open does). The space is deleted
 * first; an agent store failure is logged and does not undo or fail it.
 */
export async function deleteStudySpaceWithChats(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
): Promise<void> {
  const { chatSessionIds } = await deleteStudySpace(db, ownerId, spaceId);
  if (chatSessionIds.length === 0) return;
  let failed = 0;
  try {
    const store = await getAgentSessionStore(ownerId);
    for (const sessionId of chatSessionIds) {
      await store.softDeleteSession(sessionId, ownerId).catch(() => {
        failed += 1;
        return false;
      });
    }
  } catch {
    failed = chatSessionIds.length;
  }
  if (failed > 0) {
    log.warn('deleted space left after-class chat sessions behind', {
      spaceId,
      failed,
      sessionIds: chatSessionIds,
    });
  }
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function cleanQuestion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL, '').trim();
  if (!text || Array.from(text).length > COMPANION_LIMITS.question) return null;
  return text;
}

export function parseDiscuss(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > COMPANION_LIMITS.discussionInvites) return null;
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string' || !/^cm-[0-9a-f]{16}$/.test(id)) return null;
    ids.add(id);
  }
  return [...ids];
}

/**
 * The origin the client may send: a classroom position (stage, optional
 * scene / agent / excerpt) and/or a wrong item id (B10). A `wrongItem`
 * copy is never accepted from the client; the server builds it.
 */
export function parseOrigin(value: unknown): CompanionOrigin | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = /^[A-Za-z0-9_-]{1,128}$/;
  if (record.wrongItemId !== undefined && !isWrongItemId(record.wrongItemId)) return undefined;
  const wrongItemId = record.wrongItemId as string | undefined;
  if (record.stageId === undefined) {
    // A wrong-item origin needs no classroom position; anything else does.
    return wrongItemId ? { wrongItemId } : undefined;
  }
  if (typeof record.stageId !== 'string' || !id.test(record.stageId)) return undefined;
  if (
    record.sceneId !== undefined &&
    (typeof record.sceneId !== 'string' || !id.test(record.sceneId))
  ) {
    return undefined;
  }
  if (record.agentId !== undefined && !parseClassmateStageAgentId(record.agentId)) return undefined;
  let excerpt: string | undefined;
  if (record.excerpt !== undefined) {
    if (typeof record.excerpt !== 'string') return undefined;
    excerpt = Array.from(record.excerpt.replace(CONTROL, ' ').trim())
      .slice(0, COMPANION_LIMITS.originExcerpt)
      .join('');
  }
  return {
    stageId: record.stageId,
    ...(record.sceneId ? { sceneId: record.sceneId as string } : {}),
    ...(record.agentId ? { agentId: record.agentId as string } : {}),
    ...(excerpt ? { excerpt } : {}),
    ...(wrongItemId ? { wrongItemId } : {}),
  };
}

/**
 * A wrong-item origin (B10): the item must be the owner's, visible, and in
 * the chat's space. Its newest wrong answer is copied into the origin, with
 * its course page when it has one; a classroom position the client sent
 * along is replaced.
 */
async function resolveWrongItemOrigin(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  wrongItemId: string,
): Promise<CompanionOrigin> {
  if (!isStudyWrongbookFlagOn()) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
  const { context, stageId, sceneId } = await wrongItemChatContext(
    db,
    ownerId,
    spaceId,
    wrongItemId,
  );
  const access = stageId ? await probeStageAccess(ownerId, stageId, db).catch(() => null) : null;
  return {
    ...(stageId && access?.kind === 'owned' ? { stageId, ...(sceneId ? { sceneId } : {}) } : {}),
    wrongItemId,
    wrongItem: context,
  };
}

/** A chat may be (re)opened only for an active classmate in an active space. */
export async function assertChatOpen(
  db: Queryable,
  ownerId: string,
  classmateId: string,
  spaceId: string,
): Promise<void> {
  const classmate = await getClassmate(db, ownerId, classmateId);
  if (classmate.status !== 'active') throw new StudyError('STUDY_CLASSMATE_ARCHIVED');
  const space = await readCompanionSpace(db, ownerId, spaceId);
  if (space.status !== 'active') throw new StudyError('STUDY_SPACE_ARCHIVED');
}

export interface OpenChatInput {
  classmateId: string;
  spaceId: string;
  question: string;
  discuss: string[];
  origin: CompanionOrigin | null;
  modelRef: unknown;
  requestOrigin: string | undefined;
}

export async function openCompanionChat(
  db: Queryable & { withTransaction: <T>(body: (q: Queryable) => Promise<T>) => Promise<T> },
  ownerId: string,
  input: OpenChatInput,
): Promise<{ sessionId: string }> {
  await assertChatOpen(db, ownerId, input.classmateId, input.spaceId);
  let origin = input.origin;
  if (input.origin?.wrongItemId) {
    origin = await resolveWrongItemOrigin(db, ownerId, input.spaceId, input.origin.wrongItemId);
  } else if (input.origin?.stageId) {
    const access = await probeStageAccess(ownerId, input.origin.stageId, db).catch(() => null);
    if (access?.kind !== 'owned') throw new StudyError('STUDY_COURSE_NOT_FOUND');
    const agent = input.origin.agentId ? parseClassmateStageAgentId(input.origin.agentId) : null;
    if (agent && agent.classmateId !== input.classmateId) {
      throw new StudyError('STUDY_CLASSMATE_NOT_FOUND');
    }
  }
  await assertCompanionMessageBudget(db, ownerId);
  const modelRef = await validateCompanionModelRef(ownerId, input.modelRef);
  const store = await getAgentSessionStore(ownerId);
  const prompt = encodeCompanionMessage(input.question, { discuss: input.discuss });
  const meta = await store.createSession({
    ownerId,
    prompt,
    ...(modelRef ? { modelRef } : {}),
    ...(input.requestOrigin ? { origin: input.requestOrigin } : {}),
    status: 'succeeded',
  });
  try {
    await insertCompanionChat(db, {
      sessionId: meta.id,
      ownerId,
      spaceId: input.spaceId,
      classmateId: input.classmateId,
      origin,
    });
    await store.postUserMessage(
      meta.id,
      { text: prompt },
      { expectedOwnerId: ownerId, ...(modelRef ? { modelRef } : {}) },
    );
  } catch (error) {
    await store.softDeleteSession(meta.id, ownerId).catch(() => false);
    await db
      .query('DELETE FROM study_companion_chats WHERE owner_id = $1 AND session_id = $2', [
        ownerId,
        meta.id,
      ])
      .catch(() => undefined);
    throw error;
  }
  return { sessionId: meta.id };
}

export async function postCompanionMessage(
  db: Queryable,
  ownerId: string,
  sessionId: string,
  input: { text: string; discuss: string[]; modelRef: unknown },
): Promise<{ seq: number; delivery: string }> {
  const chat = await getCompanionChat(db, ownerId, sessionId);
  if (!chat) throw new StudyError('STUDY_COMPANION_CHAT_NOT_FOUND');
  const store = await getAgentSessionStore(ownerId);
  const meta = await store.getSession(sessionId);
  if (!meta || meta.ownerId !== ownerId) throw new StudyError('STUDY_COMPANION_CHAT_NOT_FOUND');
  await assertChatOpen(db, ownerId, chat.classmateId, chat.spaceId);
  await assertCompanionMessageBudget(db, ownerId);
  const modelRef = await validateCompanionModelRef(ownerId, input.modelRef, meta.modelRef);
  const posted = await store.postUserMessage(
    sessionId,
    { text: encodeCompanionMessage(input.text, { discuss: input.discuss }) },
    { expectedOwnerId: ownerId, ...(modelRef ? { modelRef } : {}) },
  );
  return { seq: posted.seq, delivery: posted.delivery };
}

/** The chat page header: binding, current classmate, space and authorised materials. */
export async function readCompanionChat(db: Queryable, ownerId: string, sessionId: string) {
  const chat = await getCompanionChat(db, ownerId, sessionId);
  if (!chat) throw new StudyError('STUDY_COMPANION_CHAT_NOT_FOUND');
  const store = await getAgentSessionStore(ownerId);
  const meta = await store.getSession(sessionId);
  if (!meta || meta.ownerId !== ownerId) throw new StudyError('STUDY_COMPANION_CHAT_NOT_FOUND');
  const classmate = await getClassmate(db, ownerId, chat.classmateId);
  const space = await readCompanionSpace(db, ownerId, chat.spaceId);
  const materials = await companionMaterials(db, ownerId, chat.spaceId, chat.classmateId);
  let originCourse: { stageId: string; title: string } | null = null;
  if (chat.origin?.stageId) {
    const access = await probeStageAccess(ownerId, chat.origin.stageId, db).catch(() => null);
    if (access?.kind === 'owned')
      originCourse = { stageId: chat.origin.stageId, title: access.stage.name };
  }
  return {
    chat,
    session: {
      id: meta.id,
      status: meta.status,
      title: meta.title ?? null,
      error: meta.error ?? null,
    },
    classmate,
    space,
    materials,
    originCourse,
  };
}

/** Shared failure mapping for the chat routes (StudyError is mapped by studyRoute). */
export function companionFailure(error: unknown, headers: Headers): Response | null {
  if (error instanceof CompanionModelRefError) {
    return Response.json({ error: error.code }, { status: 409, headers });
  }
  if (error instanceof Error && error.name === 'HeavyTaskCapacityError') {
    const capacity = error as Error & { reason: string; httpStatus: number };
    return Response.json(
      {
        error: capacity.reason.startsWith('personal_')
          ? 'HEAVY_TASK_PERSONAL_CAPACITY_LIMIT'
          : 'HEAVY_TASK_SITE_CAPACITY_LIMIT',
      },
      { status: capacity.httpStatus, headers },
    );
  }
  return null;
}
