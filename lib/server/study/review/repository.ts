/**
 * Review cards and settings (learning plan B12, v33). Web only, owner-bound.
 *
 * A card is derived again whenever its inputs change: the item's graded
 * answers (each occurrence's `digest` changes with its grading) and the
 * student's actions. `input_digest` = md5 of the occurrences (computed in
 * SQL, so an unchanged item is recognised without reading its answers) +
 * the actions, and `rule_version` the policy; either differing recomputes it.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { StudyError } from '@/lib/server/study/spaces/repository';
import {
  REVIEW_POLICY,
  REVIEW_RULE_VERSION,
  type CardEvidence,
  type EvidenceState,
  type ReviewAction,
  type ReviewAnswer,
} from '@/lib/study/review/contracts';
import { questionDigest, type DerivedCard } from '@/lib/study/review/schedule';
import type { WrongOrigin, WrongOutcome, WrongSourceType } from '@/lib/study/wrongbook/contracts';

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function cardInputDigest(occurrences: string, actions: readonly ReviewAction[]): string {
  return `${occurrences}:${actions.length}:${fnv(JSON.stringify(actions))}`;
}

export interface CardRow {
  itemId: string;
  spaceId: string;
  ruleVersion: string;
  inputDigest: string;
  fsrsDueAt: string;
  evidenceState: EvidenceState;
  evidence: CardEvidence;
  actions: ReviewAction[];
  revision: number;
}

export interface CardInputRow {
  itemId: string;
  /** md5 over the item's occurrences (source key + digest). */
  occurrences: string;
  card: CardRow | null;
}

interface CardSqlRow extends Record<string, unknown> {
  item_id: string;
  space_id: string;
  rule_version: string;
  input_digest: string;
  fsrs_due_at: string | Date;
  evidence_state: EvidenceState;
  evidence: unknown;
  actions: unknown;
  revision: number;
}

function cardRow(row: CardSqlRow): CardRow {
  return {
    itemId: row.item_id,
    spaceId: row.space_id,
    ruleVersion: row.rule_version,
    inputDigest: row.input_digest,
    fsrsDueAt: iso(row.fsrs_due_at),
    evidenceState: row.evidence_state,
    evidence: json<CardEvidence>(row.evidence)!,
    actions: json<ReviewAction[]>(row.actions) ?? [],
    revision: Number(row.revision),
  };
}

/** Every live (not archived) item of a space with the digest of its answers and its card. */
export async function readCardInputs(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<CardInputRow[]> {
  const result = await db.query<
    { id: string; occurrences: string } & Partial<CardSqlRow> & { has_card: boolean }
  >(
    `SELECT i.id,
            md5(string_agg(o.source_key || ':' || o.digest, ',' ORDER BY o.source_key)) AS occurrences,
            c.item_id IS NOT NULL AS has_card, c.item_id, c.space_id, c.rule_version,
            c.input_digest, c.fsrs_due_at, c.evidence_state, c.evidence, c.actions, c.revision
       FROM study_wrong_items i
       JOIN study_wrong_occurrences o ON o.owner_id = i.owner_id AND o.item_id = i.id
       LEFT JOIN study_review_cards c ON c.owner_id = i.owner_id AND c.item_id = i.id
      WHERE i.owner_id = $1 AND i.space_id = $2 AND i.archived_at IS NULL
      GROUP BY i.owner_id, i.id, c.owner_id, c.item_id`,
    [ownerId, spaceId],
  );
  return result.rows.map((row) => ({
    itemId: row.id,
    occurrences: row.occurrences,
    card: row.has_card ? cardRow(row as CardSqlRow) : null,
  }));
}

/** The graded answers of some items, as the scheduler reads them. */
export async function readAnswers(
  db: Queryable,
  ownerId: string,
  itemIds: readonly string[],
): Promise<Map<string, ReviewAnswer[]>> {
  const answers = new Map<string, ReviewAnswer[]>();
  if (itemIds.length === 0) return answers;
  const result = await db.query<{
    item_id: string;
    source_key: string;
    occurred_at: string | Date;
    outcome: WrongOutcome;
    practice: unknown;
    stem: string | null;
    options: unknown;
  }>(
    `SELECT item_id, source_key, occurred_at, outcome, origin->'practice' AS practice,
            question->>'stem' AS stem, question->'options' AS options
       FROM study_wrong_occurrences
      WHERE owner_id = $1 AND item_id = ANY($2::text[])`,
    [ownerId, [...itemIds]],
  );
  for (const row of result.rows) {
    const practice = json<WrongOrigin['practice']>(row.practice);
    const options = json<Array<{ label: string }>>(row.options) ?? [];
    const list = answers.get(row.item_id) ?? [];
    list.push({
      at: iso(row.occurred_at),
      outcome: row.outcome,
      sourceType: sourceTypeOf(row.source_key),
      ...(practice ? { practice } : {}),
      questionDigest: questionDigest({ stem: row.stem ?? '', options }),
    });
    answers.set(row.item_id, list);
  }
  return answers;
}

function sourceTypeOf(sourceKey: string): WrongSourceType {
  return sourceKey.startsWith('exam:')
    ? 'exam_attempt'
    : sourceKey.startsWith('quiz:')
      ? 'quiz_attempt'
      : 'learning_check';
}

/** Write a derived card; the student's actions and the revision are kept as they are. */
export async function upsertCard(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  itemId: string,
  derived: DerivedCard,
  inputDigest: string,
): Promise<void> {
  await db.query(
    `INSERT INTO study_review_cards
       (owner_id, item_id, space_id, rule_version, input_digest, card, fsrs_due_at,
        evidence_state, evidence)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb)
     ON CONFLICT (owner_id, item_id) DO UPDATE
        SET rule_version = EXCLUDED.rule_version, input_digest = EXCLUDED.input_digest,
            card = EXCLUDED.card, fsrs_due_at = EXCLUDED.fsrs_due_at,
            evidence_state = EXCLUDED.evidence_state, evidence = EXCLUDED.evidence,
            updated_at = clock_timestamp()`,
    [
      ownerId,
      itemId,
      spaceId,
      REVIEW_RULE_VERSION,
      inputDigest,
      JSON.stringify(derived.card),
      derived.fsrsDueAt,
      derived.evidenceState,
      JSON.stringify(derived.evidence),
    ],
  );
}

/** One card, locked for an action (inside a transaction). */
export async function lockCard(
  tx: Queryable,
  ownerId: string,
  itemId: string,
): Promise<CardRow | null> {
  const result = await tx.query<CardSqlRow>(
    `SELECT item_id, space_id, rule_version, input_digest, fsrs_due_at, evidence_state, evidence,
            actions, revision
       FROM study_review_cards WHERE owner_id = $1 AND item_id = $2 FOR UPDATE`,
    [ownerId, itemId],
  );
  return result.rows[0] ? cardRow(result.rows[0]) : null;
}

/** Save the student's actions with a freshly derived card; bumps the revision. */
export async function saveActions(
  tx: Queryable,
  ownerId: string,
  itemId: string,
  actions: readonly ReviewAction[],
  derived: DerivedCard,
  inputDigest: string,
): Promise<number> {
  const kept = actions.slice(-REVIEW_POLICY.actionsKept);
  const result = await tx.query<{ revision: number }>(
    `UPDATE study_review_cards
        SET actions = $3::jsonb, rule_version = $4, input_digest = $5, card = $6::jsonb,
            fsrs_due_at = $7, evidence_state = $8, evidence = $9::jsonb,
            revision = revision + 1, updated_at = clock_timestamp()
      WHERE owner_id = $1 AND item_id = $2
      RETURNING revision`,
    [
      ownerId,
      itemId,
      JSON.stringify(kept),
      REVIEW_RULE_VERSION,
      inputDigest,
      JSON.stringify(derived.card),
      derived.fsrsDueAt,
      derived.evidenceState,
      JSON.stringify(derived.evidence),
    ],
  );
  if (!result.rows[0]) throw new StudyError('STUDY_REVIEW_CARD_NOT_FOUND');
  return Number(result.rows[0].revision);
}

/** The md5 of one item's occurrences, as `readCardInputs` computes it. */
export async function occurrencesDigest(
  db: Queryable,
  ownerId: string,
  itemId: string,
): Promise<string | null> {
  const result = await db.query<{ occurrences: string | null }>(
    `SELECT md5(string_agg(source_key || ':' || digest, ',' ORDER BY source_key)) AS occurrences
       FROM study_wrong_occurrences WHERE owner_id = $1 AND item_id = $2`,
    [ownerId, itemId],
  );
  return result.rows[0]?.occurrences ?? null;
}

// ── settings ────────────────────────────────────────────────────────────────

export interface ReviewSettingsRow {
  dailyMinutes: number;
  revision: number;
  custom: boolean;
}

export async function readReviewSettings(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<ReviewSettingsRow> {
  const result = await db.query<{ daily_minutes: number; revision: number }>(
    `SELECT daily_minutes, revision FROM study_review_settings WHERE owner_id = $1 AND space_id = $2`,
    [ownerId, spaceId],
  );
  const row = result.rows[0];
  return row
    ? { dailyMinutes: Number(row.daily_minutes), revision: Number(row.revision), custom: true }
    : { dailyMinutes: REVIEW_POLICY.defaultDailyMinutes, revision: 0, custom: false };
}

/** Set the daily minutes with the revision the page saw (0: none yet); a stale one is 409. */
export async function putReviewSettings(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  dailyMinutes: number,
  baseRevision: number,
): Promise<ReviewSettingsRow> {
  const result =
    baseRevision === 0
      ? await db.query<{ daily_minutes: number; revision: number }>(
          `INSERT INTO study_review_settings (owner_id, space_id, daily_minutes)
           VALUES ($1, $2, $3)
           ON CONFLICT (owner_id, space_id) DO NOTHING
           RETURNING daily_minutes, revision`,
          [ownerId, spaceId, dailyMinutes],
        )
      : await db.query<{ daily_minutes: number; revision: number }>(
          `UPDATE study_review_settings
              SET daily_minutes = $3, revision = revision + 1, updated_at = clock_timestamp()
            WHERE owner_id = $1 AND space_id = $2 AND revision = $4
            RETURNING daily_minutes, revision`,
          [ownerId, spaceId, dailyMinutes, baseRevision],
        );
  const row = result.rows[0];
  if (row) {
    return { dailyMinutes: Number(row.daily_minutes), revision: Number(row.revision), custom: true };
  }
  throw new StudyError('STUDY_REVISION_CONFLICT', {
    current: await readReviewSettings(db, ownerId, spaceId),
  });
}
