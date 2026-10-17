/**
 * The wrong-answer book (learning plan B10): wire contracts shared by the
 * server projection, the APIs and the page. Pure — no Next.js, browser
 * store or database imports.
 *
 * A wrong item is one question the student got wrong in one study space; its
 * occurrences are every graded answer to it, each with the question as it
 * was asked, the answer given and the grading it got. Sources:
 *
 * - `exam_attempt`: a submitted subject paper (B07/B09), graded by the server.
 * - `quiz_attempt`: a classroom quiz (v2 attempts only), graded in the classroom.
 * - `learning_check`: a classroom learning check, graded in the classroom.
 *
 * Items still waiting for (or failing) grading are never wrong.
 */
import type { PaperItemSource } from '@/lib/study/assessments/contracts';
import type { OpenSubtype, QuestionFigure } from '@/lib/study/questions/contracts';

export const WRONG_SOURCE_TYPES = ['exam_attempt', 'quiz_attempt', 'learning_check'] as const;
export type WrongSourceType = (typeof WRONG_SOURCE_TYPES)[number];

export const WRONG_OUTCOMES = ['incorrect', 'partial', 'unanswered', 'correct'] as const;
export type WrongOutcome = (typeof WRONG_OUTCOMES)[number];

export const WRONGBOOK_LIMITS = {
  /** Newest submitted papers of a space read by one sync. */
  examAttempts: 100,
  /** Newest classroom quiz / learning-check attempts of a space's courses read by one sync. */
  classroomAttempts: 300,
  /** Items one space keeps; further new wrong questions are reported, not stored. */
  itemsPerSpace: 3000,
  /** Occurrences one item keeps (newest first is what the page shows). */
  occurrencesPerItem: 50,
  pageSize: 30,
  /** Knowledge points kept per item. */
  concepts: 20,
  conceptChars: 80,
  /** Learning-check evidence carried with a question. */
  evidenceFragments: 3,
  evidenceChars: 1200,
  /** Characters of the question a classmate chat carries as its context. */
  chatContextChars: 3000,
} as const;

/** The question as it was asked, frozen with the answer. */
export interface WrongQuestion {
  type: 'single' | 'multiple' | 'short_answer';
  subtype?: OpenSubtype;
  stem: string;
  options: Array<{ value: string; label: string }>;
  /** Correct option values (choice questions). */
  answer: string[];
  /** Open questions: the reference answer or scoring guide the grading used. */
  reference?: string;
  /** Calculations: the expected final answer. */
  finalAnswer?: string;
  explanation?: string;
  concepts: string[];
  /** Subject papers: where the question came from (B07/B08). */
  source?: PaperItemSource;
  figures?: QuestionFigure[];
  /** Learning checks: the course passages the question was written from, as they were then. */
  evidence?: Array<{ sceneId: string; sceneTitle: string; digest: string; text: string }>;
}

/** What the student answered (null: nothing). */
export type WrongResponse = { choices: string[] } | { text: string; final?: string } | null;

export interface WrongCriterion {
  /** `final` / `overall` (with empty text) are the points the server made when none were written. */
  id: string;
  text: string;
  awarded: number;
  points: number;
  by: 'program' | 'model';
  comment: string;
}

export interface WrongGrading {
  /** `server`: graded by the server (papers); `classroom`: recorded by the classroom page. */
  by: 'server' | 'classroom';
  method: 'answer_key' | 'rubric' | 'model' | 'blank';
  /** Grading rule version (objective-v1, rubric-v1, quiz-grading-v1, learning-scoring-v1). */
  version: string;
  model?: string | null;
  /** Classroom choice answers re-checked against the course as the server stores it. */
  checked?: boolean;
  feedback?: string;
  shortcomings?: string[];
  criteria?: WrongCriterion[];
  /** Subject papers: a newer grading the student asked for replaced an earlier one. */
  reviewed?: boolean;
}

export interface WrongOrigin {
  /** Subject papers. */
  paperId?: string;
  paperTitle?: string;
  attemptId?: string;
  position?: number;
  /** Classroom quizzes and learning checks. */
  stageId?: string;
  sceneId?: string;
  courseTitle?: string;
  /** The quiz snapshot revision or the learning-check course revision. */
  contentRevision?: string;
  checkKind?: 'course_check' | 'remediation_check';
}

/** One graded answer, as a projection produces it. */
export interface WrongEntry {
  questionKey: string;
  sourceType: WrongSourceType;
  sourceKey: string;
  stageId: string | null;
  attemptId: string | null;
  occurredAt: string;
  outcome: WrongOutcome;
  earned: number;
  points: number;
  question: WrongQuestion;
  response: WrongResponse;
  grading: WrongGrading;
  origin: WrongOrigin;
}

// ── views ───────────────────────────────────────────────────────────────────

export type WrongReviewState = 'none' | 'to_review';

export interface WrongItemSummary {
  id: string;
  spaceId: string;
  sourceType: WrongSourceType;
  reviewState: WrongReviewState;
  archived: boolean;
  revision: number;
  concepts: string[];
  wrongCount: number;
  attemptCount: number;
  firstWrongAt: string;
  lastWrongAt: string;
  /** The newest answer (wrong or, after a mistake, right). */
  latest: {
    outcome: WrongOutcome;
    earned: number;
    points: number;
    occurredAt: string;
    origin: WrongOrigin;
  };
  /** The question as it was last asked wrongly. */
  question: Pick<WrongQuestion, 'type' | 'subtype' | 'stem'>;
}

export interface WrongOccurrenceView {
  sourceKey: string;
  sourceType: WrongSourceType;
  occurredAt: string;
  outcome: WrongOutcome;
  earned: number;
  points: number;
  question: WrongQuestion;
  response: WrongResponse;
  grading: WrongGrading;
  origin: WrongOrigin;
}

/** Where "look back" can lead from one occurrence, checked on the server when the item is opened. */
export type WrongLookBack =
  | { kind: 'paper'; attemptId: string; title: string }
  | { kind: 'material'; materialId: string; versionId: string; page: number | null; title: string }
  | { kind: 'material_gone'; title: string }
  /** The classroom page still shows the same content: safe to open. */
  | { kind: 'scene'; stageId: string; sceneId: string; courseTitle: string; sceneTitle: string }
  /** The page changed (or was removed) since: only the frozen copy above is the original. */
  | { kind: 'scene_changed'; stageId: string; courseTitle: string; sceneTitle: string }
  | { kind: 'scene_missing'; courseTitle: string }
  | { kind: 'course_gone' }
  /** A question-bank question linked to a course of this space (its current setting). */
  | { kind: 'course'; stageId: string; courseTitle: string };

export interface WrongItemDetail extends WrongItemSummary {
  occurrences: WrongOccurrenceView[];
  /** For the newest wrong occurrence. */
  lookBack: WrongLookBack[];
}

export interface WrongbookFacets {
  concepts: Array<{ name: string; count: number }>;
  sources: Record<WrongSourceType, number>;
  states: { active: number; toReview: number; archived: number };
  /** Concept-less items ("未关联"). */
  unlinked: number;
}

export interface WrongbookPage {
  items: WrongItemSummary[];
  total: number;
  nextOffset: number | null;
  facets: WrongbookFacets;
}

export interface WrongbookSyncResult {
  ran: boolean;
  /** Occurrences written (new or changed) by this sync. */
  written: number;
  /** Sources that failed (read again on the next sync). */
  failed: WrongSourceType[];
  /** Classroom attempts saved before question snapshots existed: not shown (nothing to show). */
  legacy: number;
  /** The space already holds the maximum number of items. */
  full: boolean;
}

/**
 * What a classmate chat opened from a wrong item carries: a bounded copy of
 * its newest wrong answer, made by the server when the chat opens and kept in
 * the chat's origin (never taken from the client).
 */
export interface WrongItemChatContext {
  itemId: string;
  sourceType: WrongSourceType;
  questionType: string;
  question: string;
  options?: string[];
  studentAnswer: string;
  correctAnswer?: string;
  explanation?: string;
  grading: string;
  concepts?: string[];
  where: string;
}

// ── filters ─────────────────────────────────────────────────────────────────

export type WrongStateFilter = 'active' | 'to_review' | 'archived';
export type WrongSinceFilter = '7d' | '30d' | 'all';

export interface WrongbookFilter {
  state: WrongStateFilter;
  source: WrongSourceType | null;
  /** A knowledge point; '' = items without one. */
  concept: string | null;
  since: WrongSinceFilter;
  offset: number;
}

const STATES: readonly WrongStateFilter[] = ['active', 'to_review', 'archived'];
const SINCE: readonly WrongSinceFilter[] = ['7d', '30d', 'all'];

/** Query parameters → filter; null when a value is not allowed. */
export function parseWrongbookFilter(params: URLSearchParams): WrongbookFilter | null {
  const state = (params.get('state') ?? 'active') as WrongStateFilter;
  const since = (params.get('since') ?? 'all') as WrongSinceFilter;
  const source = params.get('source');
  const concept = params.get('concept');
  const offset = Number(params.get('offset') ?? 0);
  if (!STATES.includes(state) || !SINCE.includes(since)) return null;
  if (source !== null && !(WRONG_SOURCE_TYPES as readonly string[]).includes(source)) return null;
  if (concept !== null && concept.length > WRONGBOOK_LIMITS.conceptChars) return null;
  if (!Number.isInteger(offset) || offset < 0 || offset > WRONGBOOK_LIMITS.itemsPerSpace) {
    return null;
  }
  return {
    state,
    since,
    source: (source as WrongSourceType | null) ?? null,
    concept,
    offset,
  };
}

export function isWrongItemId(value: unknown): value is string {
  return typeof value === 'string' && /^wi-[A-Za-z0-9_-]{12}$/.test(value);
}

/** Whether an outcome is a mistake. */
export function isWrong(outcome: WrongOutcome): boolean {
  return outcome !== 'correct';
}

/** Knowledge points as stored: trimmed, de-duplicated, bounded. */
export function cleanConcepts(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = Array.from(value.replace(/\s+/gu, ' ').trim())
      .slice(0, WRONGBOOK_LIMITS.conceptChars)
      .join('');
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= WRONGBOOK_LIMITS.concepts) break;
  }
  return result;
}
