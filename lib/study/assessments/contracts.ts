/**
 * Papers, attempts and objective grading (learning plan B07). Pure — no
 * Next.js, browser store or database imports.
 *
 * - A paper is frozen when it is published: every item keeps its own copy of
 *   the question (stem, options, points, knowledge points, source) and of the
 *   answer key, so editing or deleting bank questions later never changes it.
 * - Before submission the student only ever receives `PaperItemView` (built
 *   field by field, never a stored row), so no answer, explanation or key
 *   leaves the server while an attempt is open.
 * - Grading runs on the server against the frozen key, reusing the classroom
 *   quiz's choice comparison, after checking that the key and the answer are
 *   well formed (an empty key never matches an empty answer).
 */
import { arraysEqual } from '@/lib/quiz/grading';
import type {
  QuestionOption,
  QuestionOrigin,
  QuestionType,
  VerificationState,
} from '@/lib/study/questions/contracts';

export const ATTEMPT_LIMITS = {
  /** Draft saves are small; the key is the item's position. */
  answersBytes: 12_000,
  submitKey: 100,
  papersListed: 50,
} as const;

export const GRADING_VERSION = 'objective-v1';

/** What the student sees of one item before submitting. */
export interface PaperItemView {
  /** 1-based position; also the key of the item's answer. */
  position: number;
  type: QuestionType;
  stem: string;
  options: QuestionOption[];
  points: number;
  concepts: string[];
  source: PaperItemSource;
}

/** Where a frozen item came from, for attribution (official packs carry their licence). */
export interface PaperItemSource {
  origin: QuestionOrigin;
  verification: VerificationState;
  title?: string;
  page?: string;
  url?: string;
  license?: string;
  attribution?: string;
  packTitle?: string;
}

/** The frozen key of one item; stored apart from the view. */
export interface PaperItemKey {
  answer: string[];
  explanation: string | null;
}

export type AttemptAnswers = Record<string, string[]>;

export interface PaperSummary {
  id: string;
  spaceId: string;
  title: string;
  itemCount: number;
  totalPoints: number;
  createdAt: string;
  attempts: AttemptSummary[];
}

export interface AttemptSummary {
  id: string;
  status: 'in_progress' | 'submitted';
  startedAt: string;
  submittedAt: string | null;
  earned: number | null;
  totalPoints: number | null;
}

export type ItemOutcome = 'correct' | 'incorrect' | 'unanswered' | 'ungradable';

export interface ItemResult {
  position: number;
  outcome: ItemOutcome;
  earned: number;
  points: number;
}

export interface AttemptGrading {
  version: typeof GRADING_VERSION;
  items: ItemResult[];
  earned: number;
  /** Points of gradable items. */
  totalPoints: number;
  correct: number;
  unanswered: number;
  ungradable: number;
}

/** One item of a submitted attempt's report (now with the key). */
export interface ReportItem extends PaperItemView, PaperItemKey {
  response: string[];
  outcome: ItemOutcome;
  earned: number;
}

export interface AttemptView {
  id: string;
  paperId: string;
  spaceId: string;
  title: string;
  status: 'in_progress' | 'submitted';
  revision: number;
  answers: AttemptAnswers;
  startedAt: string;
  updatedAt: string;
  submittedAt: string | null;
  /** Before submission: the items without keys. */
  items: PaperItemView[];
  /** After submission only. */
  report: { grading: AttemptGrading; items: ReportItem[] } | null;
}

// ── views (allowlists) ──────────────────────────────────────────────────────

/** Copy only the fields a student may see before submitting. */
export function toItemView(position: number, snapshot: Record<string, unknown>): PaperItemView {
  const source = (snapshot.source ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    position,
    type: snapshot.type === 'multiple' ? 'multiple' : 'single',
    stem: String(snapshot.stem ?? ''),
    options: Array.isArray(snapshot.options)
      ? (snapshot.options as Array<Record<string, unknown>>).map((option) => ({
          value: String(option.value ?? ''),
          label: String(option.label ?? ''),
        }))
      : [],
    points: Number(snapshot.points ?? 1),
    concepts: Array.isArray(snapshot.concepts) ? snapshot.concepts.map(String) : [],
    source: {
      origin: (text(source.origin) ?? 'user_import') as QuestionOrigin,
      verification: (text(source.verification) ?? 'unverified') as VerificationState,
      ...(text(source.title) ? { title: text(source.title) } : {}),
      ...(text(source.page) ? { page: text(source.page) } : {}),
      ...(text(source.url) ? { url: text(source.url) } : {}),
      ...(text(source.license) ? { license: text(source.license) } : {}),
      ...(text(source.attribution) ? { attribution: text(source.attribution) } : {}),
      ...(text(source.packTitle) ? { packTitle: text(source.packTitle) } : {}),
    },
  };
}

// ── answers ─────────────────────────────────────────────────────────────────

/**
 * Validate a draft or submitted answer set against the paper: only known
 * positions, only the item's option values, no repeats, one value for a
 * single-choice item. Empty selections are dropped (unanswered).
 */
export function parseAnswers(
  raw: unknown,
  items: readonly Pick<PaperItemView, 'position' | 'type' | 'options'>[],
): AttemptAnswers | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const byPosition = new Map(items.map((item) => [String(item.position), item]));
  const answers: AttemptAnswers = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const item = byPosition.get(key);
    if (!item || !Array.isArray(value)) return null;
    if (!value.every((entry) => typeof entry === 'string')) return null;
    const values = value as string[];
    if (values.length === 0) continue;
    if (new Set(values).size !== values.length) return null;
    const allowed = new Set(item.options.map((option) => option.value));
    if (!values.every((entry) => allowed.has(entry))) return null;
    if (item.type === 'single' && values.length !== 1) return null;
    answers[key] = [...values].sort();
  }
  return answers;
}

/** Canonical text of an answer set, hashed into the submission digest. */
export function canonicalAnswers(answers: AttemptAnswers): string {
  return JSON.stringify(
    Object.keys(answers)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => [key, [...answers[key]!].sort()]),
  );
}

// ── grading ─────────────────────────────────────────────────────────────────

/** A key the program can grade: non-empty, unique, among the options, one value for single. */
export function isUsableKey(
  item: Pick<PaperItemView, 'type' | 'options'>,
  answer: readonly string[],
): boolean {
  if (answer.length === 0 || new Set(answer).size !== answer.length) return false;
  const values = new Set(item.options.map((option) => option.value));
  if (values.size !== item.options.length) return false;
  if (!answer.every((value) => values.has(value))) return false;
  return item.type !== 'single' || answer.length === 1;
}

export function gradeItem(
  item: Pick<PaperItemView, 'position' | 'type' | 'options' | 'points'>,
  key: readonly string[],
  response: readonly string[] | undefined,
): ItemResult {
  const base = { position: item.position, points: item.points };
  if (!isUsableKey(item, key)) return { ...base, outcome: 'ungradable', earned: 0 };
  if (!response || response.length === 0) return { ...base, outcome: 'unanswered', earned: 0 };
  const values = new Set(item.options.map((option) => option.value));
  const wellFormed =
    new Set(response).size === response.length &&
    response.every((value) => values.has(value)) &&
    (item.type !== 'single' || response.length === 1);
  const correct = wellFormed && arraysEqual([...response], [...key]);
  return { ...base, outcome: correct ? 'correct' : 'incorrect', earned: correct ? item.points : 0 };
}

/** Whole-attempt grading. Multiple choice is all-or-nothing, as in the classroom quiz. */
export function gradeAttempt(
  items: ReadonlyArray<
    Pick<PaperItemView, 'position' | 'type' | 'options' | 'points'> & { key: readonly string[] }
  >,
  answers: AttemptAnswers,
): AttemptGrading {
  const results = items.map((item) => gradeItem(item, item.key, answers[String(item.position)]));
  const gradable = results.filter((result) => result.outcome !== 'ungradable');
  return {
    version: GRADING_VERSION,
    items: results,
    earned: results.reduce((sum, result) => sum + result.earned, 0),
    totalPoints: gradable.reduce((sum, result) => sum + result.points, 0),
    correct: results.filter((result) => result.outcome === 'correct').length,
    unanswered: results.filter((result) => result.outcome === 'unanswered').length,
    ungradable: results.length - gradable.length,
  };
}

// ── ids ─────────────────────────────────────────────────────────────────────

export function isPaperId(value: unknown): value is string {
  return typeof value === 'string' && /^paper-[A-Za-z0-9_-]{12}$/.test(value);
}

export function isAttemptId(value: unknown): value is string {
  return typeof value === 'string' && /^att-[A-Za-z0-9_-]{12}$/.test(value);
}

/** Client-made idempotency keys (publishing a paper, submitting an attempt). */
export function isRequestKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
}
