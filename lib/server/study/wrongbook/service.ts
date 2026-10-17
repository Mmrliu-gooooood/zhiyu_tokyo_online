/**
 * The wrong-answer book (learning plan B10): sync a space's sources, list
 * and open items, and the bounded context a classmate chat carries.
 *
 * - Sync is on demand (the page asks when it opens), bounded per source and
 *   throttled per owner and space; each source writes in its own
 *   transaction, so one failing source does not block the others and is
 *   simply read again next time. No model is called.
 * - "Look back" prefers the frozen copy: a classroom page is offered only
 *   when it still shows the same content the question was asked from;
 *   otherwise the student sees that it changed (or is gone).
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import { createLearningContentSnapshot } from '@/lib/learning/content-snapshot';
import { isStudyExamsFlagOn } from '@/lib/server/study/flags';
import {
  WRONGBOOK_LIMITS,
  isWrong,
  type WrongItemChatContext,
  type WrongItemDetail,
  type WrongLookBack,
  type WrongOccurrenceView,
  type WrongSourceType,
  type WrongbookFilter,
  type WrongbookPage,
  type WrongbookSyncResult,
} from '@/lib/study/wrongbook/contracts';
import { listWrongItems } from '@/lib/study/wrongbook/listing';
import {
  checkEntries,
  examEntries,
  quizEntries,
  sameQuizQuestion,
} from '@/lib/study/wrongbook/projection';
import type { QuizQuestion, Scene } from '@/lib/types/stage';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';

import {
  assertSpace,
  findItemSpace,
  readCheckSources,
  readExamSources,
  readItemRows,
  readItemSummaries,
  readOccurrences,
  readQuizSources,
  readStoredQuizQuestions,
  writeEntries,
} from './repository';

const log = createLogger('StudyWrongbook');

const SYNC_INTERVAL_MS = 10_000;
const lastSync = new Map<string, number>();
const inFlight = new Map<string, Promise<WrongbookSyncResult>>();

/**
 * Bring a space's wrong items up to date. Throttled per process; a request
 * arriving while a sync of the same space runs waits for it.
 */
export async function syncWrongbook(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  options: { force?: boolean; now?: number } = {},
): Promise<WrongbookSyncResult> {
  await assertSpace(db, ownerId, spaceId);
  const key = `${ownerId}\u0000${spaceId}`;
  const running = inFlight.get(key);
  if (running) {
    await running.catch(() => undefined);
    return { ran: false, written: 0, failed: [], legacy: 0, full: false };
  }
  const now = options.now ?? Date.now();
  if (!options.force && now - (lastSync.get(key) ?? 0) < SYNC_INTERVAL_MS) {
    return { ran: false, written: 0, failed: [], legacy: 0, full: false };
  }
  lastSync.set(key, now);
  if (lastSync.size > 5_000) lastSync.clear();
  const sync = runSync(db, ownerId, spaceId).finally(() => inFlight.delete(key));
  inFlight.set(key, sync);
  return sync;
}

async function runSync(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
): Promise<WrongbookSyncResult> {
  const outcome: WrongbookSyncResult = {
    ran: true,
    written: 0,
    failed: [],
    legacy: 0,
    full: false,
  };
  type Source = [WrongSourceType, (tx: Queryable) => Promise<{ written: number; full: boolean }>];
  const sources: Source[] = [
    ...(isStudyExamsFlagOn()
      ? [
          [
            'exam_attempt',
            async (tx: Queryable) => {
              const attempts = await readExamSources(tx, ownerId, spaceId);
              return writeEntries(tx, ownerId, spaceId, attempts.flatMap(examEntries));
            },
          ] as Source,
        ]
      : []),
    [
      'quiz_attempt',
      async (tx) => {
        const sessions = await readQuizSources(tx, ownerId, spaceId);
        const stored = await readStoredQuizQuestions(
          tx,
          sessions.flatMap((session) =>
            session.sceneId ? [{ stageId: session.stageId, sceneId: session.sceneId }] : [],
          ),
        );
        const entries = sessions.flatMap((session) => {
          const result = quizEntries(
            session,
            (sceneId) => stored.get(`${session.stageId}\u0000${sceneId}`) ?? null,
          );
          if (result.legacy) outcome.legacy += 1;
          return result.entries;
        });
        return writeEntries(tx, ownerId, spaceId, entries);
      },
    ],
    [
      'learning_check',
      async (tx) => {
        const sessions = await readCheckSources(tx, ownerId, spaceId);
        return writeEntries(tx, ownerId, spaceId, sessions.flatMap(checkEntries));
      },
    ],
  ];
  for (const [name, run] of sources) {
    try {
      const result = await db.withTransaction(run);
      outcome.written += result.written;
      outcome.full ||= result.full;
    } catch (error) {
      outcome.failed.push(name);
      log.warn('wrong-answer source failed (read again on the next sync)', {
        source: name,
        code: (error as { code?: string }).code,
      });
    }
  }
  return outcome;
}

/** Test seam. */
export function resetWrongbookSyncThrottle(): void {
  lastSync.clear();
}

export async function listWrongbook(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  filter: WrongbookFilter,
): Promise<WrongbookPage> {
  await assertSpace(db, ownerId, spaceId);
  const rows = await readItemRows(db, ownerId, spaceId);
  const { page, total, nextOffset, facets } = listWrongItems(rows, filter);
  return {
    items: await readItemSummaries(db, ownerId, spaceId, page),
    total,
    nextOffset,
    facets,
  };
}

// ── one item ────────────────────────────────────────────────────────────────

async function stageTitle(db: Queryable, stageId: string): Promise<string | null> {
  const result = await db.query<{ name: string }>(
    'SELECT name FROM document_stages WHERE id = $1',
    [stageId],
  );
  return result.rows[0]?.name ?? null;
}

async function readScenes(
  db: Queryable,
  stageId: string,
  sceneIds: readonly string[],
): Promise<Map<string, Scene>> {
  const result = await db.query<{ id: string; data: unknown }>(
    'SELECT id, data FROM document_scenes WHERE stage_id = $1 AND id = ANY($2::text[])',
    [stageId, [...sceneIds]],
  );
  return new Map(
    result.rows.map((row) => [
      row.id,
      (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Scene,
    ]),
  );
}

/**
 * Where "look back" may lead from an occurrence, checked now. A classroom
 * page counts as the original only while its content is unchanged.
 */
export async function lookBackOf(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  occurrence: WrongOccurrenceView,
  questionKey: string,
): Promise<WrongLookBack[]> {
  const origin = occurrence.origin;
  const result: WrongLookBack[] = [];
  if (occurrence.sourceType === 'exam_attempt') {
    if (origin.attemptId) {
      result.push({ kind: 'paper', attemptId: origin.attemptId, title: origin.paperTitle ?? '' });
    }
    const material = occurrence.question.source?.material;
    if (material) {
      const live = await db.query(
        `SELECT 1 FROM study_material_versions v
           JOIN study_materials m ON m.owner_id = v.owner_id AND m.id = v.material_id
          WHERE v.owner_id = $1 AND v.material_id = $2 AND v.id = $3 AND m.status = 'active'`,
        [ownerId, material.materialId, material.versionId],
      );
      const title = occurrence.question.source?.title ?? '';
      result.push(
        live.rows.length
          ? {
              kind: 'material',
              materialId: material.materialId,
              versionId: material.versionId,
              page: material.pages[0] ?? null,
              title,
            }
          : { kind: 'material_gone', title },
      );
    }
    if (questionKey.startsWith('bank:')) {
      const linked = await db.query<{ stage_id: string; name: string }>(
        `SELECT q.stage_id, d.name
           FROM study_questions q
           JOIN study_space_courses c ON c.owner_id = q.owner_id AND c.space_id = $3 AND c.stage_id = q.stage_id
           JOIN stage_meta m ON m.stage_id = q.stage_id AND m.owner_id = q.owner_id AND m.deleted_at IS NULL
           JOIN document_stages d ON d.id = q.stage_id
          WHERE q.owner_id = $1 AND q.id = $2`,
        [ownerId, questionKey.slice('bank:'.length), spaceId],
      );
      const row = linked.rows[0];
      if (row) result.push({ kind: 'course', stageId: row.stage_id, courseTitle: row.name });
    }
    return result;
  }
  const stageId = origin.stageId;
  if (!stageId) return [{ kind: 'course_gone' }];
  const courseTitle = (await stageTitle(db, stageId)) ?? origin.courseTitle ?? '';
  if (occurrence.sourceType === 'quiz_attempt') {
    if (!origin.sceneId) return [{ kind: 'scene_missing', courseTitle }];
    const scene = (await readScenes(db, stageId, [origin.sceneId])).get(origin.sceneId);
    if (!scene) return [{ kind: 'scene_missing', courseTitle }];
    // The question itself, compared field by field (stored key order differs between copies).
    const questionId = questionKey.slice(questionKey.lastIndexOf(':') + 1);
    const questions =
      scene.content?.type === 'quiz' ? (scene.content.questions as QuizQuestion[]) : [];
    const current = questions.find((candidate) => candidate.id === questionId);
    const same = sameQuizQuestion(occurrence.question, current);
    return [
      same
        ? { kind: 'scene', stageId, sceneId: scene.id, courseTitle, sceneTitle: scene.title }
        : { kind: 'scene_changed', stageId, courseTitle, sceneTitle: scene.title },
    ];
  }
  // Learning check: each passage it was written from, compared with the page now.
  const evidence = occurrence.question.evidence ?? [];
  if (evidence.length === 0) return [{ kind: 'scene_missing', courseTitle }];
  const scenes = await readScenes(
    db,
    stageId,
    evidence.map((fragment) => fragment.sceneId),
  );
  for (const fragment of evidence) {
    const scene = scenes.get(fragment.sceneId);
    if (!scene) {
      result.push({ kind: 'scene_missing', courseTitle });
      continue;
    }
    // One page alone: the passage text (and so its digest) depends only on that page.
    const now = await createLearningContentSnapshot({ courseTitle, scenes: [scene] }).catch(
      () => null,
    );
    const digest = now?.fragments.find((item) => item.sourceRef.sceneId === scene.id)?.digest;
    result.push(
      digest === fragment.digest
        ? { kind: 'scene', stageId, sceneId: scene.id, courseTitle, sceneTitle: scene.title }
        : { kind: 'scene_changed', stageId, courseTitle, sceneTitle: scene.title },
    );
  }
  return result;
}

/** The item exists for this owner and is visible (its course is still in the space). */
export async function assertItemVisible(db: Queryable, ownerId: string, itemId: string) {
  const { spaceId } = await findItemSpace(db, ownerId, itemId);
  const rows = await readItemRows(db, ownerId, spaceId);
  if (!rows.some((row) => row.id === itemId)) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
}

/** A visible item of the owner, with its history and look-back targets. */
export async function getWrongItem(
  db: Queryable,
  ownerId: string,
  itemId: string,
): Promise<WrongItemDetail> {
  const { spaceId, questionKey } = await findItemSpace(db, ownerId, itemId);
  const rows = await readItemRows(db, ownerId, spaceId);
  const row = rows.find((candidate) => candidate.id === itemId);
  if (!row) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
  const [summary] = await readItemSummaries(db, ownerId, spaceId, [row]);
  if (!summary) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
  const occurrences = await readOccurrences(db, ownerId, itemId);
  const newestWrong = occurrences.find((occurrence) => isWrong(occurrence.outcome));
  return {
    ...summary,
    occurrences,
    lookBack: newestWrong ? await lookBackOf(db, ownerId, spaceId, newestWrong, questionKey) : [],
  };
}

// ── classmate chat context ──────────────────────────────────────────────────

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value;
}

/**
 * The newest wrong answer of an item in this space, bounded to
 * WRONGBOOK_LIMITS.chatContextChars in total. Built on the server from
 * stored rows only; nothing the client sends becomes part of it.
 */
export async function wrongItemChatContext(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  itemId: string,
): Promise<{ context: WrongItemChatContext; stageId?: string; sceneId?: string }> {
  const item = await findItemSpace(db, ownerId, itemId);
  if (item.spaceId !== spaceId) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
  const rows = await readItemRows(db, ownerId, spaceId);
  if (!rows.some((row) => row.id === itemId)) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
  const occurrence = (await readOccurrences(db, ownerId, itemId)).find((candidate) =>
    isWrong(candidate.outcome),
  );
  if (!occurrence) throw new StudyError('STUDY_WRONG_ITEM_NOT_FOUND');
  const { question, response, grading, origin } = occurrence;
  const label = (value: string) => {
    const option = question.options.find((candidate) => candidate.value === value);
    return option ? `${value}. ${option.label}` : value;
  };
  const studentAnswer =
    response === null
      ? '（未作答）'
      : 'choices' in response
        ? response.choices.map(label).join('；')
        : [response.text, response.final ? `最终答案：${response.final}` : '']
            .filter(Boolean)
            .join('\n');
  const correctAnswer =
    question.type === 'short_answer'
      ? [question.reference, question.finalAnswer ? `最终答案：${question.finalAnswer}` : '']
          .filter(Boolean)
          .join('\n')
      : question.answer.map(label).join('；');
  const gradingText = [
    `得分 ${occurrence.earned}/${occurrence.points}`,
    ...(grading.criteria ?? []).map(
      (criterion) =>
        `${criterion.text || criterion.id}：${criterion.awarded}/${criterion.points}${criterion.comment ? `（${criterion.comment}）` : ''}`,
    ),
    grading.feedback ?? '',
    ...(grading.shortcomings ?? []).map((item) => `不足：${item}`),
  ]
    .filter(Boolean)
    .join('\n');
  const where =
    occurrence.sourceType === 'exam_attempt'
      ? `学科试卷《${origin.paperTitle ?? ''}》第 ${origin.position ?? '?'} 题`
      : occurrence.sourceType === 'quiz_attempt'
        ? `课堂《${origin.courseTitle ?? ''}》的小测`
        : `课堂《${origin.courseTitle ?? ''}》的学习检测`;
  const budget = WRONGBOOK_LIMITS.chatContextChars;
  const context: WrongItemChatContext = {
    itemId,
    sourceType: occurrence.sourceType,
    questionType:
      question.type === 'short_answer'
        ? question.subtype === 'calculation'
          ? '计算题'
          : question.subtype === 'proof'
            ? '证明题'
            : '简答题'
        : question.type === 'multiple'
          ? '多选题'
          : '单选题',
    question: clip(question.stem, Math.floor(budget * 0.3)),
    ...(question.options.length
      ? {
          options: question.options.map((option) => clip(`${option.value}. ${option.label}`, 160)),
        }
      : {}),
    studentAnswer: clip(studentAnswer, Math.floor(budget * 0.2)),
    ...(correctAnswer ? { correctAnswer: clip(correctAnswer, Math.floor(budget * 0.15)) } : {}),
    ...(question.explanation
      ? { explanation: clip(question.explanation, Math.floor(budget * 0.15)) }
      : {}),
    grading: clip(gradingText, Math.floor(budget * 0.15)),
    ...(question.concepts.length ? { concepts: question.concepts.slice(0, 5) } : {}),
    where,
  };
  return {
    context,
    ...(origin.stageId ? { stageId: origin.stageId } : {}),
    ...(origin.stageId && origin.sceneId ? { sceneId: origin.sceneId } : {}),
  };
}
