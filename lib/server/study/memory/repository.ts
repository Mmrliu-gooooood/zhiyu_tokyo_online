/**
 * Memory repository (accounts v27, learning plan B06). Every query names the
 * owner explicitly: web runs them owner-bound under app_web; the generation
 * worker (after-class chat runner) only reads controls, preferences and facts
 * with its explicit-owner grant.
 *
 * Deleting is real deletion plus a suppression marker, so that a later
 * projection (events), confirm prompt (preferences) or summary rebuild (B12)
 * cannot bring the deleted content back.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import { deleteQuizOccurrences } from '@/lib/server/study/wrongbook/repository';
import {
  MEMORY_LIMITS,
  preferenceSuppressionKey,
  type FactOrigin,
  type FactView,
  type LearningEventInput,
  type LearningEventType,
  type LearningRecordView,
  type LearningSourceType,
  type MemoryControlView,
  type PreferenceEvidence,
  type PreferenceKey,
  type PreferenceOrigin,
  type PreferenceView,
  type SuppressionKind,
} from '@/lib/study/memory/contracts';

function iso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

async function assertSpace(db: Queryable, ownerId: string, spaceId: string | null): Promise<void> {
  if (!spaceId) return;
  const found = await db.query(`SELECT 1 FROM study_spaces WHERE owner_id = $1 AND id = $2`, [
    ownerId,
    spaceId,
  ]);
  if (found.rows.length === 0) throw new StudyError('STUDY_SPACE_NOT_FOUND');
}

// ── controls ────────────────────────────────────────────────────────────────

export interface MemoryControls {
  global: MemoryControlView;
  /** Only spaces with a stored switch; absent = on. */
  spaces: Map<string, MemoryControlView>;
}

interface ControlRow extends Record<string, unknown> {
  space_id: string | null;
  enabled: boolean;
  enabled_since: string | Date | null;
  revision: number;
  updated_at: string | Date;
}

const DEFAULT_CONTROL: MemoryControlView = {
  enabled: true,
  revision: 0,
  enabledSince: null,
  updatedAt: null,
};

function controlOf(row: ControlRow): MemoryControlView {
  return {
    enabled: row.enabled,
    revision: Number(row.revision),
    enabledSince: iso(row.enabled_since),
    updatedAt: iso(row.updated_at),
  };
}

export async function readMemoryControls(db: Queryable, ownerId: string): Promise<MemoryControls> {
  const result = await db.query<ControlRow>(
    `SELECT space_id, enabled, enabled_since, revision, updated_at
       FROM study_memory_controls WHERE owner_id = $1`,
    [ownerId],
  );
  const controls: MemoryControls = { global: DEFAULT_CONTROL, spaces: new Map() };
  for (const row of result.rows) {
    if (row.space_id) controls.spaces.set(row.space_id, controlOf(row));
    else controls.global = controlOf(row);
  }
  return controls;
}

/**
 * Turn the global (spaceId null) or one subject's switch on or off. Turning a
 * switch back on records `enabled_since`, so facts from the off period are
 * never projected later.
 */
export async function setMemoryControl(
  db: StudyDb,
  ownerId: string,
  spaceId: string | null,
  enabled: boolean,
  baseRevision?: number,
): Promise<MemoryControlView> {
  return db.withTransaction(async (tx) => {
    await assertSpace(tx, ownerId, spaceId);
    const existing = await tx.query<ControlRow>(
      `SELECT space_id, enabled, enabled_since, revision, updated_at
         FROM study_memory_controls
        WHERE owner_id = $1 AND COALESCE(space_id, '') = COALESCE($2::text, '')
        FOR UPDATE`,
      [ownerId, spaceId],
    );
    const current = existing.rows[0];
    if (baseRevision !== undefined && (current ? Number(current.revision) : 0) !== baseRevision) {
      throw new StudyError('STUDY_REVISION_CONFLICT', {
        current: current ? controlOf(current) : DEFAULT_CONTROL,
      });
    }
    const result = current
      ? await tx.query<ControlRow>(
          `UPDATE study_memory_controls
              SET enabled = $3,
                  enabled_since = CASE WHEN $3 AND NOT enabled THEN clock_timestamp()
                                       ELSE enabled_since END,
                  revision = revision + 1,
                  updated_at = clock_timestamp()
            WHERE owner_id = $1 AND COALESCE(space_id, '') = COALESCE($2::text, '')
            RETURNING space_id, enabled, enabled_since, revision, updated_at`,
          [ownerId, spaceId, enabled],
        )
      : await tx.query<ControlRow>(
          `INSERT INTO study_memory_controls (owner_id, space_id, enabled)
           VALUES ($1, $2, $3)
           RETURNING space_id, enabled, enabled_since, revision, updated_at`,
          [ownerId, spaceId, enabled],
        );
    return controlOf(result.rows[0]!);
  });
}

// ── preferences ─────────────────────────────────────────────────────────────

interface PreferenceRow extends Record<string, unknown> {
  pref_key: PreferenceKey;
  value: string;
  space_id: string | null;
  origin: PreferenceOrigin;
  evidence: unknown;
  revision: number;
  updated_at: string | Date;
}

const PREFERENCE_COLUMNS = 'pref_key, value, space_id, origin, evidence, revision, updated_at';

function preferenceOf(row: PreferenceRow): PreferenceView {
  return {
    key: row.pref_key,
    value: row.value,
    spaceId: row.space_id,
    origin: row.origin,
    evidence: json<PreferenceEvidence>(row.evidence),
    revision: Number(row.revision),
    updatedAt: iso(row.updated_at)!,
  };
}

/** All preferences, or (with `spaceId`) the global ones plus that subject's. */
export async function listPreferences(
  db: Queryable,
  ownerId: string,
  spaceId?: string,
): Promise<PreferenceView[]> {
  const result = await db.query<PreferenceRow>(
    `SELECT ${PREFERENCE_COLUMNS} FROM study_learner_preferences
      WHERE owner_id = $1 AND ($2::text IS NULL OR space_id IS NULL OR space_id = $2)
      ORDER BY space_id NULLS FIRST, pref_key`,
    [ownerId, spaceId ?? null],
  );
  return result.rows.map(preferenceOf);
}

export interface PreferenceWrite {
  key: PreferenceKey;
  value: string;
  spaceId: string | null;
  origin: PreferenceOrigin;
  evidence: PreferenceEvidence | null;
  baseRevision?: number;
}

export async function putPreference(
  db: StudyDb,
  ownerId: string,
  input: PreferenceWrite,
): Promise<PreferenceView> {
  return db.withTransaction(async (tx) => {
    await assertSpace(tx, ownerId, input.spaceId);
    const existing = await tx.query<PreferenceRow>(
      `SELECT ${PREFERENCE_COLUMNS} FROM study_learner_preferences
        WHERE owner_id = $1 AND COALESCE(space_id, '') = COALESCE($2::text, '') AND pref_key = $3
        FOR UPDATE`,
      [ownerId, input.spaceId, input.key],
    );
    const current = existing.rows[0];
    if (
      input.baseRevision !== undefined &&
      (current ? Number(current.revision) : 0) !== input.baseRevision
    ) {
      throw new StudyError('STUDY_REVISION_CONFLICT', {
        current: current ? preferenceOf(current) : null,
      });
    }
    const evidence = input.evidence ? JSON.stringify(input.evidence) : null;
    const result = current
      ? await tx.query<PreferenceRow>(
          `UPDATE study_learner_preferences
              SET value = $4, origin = $5, evidence = $6::jsonb, revision = revision + 1,
                  updated_at = clock_timestamp()
            WHERE owner_id = $1 AND COALESCE(space_id, '') = COALESCE($2::text, '')
              AND pref_key = $3
            RETURNING ${PREFERENCE_COLUMNS}`,
          [ownerId, input.spaceId, input.key, input.value, input.origin, evidence],
        )
      : await tx.query<PreferenceRow>(
          `INSERT INTO study_learner_preferences
             (owner_id, space_id, pref_key, value, origin, evidence)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           RETURNING ${PREFERENCE_COLUMNS}`,
          [ownerId, input.spaceId, input.key, input.value, input.origin, evidence],
        );
    return preferenceOf(result.rows[0]!);
  });
}

/** Delete one preference and block its value from being suggested again. */
export async function deletePreference(
  db: StudyDb,
  ownerId: string,
  key: PreferenceKey,
  spaceId: string | null,
): Promise<void> {
  await db.withTransaction(async (tx) => {
    const deleted = await tx.query<{ value: string }>(
      `DELETE FROM study_learner_preferences
        WHERE owner_id = $1 AND COALESCE(space_id, '') = COALESCE($2::text, '') AND pref_key = $3
        RETURNING value`,
      [ownerId, spaceId, key],
    );
    const row = deleted.rows[0];
    if (!row) throw new StudyError('STUDY_PREFERENCE_NOT_FOUND');
    await suppress(
      tx,
      ownerId,
      'preference',
      [preferenceSuppressionKey(key, row.value)],
      'deleted',
    );
  });
}

// ── suppressions ────────────────────────────────────────────────────────────

export async function suppress(
  db: Queryable,
  ownerId: string,
  kind: SuppressionKind,
  keys: readonly string[],
  reason: 'deleted' | 'dismissed' | 'cleared',
): Promise<void> {
  if (keys.length === 0) return;
  await db.query(
    `INSERT INTO study_memory_suppressions (owner_id, kind, target_key, reason)
     SELECT $1, $2, key, $4 FROM unnest($3::text[]) AS key
     ON CONFLICT (owner_id, kind, target_key) DO NOTHING`,
    [ownerId, kind, [...new Set(keys)], reason],
  );
}

export async function listSuppressions(
  db: Queryable,
  ownerId: string,
  kinds: readonly SuppressionKind[],
): Promise<Array<{ kind: SuppressionKind; key: string }>> {
  const result = await db.query<{ kind: SuppressionKind; target_key: string }>(
    `SELECT kind, target_key FROM study_memory_suppressions
      WHERE owner_id = $1 AND kind = ANY($2::text[])
      ORDER BY created_at DESC LIMIT 500`,
    [ownerId, [...kinds]],
  );
  return result.rows.map((row) => ({ kind: row.kind, key: row.target_key }));
}

// ── facts ───────────────────────────────────────────────────────────────────

interface FactRow extends Record<string, unknown> {
  id: string;
  space_id: string | null;
  text: string;
  origin: FactOrigin;
  corrects_key: string | null;
  revision: number;
  created_at: string | Date;
  updated_at: string | Date;
}

const FACT_COLUMNS = 'id, space_id, text, origin, corrects_key, revision, created_at, updated_at';

function factOf(row: FactRow): FactView {
  return {
    id: row.id,
    spaceId: row.space_id,
    text: row.text,
    origin: row.origin,
    correctsKey: row.corrects_key,
    revision: Number(row.revision),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

/** Facts, newest first; with `spaceId`, the global ones plus that subject's. */
export async function listFacts(
  db: Queryable,
  ownerId: string,
  spaceId?: string,
): Promise<FactView[]> {
  const result = await db.query<FactRow>(
    `SELECT ${FACT_COLUMNS} FROM study_memory_facts
      WHERE owner_id = $1 AND ($2::text IS NULL OR space_id IS NULL OR space_id = $2)
      ORDER BY updated_at DESC, id LIMIT ${MEMORY_LIMITS.factsPerOwner}`,
    [ownerId, spaceId ?? null],
  );
  return result.rows.map(factOf);
}

export interface FactWrite {
  text: string;
  spaceId: string | null;
  origin: FactOrigin;
  /** A correction names the learning record (source key) it corrects. */
  correctsKey?: string | null;
  evidence?: PreferenceEvidence | null;
}

/**
 * Add a fact. A correction replaces the record's earlier correction (one per
 * record) and keeps the record itself: the original fact stays visible next
 * to the student's correction.
 */
export async function createFact(
  db: StudyDb,
  ownerId: string,
  input: FactWrite,
): Promise<FactView> {
  return db.withTransaction(async (tx) => {
    await assertSpace(tx, ownerId, input.spaceId);
    if (input.origin === 'correction') {
      const record = await tx.query(
        `SELECT 1 FROM study_learning_events WHERE owner_id = $1 AND source_key = $2`,
        [ownerId, input.correctsKey],
      );
      if (record.rows.length === 0) throw new StudyError('STUDY_MEMORY_RECORD_NOT_FOUND');
      const updated = await tx.query<FactRow>(
        `UPDATE study_memory_facts
            SET text = $3, revision = revision + 1, updated_at = clock_timestamp()
          WHERE owner_id = $1 AND corrects_key = $2
          RETURNING ${FACT_COLUMNS}`,
        [ownerId, input.correctsKey, input.text],
      );
      if (updated.rows[0]) return factOf(updated.rows[0]);
    }
    const count = await tx.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM study_memory_facts WHERE owner_id = $1`,
      [ownerId],
    );
    if (Number(count.rows[0]?.count ?? 0) >= MEMORY_LIMITS.factsPerOwner) {
      throw new StudyError('STUDY_MEMORY_FACT_LIMIT');
    }
    const result = await tx.query<FactRow>(
      `INSERT INTO study_memory_facts (id, owner_id, space_id, text, origin, corrects_key, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING ${FACT_COLUMNS}`,
      [
        `mf-${randomBytes(8).toString('hex')}`,
        ownerId,
        input.spaceId,
        input.text,
        input.origin,
        input.origin === 'correction' ? input.correctsKey : null,
        input.evidence ? JSON.stringify(input.evidence) : null,
      ],
    );
    return factOf(result.rows[0]!);
  });
}

/** Correct a fact's text (and optionally its subject). Stale revisions conflict. */
export async function updateFact(
  db: StudyDb,
  ownerId: string,
  factId: string,
  input: { text: string; spaceId?: string | null; baseRevision: number },
): Promise<FactView> {
  return db.withTransaction(async (tx) => {
    const existing = await tx.query<FactRow>(
      `SELECT ${FACT_COLUMNS} FROM study_memory_facts WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
      [ownerId, factId],
    );
    const current = existing.rows[0];
    if (!current) throw new StudyError('STUDY_MEMORY_FACT_NOT_FOUND');
    if (Number(current.revision) !== input.baseRevision) {
      throw new StudyError('STUDY_REVISION_CONFLICT', { current: factOf(current) });
    }
    const spaceId = input.spaceId === undefined ? current.space_id : input.spaceId;
    if (current.origin === 'correction' && spaceId !== current.space_id) {
      throw new StudyError('STUDY_REVISION_CONFLICT', { current: factOf(current) });
    }
    await assertSpace(tx, ownerId, spaceId);
    const result = await tx.query<FactRow>(
      `UPDATE study_memory_facts
          SET text = $3, space_id = $4, revision = revision + 1, updated_at = clock_timestamp()
        WHERE owner_id = $1 AND id = $2
        RETURNING ${FACT_COLUMNS}`,
      [ownerId, factId, input.text, spaceId],
    );
    return factOf(result.rows[0]!);
  });
}

export async function deleteFact(db: Queryable, ownerId: string, factId: string): Promise<void> {
  const result = await db.query(
    `DELETE FROM study_memory_facts WHERE owner_id = $1 AND id = $2 RETURNING id`,
    [ownerId, factId],
  );
  if (result.rows.length === 0) throw new StudyError('STUDY_MEMORY_FACT_NOT_FOUND');
}

// ── learning events ─────────────────────────────────────────────────────────

/**
 * Insert projected events. Idempotent: an existing source key is skipped, and
 * a suppressed (deleted or cleared) source key is never inserted again.
 * Returns how many rows were new.
 */
export async function recordLearningEvents(
  db: Queryable,
  ownerId: string,
  events: readonly LearningEventInput[],
): Promise<number> {
  if (events.length === 0) return 0;
  const rows = events.map((event) => ({
    type: event.type,
    payload_version: event.payloadVersion,
    source_type: event.sourceType,
    source_id: event.sourceId,
    source_key: event.sourceKey,
    stage_id: event.stageId,
    space_id: event.spaceId,
    occurred_at: event.occurredAt,
    payload: event.payload,
  }));
  const result = await db.query(
    `INSERT INTO study_learning_events
       (owner_id, event_type, payload_version, source_type, source_id, source_key, stage_id,
        space_id, occurred_at, payload)
     SELECT $1, e.type, e.payload_version, e.source_type, e.source_id, e.source_key, e.stage_id,
            e.space_id, e.occurred_at, e.payload
       FROM jsonb_to_recordset($2::jsonb) AS e(
              type text, payload_version smallint, source_type text, source_id text,
              source_key text, stage_id text, space_id text, occurred_at timestamptz,
              payload jsonb)
      WHERE NOT EXISTS (
              SELECT 1 FROM study_memory_suppressions s
               WHERE s.owner_id = $1 AND s.kind = 'event' AND s.target_key = e.source_key)
     ON CONFLICT (owner_id, source_key) DO NOTHING
     RETURNING seq`,
    [ownerId, JSON.stringify(rows)],
  );
  return result.rows.length;
}

interface RecordRow extends Record<string, unknown> {
  seq: number | string;
  event_type: LearningEventType;
  source_type: LearningSourceType;
  source_key: string;
  occurred_at: string | Date;
  payload: unknown;
  stage_id: string | null;
  space_id: string | null;
  course_title: string | null;
  classmate_id: string | null;
  classmate_name: string | null;
  link_space_ids: string[] | null;
  correction_id: string | null;
  correction_text: string | null;
  correction_updated_at: string | Date | null;
  paper_title: string | null;
}

/**
 * Newest learning records with course titles, chat classmates, paper titles,
 * the spaces a course belongs to and the student's correction. Records of
 * tombstoned courses drop out; a deleted paper leaves its record untitled.
 */
export async function listLearningRecords(
  db: Queryable,
  ownerId: string,
  options: { limit?: number; since?: string } = {},
): Promise<LearningRecordView[]> {
  const result = await db.query<RecordRow>(
    `SELECT e.seq, e.event_type, e.source_type, e.source_key, e.occurred_at, e.payload,
            e.stage_id, e.space_id, d.name AS course_title,
            cm.id AS classmate_id, cm.name AS classmate_name,
            (SELECT array_agg(l.space_id ORDER BY l.space_id) FROM study_space_courses l
              WHERE l.owner_id = e.owner_id AND l.stage_id = e.stage_id) AS link_space_ids,
            f.id AS correction_id, f.text AS correction_text, f.updated_at AS correction_updated_at,
            ep.title AS paper_title
       FROM study_learning_events e
       LEFT JOIN stage_meta m ON m.stage_id = e.stage_id AND m.owner_id = e.owner_id
       LEFT JOIN document_stages d ON d.id = e.stage_id
       LEFT JOIN study_classmates cm
         ON cm.owner_id = e.owner_id AND cm.id = e.payload->>'classmateId'
       LEFT JOIN study_memory_facts f
         ON f.owner_id = e.owner_id AND f.corrects_key = e.source_key
       LEFT JOIN study_exam_papers ep
         ON ep.owner_id = e.owner_id AND ep.id = e.payload->>'paperId'
      WHERE e.owner_id = $1 AND (e.stage_id IS NULL OR m.deleted_at IS NULL)
        AND ($3::timestamptz IS NULL OR e.occurred_at >= $3::timestamptz)
      ORDER BY e.occurred_at DESC, e.seq DESC
      LIMIT $2`,
    [ownerId, options.limit ?? MEMORY_LIMITS.recordsListed, options.since ?? null],
  );
  return result.rows.map((row) => ({
    seq: Number(row.seq),
    type: row.event_type,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    occurredAt: iso(row.occurred_at)!,
    payload: json<Record<string, unknown>>(row.payload) ?? {},
    course:
      row.stage_id && row.course_title !== null
        ? { stageId: row.stage_id, title: row.course_title }
        : null,
    spaceIds: row.space_id ? [row.space_id] : (row.link_space_ids ?? []),
    classmate:
      row.classmate_id && row.classmate_name
        ? { id: row.classmate_id, name: row.classmate_name }
        : null,
    paper:
      row.event_type === 'exam_graded'
        ? {
            id: String((json<Record<string, unknown>>(row.payload) ?? {}).paperId ?? ''),
            title: row.paper_title,
          }
        : null,
    correction: row.correction_id
      ? {
          factId: row.correction_id,
          text: row.correction_text ?? '',
          updatedAt: iso(row.correction_updated_at)!,
        }
      : null,
  }));
}

/** Delete one record (and its correction); its source key stays suppressed. */
export async function deleteLearningRecord(
  db: StudyDb,
  ownerId: string,
  seq: number,
): Promise<void> {
  await db.withTransaction(async (tx) => {
    const deleted = await tx.query<{ source_key: string }>(
      `DELETE FROM study_learning_events WHERE owner_id = $1 AND seq = $2 RETURNING source_key`,
      [ownerId, seq],
    );
    const key = deleted.rows[0]?.source_key;
    if (!key) throw new StudyError('STUDY_MEMORY_RECORD_NOT_FOUND');
    await tx.query(`DELETE FROM study_memory_facts WHERE owner_id = $1 AND corrects_key = $2`, [
      ownerId,
      key,
    ]);
    await suppress(tx, ownerId, 'event', [key], 'deleted');
  });
}

// ── clearing ────────────────────────────────────────────────────────────────

export interface MemoryClearOptions {
  preferences: boolean;
  facts: boolean;
  records: boolean;
  /**
   * The classroom quiz attempts themselves (answers and scores). Separate
   * from the derived records and off unless the student ticks it.
   */
  rawQuizAttempts: boolean;
}

export interface MemoryClearResult {
  preferences: number;
  facts: number;
  records: number;
  rawQuizAttempts: number;
}

export async function clearMemory(
  db: StudyDb,
  ownerId: string,
  options: MemoryClearOptions,
): Promise<MemoryClearResult> {
  return db.withTransaction(async (tx) => {
    const outcome: MemoryClearResult = {
      preferences: 0,
      facts: 0,
      records: 0,
      rawQuizAttempts: 0,
    };
    if (options.preferences) {
      const deleted = await tx.query<{ pref_key: PreferenceKey; value: string }>(
        `DELETE FROM study_learner_preferences WHERE owner_id = $1 RETURNING pref_key, value`,
        [ownerId],
      );
      outcome.preferences = deleted.rows.length;
      await suppress(
        tx,
        ownerId,
        'preference',
        deleted.rows.map((row) => preferenceSuppressionKey(row.pref_key, row.value)),
        'cleared',
      );
    }
    if (options.facts || options.records) {
      // Corrections belong to their records: clearing either removes them.
      const deleted = await tx.query(
        `DELETE FROM study_memory_facts
          WHERE owner_id = $1 AND ($2::boolean OR origin = 'correction') RETURNING id`,
        [ownerId, options.facts],
      );
      outcome.facts = deleted.rows.length;
    }
    if (options.records) {
      const deleted = await tx.query<{ source_key: string }>(
        `DELETE FROM study_learning_events WHERE owner_id = $1 RETURNING source_key`,
        [ownerId],
      );
      outcome.records = deleted.rows.length;
      await suppress(
        tx,
        ownerId,
        'event',
        deleted.rows.map((row) => row.source_key),
        'cleared',
      );
    }
    if (options.rawQuizAttempts) {
      await tx.query(
        `DELETE FROM runtime_records r USING runtime_sessions s
          WHERE r.session_id = s.id AND s.learner_key = $1 AND s.kind = 'quizAttempt'`,
        [ownerId],
      );
      const deleted = await tx.query(
        `DELETE FROM runtime_sessions WHERE learner_key = $1 AND kind = 'quizAttempt' RETURNING id`,
        [ownerId],
      );
      outcome.rawQuizAttempts = deleted.rows.length;
      // What the wrong-answer book (B10) kept of them goes too.
      await deleteQuizOccurrences(tx, ownerId);
    }
    return outcome;
  });
}
