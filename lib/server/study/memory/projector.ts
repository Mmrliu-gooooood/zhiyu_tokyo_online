/**
 * Learning-event projection (learning plan B06): read facts the server has
 * already saved and record the events they imply. No model calls.
 *
 * - Sources: B01 course progress, classroom quiz attempts (RuntimeStore),
 *   B05 after-class chat questions and B07 submitted subject papers. Only the
 *   owner's live courses count.
 * - Idempotent: source keys are unique per owner and suppressed keys are
 *   skipped, so any projection can simply be run again (replay after a
 *   failure, or the catch-up when the Memory page opens).
 * - Respects the switches: nothing is projected while Memory is off, and
 *   facts from an off period are not projected after it is turned back on.
 *
 * Inline callers (progress writes, chat messages, paper submissions) use the narrowed variants
 * and never fail their own request when projection fails.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import {
  isStudyCompanionChatFlagOn,
  isStudyExamsFlagOn,
  isStudyMemoryFlagOn,
} from '@/lib/server/study/flags';
import { submittedAttempts, type SubmittedAttemptRow } from '@/lib/server/study/exams/repository';
import { listGradingsOfAttempts } from '@/lib/server/study/grading/repository';
import { summarizeReport } from '@/lib/study/assessments/contracts';
import type { LearningEventInput } from '@/lib/study/memory/contracts';
import { assistanceLevel, isIndependentPass } from '@/lib/study/practice/contracts';
import {
  companionEvents,
  eventAllowed,
  examEvents,
  progressEvents,
  quizEvents,
  type QuizRecordSource,
  type ServerQuizQuestion,
} from '@/lib/study/memory/projection';

import { readMemoryControls, recordLearningEvents } from './repository';

const log = createLogger('StudyMemoryProjector');

function iso(value: string | Date | number): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Never record an event in the future (quiz record times come from the browser). */
function clampToNow(events: LearningEventInput[], now: number): LearningEventInput[] {
  return events.map((event) =>
    Date.parse(event.occurredAt) > now
      ? { ...event, occurredAt: new Date(now).toISOString() }
      : event,
  );
}

async function spacesOfStages(
  db: Queryable,
  ownerId: string,
  stageIds: readonly string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (stageIds.length === 0) return map;
  const result = await db.query<{ stage_id: string; space_id: string }>(
    `SELECT stage_id, space_id FROM study_space_courses
      WHERE owner_id = $1 AND stage_id = ANY($2::text[])`,
    [ownerId, [...new Set(stageIds)]],
  );
  for (const row of result.rows) {
    map.set(row.stage_id, [...(map.get(row.stage_id) ?? []), row.space_id]);
  }
  return map;
}

/** Filter by the switches and record. Returns how many events were new. */
async function record(
  db: Queryable,
  ownerId: string,
  events: LearningEventInput[],
): Promise<number> {
  if (events.length === 0) return 0;
  const controls = await readMemoryControls(db, ownerId);
  if (!controls.global.enabled) return 0;
  const links = await spacesOfStages(
    db,
    ownerId,
    events.flatMap((event) => (event.stageId ? [event.stageId] : [])),
  );
  const allowed = clampToNow(events, Date.now()).filter((event) =>
    eventAllowed(event, controls, (stageId) => links.get(stageId) ?? []),
  );
  return recordLearningEvents(db, ownerId, allowed);
}

// ── sources ─────────────────────────────────────────────────────────────────

interface ProgressRow extends Record<string, unknown> {
  stage_id: string;
  scene_index: number;
  scene_count: number;
  furthest_scene_index: number;
  reached_end_at: string | Date | null;
  started_at: string | Date;
  observed_at: string | Date;
  updated_at: string | Date;
}

async function progressSourceEvents(
  db: Queryable,
  ownerId: string,
  stageIds?: readonly string[],
): Promise<LearningEventInput[]> {
  const result = await db.query<ProgressRow>(
    `SELECT p.stage_id, p.scene_index, p.scene_count, p.furthest_scene_index, p.reached_end_at,
            p.started_at, p.observed_at, p.updated_at
       FROM study_progress p
       JOIN stage_meta m ON m.stage_id = p.stage_id AND m.owner_id = p.owner_id
      WHERE p.owner_id = $1 AND m.deleted_at IS NULL
        AND ($2::text[] IS NULL OR p.stage_id = ANY($2::text[]))
      ORDER BY p.updated_at DESC LIMIT 500`,
    [ownerId, stageIds ? [...stageIds] : null],
  );
  return result.rows.flatMap((row) =>
    progressEvents({
      stageId: row.stage_id,
      sceneIndex: Number(row.scene_index),
      sceneCount: Number(row.scene_count),
      furthestSceneIndex: Number(row.furthest_scene_index),
      reachedEndAt: row.reached_end_at ? iso(row.reached_end_at) : null,
      startedAt: iso(row.started_at),
      observedAt: iso(row.observed_at),
      updatedAt: iso(row.updated_at),
    }),
  );
}

interface QuizRow extends Record<string, unknown> {
  session_id: string;
  stage_id: string;
  seq: number | string;
  scene_id: string | null;
  created_at: string;
  payload: unknown;
}

async function quizSourceEvents(db: Queryable, ownerId: string): Promise<LearningEventInput[]> {
  const result = await db.query<QuizRow>(
    `SELECT s.id AS session_id, s.stage_id, r.seq, r.scene_id, r.created_at, r.data->'payload' AS payload
       FROM runtime_sessions s
       JOIN runtime_records r ON r.session_id = s.id
       JOIN stage_meta m ON m.stage_id = s.stage_id AND m.owner_id = $1
      WHERE s.learner_key = $1 AND s.kind = 'quizAttempt' AND m.deleted_at IS NULL
      ORDER BY s.updated_at DESC, r.seq
      LIMIT 3000`,
    [ownerId],
  );
  const sessions = new Map<string, { stageId: string; records: QuizRecordSource[] }>();
  for (const row of result.rows) {
    const entry = sessions.get(row.session_id) ?? { stageId: row.stage_id, records: [] };
    entry.records.push({
      seq: Number(row.seq),
      sceneId: row.scene_id,
      createdAt: iso(row.created_at),
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    });
    sessions.set(row.session_id, entry);
  }
  // The stored course's quiz questions, for server-side re-grading.
  const scenes = [
    ...new Set(
      [...sessions.values()].flatMap((entry) =>
        entry.records.flatMap((record) =>
          record.sceneId ? [`${entry.stageId}\u0000${record.sceneId}`] : [],
        ),
      ),
    ),
  ];
  const questions = new Map<string, ServerQuizQuestion[] | null>();
  if (scenes.length) {
    const stored = await db.query<{ stage_id: string; id: string; questions: unknown }>(
      `SELECT s.stage_id, s.id, s.data->'content'->'questions' AS questions
         FROM document_scenes s
         JOIN unnest($1::text[], $2::text[]) AS k(stage_id, scene_id)
           ON s.stage_id = k.stage_id AND s.id = k.scene_id`,
      [scenes.map((key) => key.split('\u0000')[0]), scenes.map((key) => key.split('\u0000')[1])],
    );
    for (const row of stored.rows) {
      const list = typeof row.questions === 'string' ? JSON.parse(row.questions) : row.questions;
      questions.set(`${row.stage_id}\u0000${row.id}`, Array.isArray(list) ? list : null);
    }
  }
  return [...sessions.entries()].flatMap(([sessionId, entry]) =>
    quizEvents(
      sessionId,
      entry.stageId,
      entry.records,
      (sceneId) => questions.get(`${entry.stageId}\u0000${sceneId}`) ?? null,
    ),
  );
}

interface CompanionRow extends Record<string, unknown> {
  session_id: string;
  space_id: string;
  classmate_id: string;
  seq: number;
  ts: number | string;
  text: string | null;
}

async function companionSourceEvents(
  db: Queryable,
  ownerId: string,
  sessionId?: string,
): Promise<LearningEventInput[]> {
  const result = await db.query<CompanionRow>(
    `SELECT c.session_id, c.space_id, c.classmate_id, e.seq, e.ts, e.data->>'text' AS text
       FROM study_companion_chats c
       JOIN agent_sessions s ON s.id = c.session_id AND s.owner_id = c.owner_id
       JOIN agent_session_events e ON e.session_id = c.session_id AND e.type = 'user_message'
      WHERE c.owner_id = $1 AND s.deleted_at IS NULL
        AND ($2::text IS NULL OR c.session_id = $2)
      ORDER BY e.ts DESC LIMIT 1000`,
    [ownerId, sessionId ?? null],
  );
  return companionEvents(
    result.rows.map((row) => ({
      sessionId: row.session_id,
      spaceId: row.space_id,
      classmateId: row.classmate_id,
      seq: Number(row.seq),
      ts: Number(row.ts),
      text: row.text ?? '',
    })),
  );
}

async function examSourceEvents(
  db: Queryable,
  ownerId: string,
  attemptId?: string,
): Promise<LearningEventInput[]> {
  const rows = (await submittedAttempts(db, ownerId, attemptId)).filter(
    // A paper with open items is recorded once all of them have a score
    // (B09); its totals then include them. Ungraded attempts are picked up by
    // a later projection.
    (row) => row.open.ungraded === 0,
  );
  const independence = await independenceCounts(db, ownerId, rows);
  return examEvents(
    rows.map((row) => ({
      attemptId: row.attemptId,
      paperId: row.paperId,
      spaceId: row.spaceId,
      submittedAt: row.submittedAt,
      itemCount: row.itemCount,
      correct: row.grading.correct + row.open.correct,
      unanswered: row.grading.unanswered,
      earned: row.grading.earned + row.open.earned,
      totalPoints: row.grading.totalPoints,
      openItems: row.grading.pending ?? 0,
      ...(independence.get(row.attemptId) ?? {}),
    })),
  );
}

/**
 * B11 attempts (they recorded novelty and help): independent checks, items
 * answered after help, repeats — and each hint or solution shown.
 */
async function independenceCounts(
  db: Queryable,
  ownerId: string,
  rows: readonly SubmittedAttemptRow[],
): Promise<
  Map<
    string,
    {
      independence: { independent: number; helped: number; repeated: number };
      help: Array<{ position: number; level: 1 | 2; at: string }>;
    }
  >
> {
  const recorded = rows.filter((row) => Object.keys(row.assistance.items ?? {}).length > 0);
  const counts = new Map<
    string,
    {
      independence: { independent: number; helped: number; repeated: number };
      help: Array<{ position: number; level: 1 | 2; at: string }>;
    }
  >();
  if (recorded.length === 0) return counts;
  const gradings = await listGradingsOfAttempts(
    db,
    ownerId,
    recorded.map((row) => row.attemptId),
  );
  for (const row of recorded) {
    const { items } = summarizeReport(row.grading, gradings.get(row.attemptId) ?? new Map());
    const records = row.assistance.items ?? {};
    const independence = { independent: 0, helped: 0, repeated: 0 };
    const help: Array<{ position: number; level: 1 | 2; at: string }> = [];
    for (const item of items) {
      const record = records[String(item.position)];
      if (isIndependentPass(item.outcome, record)) independence.independent += 1;
      if (assistanceLevel(record) !== 'unassisted') independence.helped += 1;
      if (record?.novelty === 'seen') independence.repeated += 1;
      if (record?.hintAt) help.push({ position: item.position, level: 1, at: record.hintAt });
      if (record?.solutionAt) {
        help.push({ position: item.position, level: 2, at: record.solutionAt });
      }
    }
    counts.set(row.attemptId, { independence, help });
  }
  return counts;
}

// ── entry points ────────────────────────────────────────────────────────────

type MaybeTransactional = Queryable & {
  withTransaction?: <T>(body: (queryable: Queryable) => Promise<T>) => Promise<T>;
};

/**
 * One connection per projection; a failure rolls the projection back and is
 * reported to the caller's catch (outside the transaction).
 */
function inTransaction<T>(db: MaybeTransactional, body: (queryable: Queryable) => Promise<T>) {
  return db.withTransaction ? db.withTransaction(body) : body(db);
}

/** After a progress write (best effort; the catch-up replays failures). */
export async function projectCourseProgress(
  db: MaybeTransactional,
  ownerId: string,
  stageId: string,
): Promise<void> {
  if (!isStudyMemoryFlagOn()) return;
  try {
    await inTransaction(db, async (tx) =>
      record(tx, ownerId, await progressSourceEvents(tx, ownerId, [stageId])),
    );
  } catch (error) {
    log.warn('progress projection failed (replayed later)', {
      code: (error as { code?: string }).code,
    });
  }
}

/** After a chat message was accepted (best effort; the catch-up replays failures). */
export async function projectCompanionChat(
  db: MaybeTransactional,
  ownerId: string,
  sessionId: string,
): Promise<void> {
  if (!isStudyMemoryFlagOn()) return;
  try {
    await inTransaction(db, async (tx) =>
      record(tx, ownerId, await companionSourceEvents(tx, ownerId, sessionId)),
    );
  } catch (error) {
    log.warn('chat projection failed (replayed later)', {
      code: (error as { code?: string }).code,
    });
  }
}

/** After a paper was submitted (best effort; the catch-up replays failures). */
export async function projectExamAttempt(
  db: MaybeTransactional,
  ownerId: string,
  attemptId: string,
): Promise<void> {
  if (!isStudyMemoryFlagOn()) return;
  try {
    await inTransaction(db, async (tx) =>
      record(tx, ownerId, await examSourceEvents(tx, ownerId, attemptId)),
    );
  } catch (error) {
    log.warn('paper projection failed (replayed later)', {
      code: (error as { code?: string }).code,
    });
  }
}

/**
 * A review action the student took (B12): reviewed, postponed or skipped one
 * wrong-answer item. Recorded under the same switches as every other record;
 * best effort (the action itself is saved either way).
 */
export async function projectReviewAction(
  db: MaybeTransactional,
  ownerId: string,
  input: {
    itemId: string;
    spaceId: string;
    revision: number;
    outcome: 'done' | 'postponed' | 'skipped';
    occurredAt: string;
  },
): Promise<void> {
  if (!isStudyMemoryFlagOn()) return;
  try {
    await inTransaction(db, (tx) =>
      record(tx, ownerId, [
        {
          type: 'review_done',
          payloadVersion: 1,
          sourceType: 'review_task',
          sourceId: input.itemId,
          sourceKey: `review:${input.itemId}:${input.revision}`,
          stageId: null,
          spaceId: input.spaceId,
          occurredAt: input.occurredAt,
          payload: { reviewTaskId: input.itemId, outcome: input.outcome },
        },
      ]),
    );
  } catch (error) {
    log.warn('review projection failed', { code: (error as { code?: string }).code });
  }
}

const lastSync = new Map<string, number>();
const inFlight = new Map<string, Promise<SyncOutcome>>();
const SYNC_INTERVAL_MS = 15_000;

export interface SyncOutcome {
  ran: boolean;
  recorded: number;
  failed: string[];
}

/**
 * Replay every source for one owner (the Memory page's catch-up). Throttled
 * per process; a request arriving while a sync runs waits for it, so it never
 * reads before that sync's records are written. Each source is independent:
 * one failing source does not block the others.
 */
export async function syncLearningEvents(
  db: MaybeTransactional,
  ownerId: string,
  options: { force?: boolean; now?: number } = {},
): Promise<SyncOutcome> {
  const running = inFlight.get(ownerId);
  if (running) {
    await running.catch(() => undefined);
    return { ran: false, recorded: 0, failed: [] };
  }
  const now = options.now ?? Date.now();
  if (!options.force && now - (lastSync.get(ownerId) ?? 0) < SYNC_INTERVAL_MS) {
    return { ran: false, recorded: 0, failed: [] };
  }
  lastSync.set(ownerId, now);
  if (lastSync.size > 5_000) lastSync.clear();
  const sync = replaySources(db, ownerId).finally(() => inFlight.delete(ownerId));
  inFlight.set(ownerId, sync);
  return sync;
}

async function replaySources(db: MaybeTransactional, ownerId: string): Promise<SyncOutcome> {
  const controls = await readMemoryControls(db, ownerId);
  if (!controls.global.enabled) return { ran: false, recorded: 0, failed: [] };
  let recorded = 0;
  const failed: string[] = [];
  type Source = [string, (queryable: Queryable) => Promise<LearningEventInput[]>];
  const sources: Source[] = [
    ['study_progress', (queryable) => progressSourceEvents(queryable, ownerId)],
    ['quiz_attempt', (queryable) => quizSourceEvents(queryable, ownerId)],
    // Chats live in the agent-session tables, which exist only with the runtime.
    ...(isStudyCompanionChatFlagOn()
      ? [['companion_chat', (queryable) => companionSourceEvents(queryable, ownerId)] as Source]
      : []),
    ...(isStudyExamsFlagOn()
      ? [['exam_attempt', (queryable) => examSourceEvents(queryable, ownerId)] as Source]
      : []),
  ];
  for (const [name, read] of sources) {
    try {
      recorded += await inTransaction(db, async (tx) => record(tx, ownerId, await read(tx)));
    } catch (error) {
      failed.push(name);
      log.warn('learning-event source failed (replayed on the next sync)', {
        source: name,
        code: (error as { code?: string }).code,
      });
    }
  }
  return { ran: true, recorded, failed };
}

/** Test seam. */
export function resetLearningEventSyncThrottle(): void {
  lastSync.clear();
}
