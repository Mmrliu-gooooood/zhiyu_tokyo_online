/**
 * Review tasks (learning plan B12): bring a space's cards up to date, build
 * the review list, record the student's actions and start a redo of a
 * wrong question. No model calls.
 *
 * Opening the review list first syncs the wrong-answer book (throttled, B10),
 * then recomputes only the cards whose inputs changed. With Memory off for
 * the space the list is `manual`: nothing is scheduled by the rules, the
 * student's own dates and flags still are.
 */
import { createLogger } from '@/lib/logger';
import { isStudyGradingFlagOn, isStudyMemoryFlagOn } from '@/lib/server/study/flags';
import { publishRedoPaper } from '@/lib/server/study/exams/service';
import { readMemoryControls } from '@/lib/server/study/memory/repository';
import { projectReviewAction } from '@/lib/server/study/memory/projector';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import {
  findItemSpace,
  readItemRows,
  readItemSummaries,
} from '@/lib/server/study/wrongbook/repository';
import { syncWrongbook } from '@/lib/server/study/wrongbook/service';
import {
  REVIEW_POLICY,
  REVIEW_RULE_VERSION,
  isLocalDate,
  type ReviewAction,
  type ReviewActionKind,
  type ReviewOverview,
} from '@/lib/study/review/contracts';
import {
  buildReviewOverview,
  daysBetween,
  localDate,
  validTimeZone,
  type PlanItem,
} from '@/lib/study/review/plan';
import { deriveCard } from '@/lib/study/review/schedule';
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  cardInputDigest,
  lockCard,
  occurrencesDigest,
  readAnswers,
  readCardInputs,
  readReviewSettings,
  saveActions,
  upsertCard,
} from './repository';

const log = createLogger('StudyReview');

/** Cards recomputed per query batch. */
const REFRESH_BATCH = 200;

interface SpaceRow {
  name: string;
  examDate: string | null;
  examScope: string | null;
  timezone: string | null;
}

async function readSpace(db: Queryable, ownerId: string, spaceId: string): Promise<SpaceRow> {
  const result = await db.query<{
    name: string;
    exam_date: string | null;
    exam_scope: string | null;
    timezone: string | null;
  }>(
    `SELECT name, exam_date::text AS exam_date, exam_scope, timezone
       FROM study_spaces WHERE owner_id = $1 AND id = $2`,
    [ownerId, spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_SPACE_NOT_FOUND');
  return {
    name: row.name,
    examDate: row.exam_date ? String(row.exam_date).slice(0, 10) : null,
    examScope: row.exam_scope,
    timezone: row.timezone,
  };
}

/** The time zone a space's calendar days are counted in. */
export function spaceTimeZone(space: Pick<SpaceRow, 'timezone'>, fallback?: string | null): string {
  return validTimeZone(space.timezone) ?? validTimeZone(fallback) ?? 'UTC';
}

/** Recompute the cards whose answers, actions or rule changed. Returns how many. */
export async function refreshCards(db: StudyDb, ownerId: string, spaceId: string): Promise<number> {
  const inputs = await readCardInputs(db, ownerId, spaceId);
  const stale = inputs.filter(
    (input) =>
      !input.card ||
      input.card.ruleVersion !== REVIEW_RULE_VERSION ||
      input.card.inputDigest !== cardInputDigest(input.occurrences, input.card.actions),
  );
  let written = 0;
  for (let start = 0; start < stale.length; start += REFRESH_BATCH) {
    const batch = stale.slice(start, start + REFRESH_BATCH);
    written += await db.withTransaction(async (tx) => {
      const answers = await readAnswers(
        tx,
        ownerId,
        batch.map((input) => input.itemId),
      );
      let count = 0;
      for (const input of batch) {
        const actions = input.card?.actions ?? [];
        const derived = deriveCard(answers.get(input.itemId) ?? [], actions);
        if (!derived) continue;
        await upsertCard(
          tx,
          ownerId,
          spaceId,
          input.itemId,
          derived,
          cardInputDigest(input.occurrences, actions),
        );
        count += 1;
      }
      return count;
    });
  }
  return written;
}

async function memoryMode(db: Queryable, ownerId: string, spaceId: string) {
  if (!isStudyMemoryFlagOn()) return 'auto' as const;
  const controls = await readMemoryControls(db, ownerId);
  if (!controls.global.enabled) return 'manual' as const;
  return controls.spaces.get(spaceId)?.enabled === false ? ('manual' as const) : ('auto' as const);
}

/** Which question-bank questions behind these keys can be redone (still in the space). */
async function redoable(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  keys: ReadonlyMap<string, string>,
): Promise<Set<string>> {
  const ids = [...keys.values()]
    .filter((key) => key.startsWith('bank:'))
    .map((key) => key.slice('bank:'.length));
  if (ids.length === 0) return new Set();
  const result = await db.query<{ id: string; qtype: string; gradable: boolean }>(
    `SELECT q.id, v.qtype, v.gradable
       FROM study_questions q
       JOIN study_question_versions v
         ON v.owner_id = q.owner_id AND v.question_id = q.id AND v.version = q.current_version
      WHERE q.owner_id = $1 AND q.space_id = $2 AND q.id = ANY($3::text[])`,
    [ownerId, spaceId, ids],
  );
  const open = isStudyGradingFlagOn();
  return new Set(
    result.rows
      .filter((row) => row.gradable && (open || row.qtype !== 'short_answer'))
      .map((row) => `bank:${row.id}`),
  );
}

export async function reviewOverview(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  options: { timezone?: string | null; now?: Date } = {},
): Promise<ReviewOverview> {
  const space = await readSpace(db, ownerId, spaceId);
  try {
    await syncWrongbook(db, ownerId, spaceId);
  } catch (error) {
    if (error instanceof StudyError) throw error;
    log.warn('wrong-answer sync failed; listing the cards as they are', {
      code: (error as { code?: string }).code,
    });
  }
  await refreshCards(db, ownerId, spaceId);
  const read = await db.withTransaction(async (tx) => {
    const rows = (await readItemRows(tx, ownerId, spaceId)).filter((row) => !row.archived);
    const summaries = await readItemSummaries(tx, ownerId, spaceId, rows);
    const inputs = await readCardInputs(tx, ownerId, spaceId);
    const meta = await tx.query<{ id: string; question_key: string; updated_at: string | Date }>(
      `SELECT id, question_key, updated_at FROM study_wrong_items
        WHERE owner_id = $1 AND space_id = $2 AND archived_at IS NULL`,
      [ownerId, spaceId],
    );
    const keys = new Map(meta.rows.map((row) => [row.id, row.question_key]));
    const redo = await redoable(tx, ownerId, spaceId, keys);
    const settings = await readReviewSettings(tx, ownerId, spaceId);
    const mode = await memoryMode(tx, ownerId, spaceId);
    return { rows, summaries, inputs, meta, keys, redo, settings, mode };
  });
  const cards = new Map(read.inputs.flatMap((input) => (input.card ? [[input.itemId, input.card]] : [])));
  const updated = new Map(
    read.meta.rows.map((row) => [
      row.id,
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    ]),
  );
  const items: PlanItem[] = read.summaries.flatMap((summary) => {
    const card = cards.get(summary.id);
    if (!card) return [];
    return [
      {
        itemId: summary.id,
        question: summary.question,
        concepts: summary.concepts,
        sourceType: summary.sourceType,
        reviewState: summary.reviewState,
        flaggedAt: summary.reviewState === 'to_review' ? (updated.get(summary.id) ?? null) : null,
        fsrsDueAt: card.fsrsDueAt,
        evidenceState: card.evidenceState,
        evidence: card.evidence,
        actions: card.actions,
        redo: read.redo.has(read.keys.get(summary.id) ?? ''),
        revision: card.revision,
      },
    ];
  });
  return buildReviewOverview(items, {
    spaceId,
    now: options.now ?? new Date(),
    timezone: spaceTimeZone(space, options.timezone),
    examDate: space.examDate,
    examScope: space.examScope,
    dailyMinutes: read.settings.dailyMinutes,
    customMinutes: read.settings.custom,
    settingsRevision: read.settings.revision,
    mode: read.mode,
  });
}

// ── actions ─────────────────────────────────────────────────────────────────

export interface ReviewActionInput {
  kind: ReviewActionKind;
  until?: string;
  revision: number;
  /** The page's time zone, for a space without one. */
  timezone?: string | null;
}

const OUTCOMES: Partial<Record<ReviewActionKind, 'done' | 'postponed' | 'skipped'>> = {
  done: 'done',
  postpone: 'postponed',
  skip: 'skipped',
};

/**
 * Record one action on an item's card with the revision the page saw (a
 * stale one is 409 with the current card). A postponement must fall on a
 * day from tomorrow to a year ahead in the space's time zone.
 */
export async function applyReviewAction(
  db: StudyDb,
  ownerId: string,
  itemId: string,
  input: ReviewActionInput,
  now: Date = new Date(),
): Promise<{ revision: number; actions: ReviewAction[] }> {
  const { spaceId } = await findItemSpace(db, ownerId, itemId);
  const space = await readSpace(db, ownerId, spaceId);
  if (input.kind === 'postpone') {
    const today = localDate(now, spaceTimeZone(space, input.timezone));
    if (
      !isLocalDate(input.until) ||
      daysBetween(today, input.until) < 1 ||
      daysBetween(today, input.until) > REVIEW_POLICY.maxPostponeDays
    ) {
      throw new StudyError('STUDY_REVIEW_INVALID', { field: 'until' });
    }
  }
  // The card may not exist yet when the page was opened before a sync.
  await refreshCards(db, ownerId, spaceId);
  const at = now.toISOString();
  const outcome = await db.withTransaction(async (tx) => {
    const card = await lockCard(tx, ownerId, itemId);
    if (!card) throw new StudyError('STUDY_REVIEW_CARD_NOT_FOUND');
    if (card.revision !== input.revision) {
      throw new StudyError('STUDY_REVISION_CONFLICT', {
        current: { revision: card.revision, actions: card.actions },
      });
    }
    const action: ReviewAction = {
      kind: input.kind,
      at,
      ...(input.kind === 'postpone' ? { until: input.until } : {}),
    };
    const actions = [...card.actions, action].slice(-REVIEW_POLICY.actionsKept);
    const answers = await readAnswers(tx, ownerId, [itemId]);
    const derived = deriveCard(answers.get(itemId) ?? [], actions);
    if (!derived) throw new StudyError('STUDY_REVIEW_CARD_NOT_FOUND');
    const occurrences = (await occurrencesDigest(tx, ownerId, itemId)) ?? '';
    const revision = await saveActions(
      tx,
      ownerId,
      itemId,
      actions,
      derived,
      cardInputDigest(occurrences, actions),
    );
    return { revision, actions };
  });
  const recorded = OUTCOMES[input.kind];
  if (recorded) {
    await projectReviewAction(db, ownerId, {
      itemId,
      spaceId,
      revision: outcome.revision,
      outcome: recorded,
      occurredAt: at,
    });
  }
  return outcome;
}

// ── redo ────────────────────────────────────────────────────────────────────

/**
 * A one-question practice paper with the item's question-bank question as it
 * is now. Only bank questions can be redone this way (classroom questions are
 * redone in their classroom).
 */
export async function startRedo(
  db: StudyDb,
  ownerId: string,
  itemId: string,
  idempotencyKey: string,
): Promise<{ paperId: string; created: boolean }> {
  const { spaceId, questionKey } = await findItemSpace(db, ownerId, itemId);
  if (!questionKey.startsWith('bank:')) {
    throw new StudyError('STUDY_REVIEW_REDO_UNAVAILABLE', { reason: 'not_bank' });
  }
  const concept = await db.query<{ concepts: string[] }>(
    'SELECT concepts FROM study_wrong_items WHERE owner_id = $1 AND id = $2',
    [ownerId, itemId],
  );
  const first = concept.rows[0]?.concepts?.[0];
  return publishRedoPaper(db, ownerId, {
    spaceId,
    questionId: questionKey.slice('bank:'.length),
    wrongItemId: itemId,
    questionKey,
    title: first ? `原题重做 · ${first}`.slice(0, 120) : '原题重做',
    idempotencyKey,
    allowOpen: isStudyGradingFlagOn(),
  });
}
