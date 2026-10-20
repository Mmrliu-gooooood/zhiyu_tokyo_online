/**
 * Short Memory summaries per study space (learning plan B12, v33).
 *
 * - Written in web, with the student's model, when a study page asks
 *   (`refreshSpaceSummary`) and the rules say the inputs changed enough
 *   (`decideSummary`): unchanged records never call a model, and a space
 *   gets at most one call per `minIntervalMinutes`, an owner at most
 *   `dailyCalls` a day.
 * - Read by the after-class chat runner (worker) as part of Memory.
 * - Derived data: deleting or correcting records, clearing Memory, turning
 *   Memory off or a regrade deletes it (`invalidateSummaries`); deleting it
 *   by hand also suppresses rebuilding it from the same inputs.
 * - Memory off (global or for the space): nothing is written or injected.
 */
import { randomUUID } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import {
  GatewayError,
  ModelSelectionError,
  gateway,
  resolveRequestBinding,
  userText,
  type ModelBinding,
  type ModelGateway,
} from '@/lib/model-gateway';
import { createLogger } from '@/lib/logger';
import { runIndependentHeavyTaskRequest } from '@/lib/server/heavy-task-admission/independent-request';
import { isStudyMemoryFlagOn } from '@/lib/server/study/flags';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import { aggregateRecentState } from '@/lib/study/memory/recent-state';
import {
  SUMMARY_POLICY,
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryMessage,
  decideSummary,
  parseSummary,
  summaryBasis,
  summarySuppressionKey,
  type ReviewSnapshot,
  type StoredSummaryBasis,
  type SummaryDecision,
  type SummaryInput,
  type SummaryRecord,
  type SummaryView,
} from '@/lib/study/memory/summary';
import { EVIDENCE_STATES, type EvidenceState } from '@/lib/study/review/contracts';

import { syncLearningEvents } from './projector';
import {
  deleteSummaryRows,
  listLearningRecords,
  listSuppressions,
  readMemoryControls,
  suppress,
} from './repository';

const log = createLogger('StudyMemorySummary');

const SUMMARY_TIMEOUT_MS = 60_000;

export interface SummaryDependencies {
  gateway?: Pick<ModelGateway, 'complete'>;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface SummaryRow extends Record<string, unknown> {
  space_id: string;
  status: 'ready' | 'failed';
  text: string | null;
  source_watermark: string | number | null;
  input_hash: string;
  policy_version: string;
  model: string | null;
  created_at: string | Date;
}

function view(row: SummaryRow): SummaryView {
  return {
    spaceId: row.space_id,
    status: row.status,
    text: row.text,
    sourceWatermark: row.source_watermark === null ? null : Number(row.source_watermark),
    createdAt: iso(row.created_at),
    model: row.model,
  };
}

async function readRow(db: Queryable, ownerId: string, spaceId: string) {
  const result = await db.query<SummaryRow>(
    `SELECT space_id, status, text, source_watermark, input_hash, policy_version, model, created_at
       FROM study_memory_summaries WHERE owner_id = $1 AND space_id = $2`,
    [ownerId, spaceId],
  );
  return result.rows[0] ?? null;
}

export async function readSummaries(db: Queryable, ownerId: string): Promise<SummaryView[]> {
  const result = await db.query<SummaryRow>(
    `SELECT space_id, status, text, source_watermark, input_hash, policy_version, model, created_at
       FROM study_memory_summaries WHERE owner_id = $1 AND status = 'ready'`,
    [ownerId],
  );
  return result.rows.map(view);
}

/**
 * Delete the derived summaries of one space (or all, `spaceId` null) after
 * their inputs were regraded or Memory was turned off. Safe before v33.
 */
export const invalidateSummaries = deleteSummaryRows;

/** After a regrade of a paper item: the paper's space summary no longer matches the grading. */
export async function invalidateAttemptSummary(
  db: Queryable,
  ownerId: string,
  attemptId: string,
): Promise<void> {
  try {
    const result = await db.query<{ space_id: string }>(
      `SELECT p.space_id FROM study_exam_attempts a
         JOIN study_exam_papers p ON p.owner_id = a.owner_id AND p.id = a.paper_id
        WHERE a.owner_id = $1 AND a.id = $2`,
      [ownerId, attemptId],
    );
    const spaceId = result.rows[0]?.space_id;
    if (spaceId) await invalidateSummaries(db, ownerId, spaceId);
  } catch (error) {
    log.warn('summary invalidation failed', { code: (error as { code?: string }).code });
  }
}

/** The student deletes a summary: it goes, and the same inputs never rebuild it. */
export async function deleteSummary(db: StudyDb, ownerId: string, spaceId: string): Promise<void> {
  await db.withTransaction(async (tx) => {
    const deleted = await tx.query<{ input_hash: string }>(
      `DELETE FROM study_memory_summaries WHERE owner_id = $1 AND space_id = $2 RETURNING input_hash`,
      [ownerId, spaceId],
    );
    const hash = deleted.rows[0]?.input_hash;
    if (hash) await suppress(tx, ownerId, 'summary', [summarySuppressionKey(spaceId, hash)], 'deleted');
  });
}

// ── inputs ──────────────────────────────────────────────────────────────────

async function readReviewSnapshot(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<ReviewSnapshot> {
  const states = Object.fromEntries(EVIDENCE_STATES.map((state) => [state, 0])) as Record<
    EvidenceState,
    number
  >;
  const counts = await db.query<{ evidence_state: EvidenceState; n: string | number }>(
    `SELECT c.evidence_state, count(*) AS n
       FROM study_review_cards c
       JOIN study_wrong_items i ON i.owner_id = c.owner_id AND i.id = c.item_id
      WHERE c.owner_id = $1 AND c.space_id = $2 AND i.archived_at IS NULL
      GROUP BY c.evidence_state`,
    [ownerId, spaceId],
  );
  for (const row of counts.rows) states[row.evidence_state] = Number(row.n);
  const concepts = await db.query<{ concept: string; pending: string | number; total: string | number; stable: string | number }>(
    `SELECT concept,
            count(*) FILTER (WHERE c.evidence_state = 'pending') AS pending,
            count(*) FILTER (WHERE c.evidence_state = 'stable') AS stable,
            count(*) AS total
       FROM study_review_cards c
       JOIN study_wrong_items i ON i.owner_id = c.owner_id AND i.id = c.item_id
       CROSS JOIN LATERAL unnest(i.concepts) AS concept
      WHERE c.owner_id = $1 AND c.space_id = $2 AND i.archived_at IS NULL
      GROUP BY concept`,
    [ownerId, spaceId],
  );
  const rows = concepts.rows.map((row) => ({
    concept: row.concept,
    pending: Number(row.pending),
    stable: Number(row.stable),
    total: Number(row.total),
  }));
  return {
    states,
    weakConcepts: rows
      .filter((row) => row.pending > 0)
      .sort((a, b) => b.pending - a.pending || a.concept.localeCompare(b.concept))
      .slice(0, 5)
      .map((row) => row.concept),
    stableConcepts: rows
      .filter((row) => row.total > 0 && row.stable === row.total)
      .sort((a, b) => b.total - a.total || a.concept.localeCompare(b.concept))
      .slice(0, 5)
      .map((row) => row.concept),
  };
}

type GatheredRecord = SummaryRecord & { stageId: string | null };

interface Gathered {
  spaceName: string;
  examDate: string | null;
  records: GatheredRecord[];
  review: ReviewSnapshot;
  courseTitles: Map<string, string>;
  paperTitles: Map<string, string>;
  /** Papers of the space that are practice (variants, redos), not tests. */
  practicePapers: Set<string>;
}

async function gather(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  now: Date,
): Promise<Gathered> {
  return db.withTransaction(async (tx) => {
    const space = await tx.query<{ name: string; exam_date: string | null }>(
      `SELECT name, exam_date::text AS exam_date FROM study_spaces WHERE owner_id = $1 AND id = $2`,
      [ownerId, spaceId],
    );
    if (!space.rows[0]) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const since = new Date(now.getTime() - SUMMARY_POLICY.windowDays * 86_400_000).toISOString();
    const listed = await listLearningRecords(tx, ownerId, { since, limit: 2000 });
    const inSpace = listed.filter((record) => record.spaceIds.includes(spaceId));
    const courseTitles = new Map<string, string>();
    const paperTitles = new Map<string, string>();
    for (const record of inSpace) {
      if (record.course) courseTitles.set(record.course.stageId, record.course.title);
      if (record.paper?.title) paperTitles.set(record.paper.id, record.paper.title);
    }
    const practice = await tx.query<{ id: string }>(
      `SELECT id FROM study_exam_papers
        WHERE owner_id = $1 AND space_id = $2 AND blueprint ? 'practice'`,
      [ownerId, spaceId],
    );
    return {
      spaceName: space.rows[0].name,
      examDate: space.rows[0].exam_date ? String(space.rows[0].exam_date).slice(0, 10) : null,
      records: inSpace.map((record) => ({
        seq: record.seq,
        type: record.type,
        occurredAt: record.occurredAt,
        payload: record.payload,
        correction: record.correction?.text ?? null,
        stageId: record.course?.stageId ?? null,
      })),
      review: await readReviewSnapshot(tx, ownerId, spaceId),
      courseTitles,
      paperTitles,
      practicePapers: new Set(practice.rows.map((row) => row.id)),
    };
  });
}

function summaryInput(gathered: Gathered, spaceId: string, now: Date): SummaryInput {
  const records = gathered.records;
  const recent = aggregateRecentState(
    records.map((record) => ({
      seq: record.seq,
      type: record.type,
      occurredAt: record.occurredAt,
      payload: record.payload,
      stageId: record.stageId,
      spaceIds: [spaceId],
      classmateId: null,
    })),
    spaceId,
    now,
    SUMMARY_POLICY.windowDays,
  );
  const finished = new Set(
    records.filter((record) => record.type === 'course_finished').map((record) => record.stageId),
  );
  const graded = records.filter((record) => record.type === 'exam_graded');
  const paper = (record: GatheredRecord) => ({
    title: (gathered.paperTitles.get(String(record.payload.paperId ?? '')) ?? '').slice(0, 60),
    earned: Number(record.payload.earned ?? 0),
    total: Number(record.payload.totalPoints ?? 0),
  });
  const isPractice = (record: GatheredRecord) =>
    gathered.practicePapers.has(String(record.payload.paperId ?? ''));
  const { states, weakConcepts, stableConcepts } = gathered.review;
  return {
    subject: gathered.spaceName,
    today: now.toISOString().slice(0, 10),
    examDate: gathered.examDate,
    activity: {
      coursesViewed: recent.coursesViewed,
      coursesFinished: recent.coursesFinished,
      courses: recent.courseProgress.slice(0, 6).map((course) => ({
        title: (gathered.courseTitles.get(course.stageId) ?? '').slice(0, 60),
        furthestPage: course.furthestPage,
        pageCount: course.pageCount,
        finished: finished.has(course.stageId),
      })),
      classroomQuizzes: recent.quizzesGraded
        ? { graded: recent.quizzesGraded, objective: recent.objective }
        : undefined,
      companionQuestions: recent.companionQuestions,
      tests: graded.filter((record) => !isPractice(record)).slice(0, 6).map(paper),
      practice: graded
        .filter(isPractice)
        .slice(0, 6)
        .map((record) => {
          const independence = record.payload.independence as
            | { independent?: number; helped?: number; repeated?: number }
            | undefined;
          return { ...paper(record), ...(independence ?? {}) };
        }),
      hintsOrAnswersShown: records.filter((record) => record.type === 'hint_used').length,
      reviewsDone: records.filter(
        (record) => record.type === 'review_done' && record.payload.outcome === 'done',
      ).length,
    },
    wrongItems: { ...states, weakConcepts, stableConcepts },
    corrections: records
      .flatMap((record) => (record.correction ? [record.correction.slice(0, 120)] : []))
      .slice(0, 5),
  };
}

// ── refresh ─────────────────────────────────────────────────────────────────

export interface SummaryRefreshResult {
  /** `written`: a new summary; `kept`: the stored one still applies; `off`: Memory is off. */
  state: 'written' | 'kept' | 'off' | 'failed';
  reason: SummaryDecision['reason'] | 'memory_off' | 'daily_limit' | 'invalid_output' | 'model_error';
  summary: SummaryView | null;
}

async function memoryOn(db: Queryable, ownerId: string, spaceId: string): Promise<boolean> {
  if (!isStudyMemoryFlagOn()) return false;
  const controls = await readMemoryControls(db, ownerId);
  return controls.global.enabled && controls.spaces.get(spaceId)?.enabled !== false;
}

async function callsToday(db: Queryable, ownerId: string): Promise<number> {
  try {
    const result = await db.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM usage_events
        WHERE owner_id = $1 AND source = 'study-memory-summary'
          AND created_at > now() - interval '1 day'`,
      [ownerId],
    );
    return Number(result.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

const inFlight = new Set<string>();

/**
 * Bring a space's summary up to date if the rules allow; the model is called
 * only for `first` / `changed`. Responds with a SummaryRefreshResult.
 */
export async function refreshSpaceSummary(
  req: Request,
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  body: unknown,
  headers: Headers,
  deps: SummaryDependencies = {},
  now: Date = new Date(),
): Promise<Response> {
  const respond = (result: SummaryRefreshResult, status = 200) =>
    Response.json(result, { status, headers });
  if (!(await memoryOn(db, ownerId, spaceId))) {
    await invalidateSummaries(db, ownerId, spaceId);
    return respond({ state: 'off', reason: 'memory_off', summary: null });
  }
  await syncLearningEvents(db, ownerId);
  const gathered = await gather(db, ownerId, spaceId, now);
  const basis = summaryBasis(spaceId, gathered.records, gathered.review);
  const row = await readRow(db, ownerId, spaceId);
  const previous: StoredSummaryBasis | null = row
    ? {
        spaceId,
        status: row.status,
        sourceWatermark: row.source_watermark === null ? null : Number(row.source_watermark),
        inputHash: row.input_hash,
        policyVersion: row.policy_version,
        createdAt: iso(row.created_at),
      }
    : null;
  const suppressed = (await listSuppressions(db, ownerId, ['summary'])).some(
    (item) => item.key === summarySuppressionKey(spaceId, basis.inputHash),
  );
  const current = row?.status === 'ready' ? view(row) : null;
  const decision = decideSummary(previous, basis, gathered.records, now, suppressed);
  if (!decision.generate) return respond({ state: 'kept', reason: decision.reason, summary: current });
  const key = `${ownerId}\u0000${spaceId}`;
  if (inFlight.has(key)) return respond({ state: 'kept', reason: 'too_soon', summary: current });
  if ((await callsToday(db, ownerId)) >= SUMMARY_POLICY.dailyCalls) {
    return respond({ state: 'kept', reason: 'daily_limit', summary: current });
  }
  let binding: ModelBinding;
  try {
    binding = await resolveRequestBinding(req, body, 'study-memory-summary');
    if (!binding.credentialReady) {
      throw new StudyError('STUDY_SUMMARY_MODEL_UNAVAILABLE', { reason: 'credential' });
    }
  } catch (error) {
    if (error instanceof ModelSelectionError || error instanceof GatewayError) {
      throw new StudyError('STUDY_SUMMARY_MODEL_UNAVAILABLE', { reason: error.code });
    }
    throw error;
  }
  inFlight.add(key);
  try {
    return await runIndependentHeavyTaskRequest(req, 'study-summary', async (leaseSignal) => {
      const model =
        binding.source === 'platform' && binding.providerId && binding.modelId
          ? `${binding.providerId}:${binding.modelId}`
          : binding.modelString;
      let text: string | null = null;
      let failure: 'invalid_output' | 'model_error' | null = null;
      let usage = { inputTokens: 0, outputTokens: 0 };
      try {
        const result = await (deps.gateway ?? gateway).complete(
          binding,
          {
            system: SUMMARY_SYSTEM_PROMPT,
            messages: [userText(buildSummaryMessage(summaryInput(gathered, spaceId, now)))],
            maxOutputTokens: SUMMARY_POLICY.outputTokens,
            temperature: 0.3,
          },
          {
            source: 'study-memory-summary',
            signal: AbortSignal.any([req.signal, leaseSignal, AbortSignal.timeout(SUMMARY_TIMEOUT_MS)]),
            ownerId,
            retry: 'none',
            usage: { requestId: randomUUID(), eventKey: `summary:${spaceId}:${basis.inputHash}` },
          },
        );
        usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
        text = parseSummary(result.text);
        if (!text) failure = 'invalid_output';
      } catch (error) {
        if (!(error instanceof GatewayError) && (error as Error)?.name !== 'TimeoutError') {
          throw error;
        }
        failure = 'model_error';
      }
      // Memory may have been switched off, or records deleted, while the model ran.
      if (!(await memoryOn(db, ownerId, spaceId))) {
        return respond({ state: 'off', reason: 'memory_off', summary: null });
      }
      const saved = await db.query<SummaryRow>(
        `INSERT INTO study_memory_summaries
           (owner_id, space_id, status, text, source_watermark, input_hash, policy_version, model,
            input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (owner_id, space_id) DO UPDATE
            SET status = EXCLUDED.status, text = EXCLUDED.text,
                source_watermark = EXCLUDED.source_watermark, input_hash = EXCLUDED.input_hash,
                policy_version = EXCLUDED.policy_version, model = EXCLUDED.model,
                input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
                created_at = clock_timestamp()
         RETURNING space_id, status, text, source_watermark, input_hash, policy_version, model,
                   created_at`,
        [
          ownerId,
          spaceId,
          text ? 'ready' : 'failed',
          text,
          basis.sourceWatermark,
          basis.inputHash,
          basis.policyVersion,
          model.slice(0, 160),
          usage.inputTokens,
          usage.outputTokens,
        ],
      );
      if (!text) {
        log.warn('summary not written', { reason: failure });
        return respond({ state: 'failed', reason: failure ?? 'model_error', summary: null });
      }
      log.info('summary written', { reason: decision.reason, records: gathered.records.length });
      return respond({ state: 'written', reason: decision.reason, summary: view(saved.rows[0]!) });
    });
  } finally {
    inFlight.delete(key);
  }
}
