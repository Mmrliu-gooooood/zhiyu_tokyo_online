/**
 * After-class chat bindings (accounts v26, learning plan B05). Every query
 * names the owner explicitly: web runs them owner-bound under app_web, the
 * generation worker (the agent runner) reads with its explicit-owner grant.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { StudyError } from '@/lib/server/study/spaces/repository';
import {
  COMPANION_LIMITS,
  decodeCompanionMessage,
  type CompanionChatView,
  type CompanionOrigin,
  type CompanionPurpose,
} from '@/lib/study/companion/contracts';

export interface CompanionChatRow {
  sessionId: string;
  ownerId: string;
  spaceId: string;
  classmateId: string;
  purpose: CompanionPurpose;
  origin: CompanionOrigin | null;
  createdAt: string;
}

interface RawRow extends Record<string, unknown> {
  session_id: string;
  owner_id: string;
  space_id: string;
  classmate_id: string;
  purpose: CompanionPurpose;
  origin: CompanionOrigin | string | null;
  created_at: string | Date;
}

function iso(value: string | Date | number): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function rowOf(row: RawRow): CompanionChatRow {
  return {
    sessionId: row.session_id,
    ownerId: row.owner_id,
    spaceId: row.space_id,
    classmateId: row.classmate_id,
    purpose: row.purpose,
    origin:
      typeof row.origin === 'string' ? (JSON.parse(row.origin) as CompanionOrigin) : row.origin,
    createdAt: iso(row.created_at),
  };
}

export async function insertCompanionChat(
  db: Queryable,
  input: Omit<CompanionChatRow, 'createdAt' | 'purpose'> & { purpose?: CompanionPurpose },
): Promise<void> {
  await db.query(
    `INSERT INTO study_companion_chats (session_id, owner_id, space_id, classmate_id, purpose, origin)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.sessionId,
      input.ownerId,
      input.spaceId,
      input.classmateId,
      input.purpose ?? 'after_class_qa',
      input.origin ? JSON.stringify(input.origin) : null,
    ],
  );
}

/** The binding of one session, or null for an ordinary (Pro) session. */
export async function getCompanionChat(
  db: Queryable,
  ownerId: string,
  sessionId: string,
): Promise<CompanionChatRow | null> {
  const result = await db.query<RawRow>(
    `SELECT session_id, owner_id, space_id, classmate_id, purpose, origin, created_at
       FROM study_companion_chats WHERE owner_id = $1 AND session_id = $2`,
    [ownerId, sessionId],
  );
  return result.rows[0] ? rowOf(result.rows[0]) : null;
}

/** Which of these sessions are after-class chats (to keep them out of Pro lists). */
export async function companionSessionIds(
  db: Queryable,
  ownerId: string,
  sessionIds: readonly string[],
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const result = await db.query<{ session_id: string }>(
    `SELECT session_id FROM study_companion_chats
      WHERE owner_id = $1 AND session_id = ANY($2::text[])`,
    [ownerId, [...sessionIds]],
  );
  return new Set(result.rows.map((row) => row.session_id));
}

/** The owner's chats with one classmate (optionally in one space), newest first. */
export async function listCompanionChats(
  db: Queryable,
  ownerId: string,
  filter: { classmateId?: string; spaceId?: string },
  limit = 50,
): Promise<CompanionChatView[]> {
  const result = await db.query<
    RawRow & { title: string | null; prompt: string; status: string; updated_at: string | Date }
  >(
    `SELECT c.session_id, c.owner_id, c.space_id, c.classmate_id, c.purpose, c.origin, c.created_at,
            s.title, s.prompt, s.status, s.updated_at
       FROM study_companion_chats c
       JOIN agent_sessions s ON s.id = c.session_id AND s.owner_id = c.owner_id
      WHERE c.owner_id = $1 AND s.deleted_at IS NULL
        AND ($2::text IS NULL OR c.classmate_id = $2)
        AND ($3::text IS NULL OR c.space_id = $3)
      ORDER BY s.updated_at DESC, c.session_id
      LIMIT $4`,
    [ownerId, filter.classmateId ?? null, filter.spaceId ?? null, limit],
  );
  return result.rows.map((row) => {
    const base = rowOf(row);
    return {
      sessionId: base.sessionId,
      spaceId: base.spaceId,
      classmateId: base.classmateId,
      purpose: base.purpose,
      origin: base.origin,
      createdAt: base.createdAt,
      // The opening prompt may carry the discussion-options envelope.
      title:
        row.title?.trim() ||
        Array.from(decodeCompanionMessage(row.prompt).text).slice(0, 40).join(''),
      status: row.status,
      updatedAt: iso(row.updated_at),
    };
  });
}

/**
 * The hourly message cap across the owner's after-class chats: counts the
 * user messages of the last hour. Throws STUDY_COMPANION_RATE_LIMITED.
 */
export async function assertCompanionMessageBudget(
  db: Queryable,
  ownerId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const result = await db.query<{ count: string | number }>(
    `SELECT count(*) AS count
       FROM study_companion_chats c
       JOIN agent_session_events e ON e.session_id = c.session_id
      WHERE c.owner_id = $1 AND e.type = 'user_message' AND e.ts > $2`,
    [ownerId, nowMs - 3_600_000],
  );
  if (Number(result.rows[0]?.count ?? 0) >= COMPANION_LIMITS.messagesPerHour) {
    throw new StudyError('STUDY_COMPANION_RATE_LIMITED');
  }
}
