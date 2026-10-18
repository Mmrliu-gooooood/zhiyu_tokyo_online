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
 * - Open questions (B09) are answered in text. Submitting freezes the
 *   answers as before; each answered open item then waits for its own
 *   grading record (see the grading section below), so choice items are
 *   scored at once and open items join the report as they are graded.
 */
import { arraysEqual } from '@/lib/quiz/grading';
import type { AttemptAssistanceView } from '@/lib/study/practice/contracts';
import {
  readGenerationRef,
  type GenerationSourceRef,
  type GradingGuide,
  type MaterialSourceRef,
  type OpenSubtype,
  type QuestionFigure,
  type QuestionOption,
  type QuestionOrigin,
  type QuestionType,
  type VerificationState,
} from '@/lib/study/questions/contracts';

export const ATTEMPT_LIMITS = {
  /** Serialized answers of one attempt (open answers make this larger than B07's 12 KB). */
  answersBytes: 100_000,
  /** Request bodies that carry answers (the answers plus a little envelope). */
  answersRequestBytes: 101_000,
  /** One open answer's text and a calculation's final answer. */
  openText: 3000,
  finalText: 200,
  submitKey: 100,
  papersListed: 50,
} as const;

export const GRADING_VERSION = 'objective-v1';
/** Papers with open questions: choice items as in objective-v1, open items `pending` until graded. */
export const MIXED_GRADING_VERSION = 'mixed-v1';

/** What the student sees of one item before submitting. */
export interface PaperItemView {
  /** 1-based position; also the key of the item's answer. */
  position: number;
  type: QuestionType;
  /** Open questions only. */
  subtype?: OpenSubtype;
  stem: string;
  options: QuestionOption[];
  points: number;
  concepts: string[];
  source: PaperItemSource;
  /** Figures of an extracted question (material images, read through the material APIs). */
  figures: QuestionFigure[];
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
  licenseStatus?: 'clear' | 'unclear';
  answerBasis?: 'source' | 'model';
  material?: MaterialSourceRef;
  /** Written by AI practice (B11): reviewed by AI, not checked by a person. */
  generation?: GenerationSourceRef;
}

/** The frozen key of one item; stored apart from the view. */
export interface PaperItemKey {
  answer: string[];
  explanation: string | null;
  /** Open questions: what they are graded against, with the scoring points made explicit. */
  guide: GradingGuide | null;
}

/** The answer to an open question: the working, and a calculation's final answer. */
export interface OpenAnswer {
  text: string;
  final?: string;
}

/** Option values for a choice item, text for an open one. */
export type ItemAnswer = string[] | OpenAnswer;

export type AttemptAnswers = Record<string, ItemAnswer>;

export function isOpenAnswer(answer: ItemAnswer | undefined): answer is OpenAnswer {
  return answer !== undefined && !Array.isArray(answer);
}

export function hasAnswer(answer: ItemAnswer | undefined): boolean {
  if (answer === undefined) return false;
  return Array.isArray(answer) ? answer.length > 0 : Boolean(answer.text || answer.final);
}

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
  /** Including open items graded so far. */
  earned: number | null;
  totalPoints: number | null;
  /** Open items still waiting for (or failed) grading. */
  ungraded: number;
}

/**
 * `pending`: an answered open item waiting for its grading; `partial`: an
 * open item that earned some of its points.
 */
export type ItemOutcome =
  | 'correct'
  | 'incorrect'
  | 'partial'
  | 'unanswered'
  | 'ungradable'
  | 'pending';

export interface ItemResult {
  position: number;
  outcome: ItemOutcome;
  earned: number;
  points: number;
}

/** Frozen at submission: choice items graded, answered open items `pending`. */
export interface AttemptGrading {
  version: typeof GRADING_VERSION | typeof MIXED_GRADING_VERSION;
  items: ItemResult[];
  /** Points earned at submission (choice items). */
  earned: number;
  /** Points of gradable items (open items included). */
  totalPoints: number;
  correct: number;
  unanswered: number;
  ungradable: number;
  /** Answered open items handed to grading (mixed-v1). */
  pending?: number;
}

// ── open-item grading records ───────────────────────────────────────────────

/** `auto`: the grading made after submission; `review`: one the student asked for again; `self`: the student's own score. */
export type GradingKind = 'auto' | 'review' | 'self';
export type GradingStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** How one scoring point was decided. */
export interface CriterionResult {
  id: string;
  awarded: number;
  points: number;
  /** `program`: the final answer was compared by the program; `model`: judged by the model. */
  by: 'program' | 'model';
  comment: string;
}

/** What a succeeded grading stored (validated by the program before it was saved). */
export interface GradingResult {
  criteria: CriterionResult[];
  feedback: string;
  shortcomings: string[];
  /** For a calculation's final answer: what the program concluded. */
  finalCheck: 'equal' | 'not_equal' | 'unknown' | 'missing' | null;
}

export interface ItemGradingView {
  seq: number;
  kind: GradingKind;
  status: GradingStatus;
  earned: number | null;
  points: number;
  result: GradingResult | null;
  /** Grader version, model and program that produced the result. */
  grader: { version: string; model: string | null; program: string | null } | null;
  error: string | null;
  /** The student's note with a self score. */
  note: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** The report's totals with the gradings so far (choice items + the latest grading of each open item). */
export interface ReportSummary {
  earned: number;
  totalPoints: number;
  correct: number;
  unanswered: number;
  ungradable: number;
  /** Open items waiting or being graded. */
  pending: number;
  /** Open items whose latest grading failed (they can be retried). */
  failed: number;
  state: 'complete' | 'grading' | 'partial';
  /** The student's own scores where given, counted with the official score of the rest. */
  selfEarned: number | null;
}

/** One item of a submitted attempt's report (now with the key). */
export interface ReportItem extends PaperItemView, PaperItemKey {
  /** Choice items: the options chosen. */
  response: string[];
  /** Open items: the text answer. */
  openResponse: OpenAnswer | null;
  outcome: ItemOutcome;
  earned: number;
  /** Open items: every grading, oldest first (earlier ones are kept when a review is asked for). */
  gradings: ItemGradingView[];
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
  report: { grading: AttemptGrading; summary: ReportSummary; items: ReportItem[] } | null;
  /** Novelty per item, and hints/solutions of practice papers (B11). */
  assistance?: AttemptAssistanceView;
}

// ── views (allowlists) ──────────────────────────────────────────────────────

/** Copy only the fields a student may see before submitting. */
export function toItemView(position: number, snapshot: Record<string, unknown>): PaperItemView {
  const source = (snapshot.source ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const type: QuestionType =
    snapshot.type === 'multiple'
      ? 'multiple'
      : snapshot.type === 'short_answer'
        ? 'short_answer'
        : 'single';
  return {
    position,
    type,
    ...(type === 'short_answer'
      ? {
          subtype:
            snapshot.subtype === 'calculation' || snapshot.subtype === 'proof'
              ? snapshot.subtype
              : ('short' as const),
        }
      : {}),
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
      ...(source.licenseStatus === 'clear' || source.licenseStatus === 'unclear'
        ? { licenseStatus: source.licenseStatus }
        : {}),
      ...(source.answerBasis === 'source' || source.answerBasis === 'model'
        ? { answerBasis: source.answerBasis }
        : {}),
      ...(materialRef(source.material) ? { material: materialRef(source.material)! } : {}),
      ...(readGenerationRef(source.generation)
        ? { generation: readGenerationRef(source.generation)! }
        : {}),
    },
    figures: Array.isArray(snapshot.figures)
      ? (snapshot.figures as Array<Record<string, unknown>>).flatMap((figure) =>
          [figure.materialId, figure.versionId, figure.artifactId, figure.imageId].every(
            (part) => typeof part === 'string',
          )
            ? [
                {
                  materialId: String(figure.materialId),
                  versionId: String(figure.versionId),
                  artifactId: String(figure.artifactId),
                  imageId: String(figure.imageId),
                },
              ]
            : [],
        )
      : [],
  };
}

function materialRef(value: unknown): MaterialSourceRef | null {
  if (!value || typeof value !== 'object') return null;
  const ref = value as Record<string, unknown>;
  if (
    typeof ref.materialId !== 'string' ||
    typeof ref.versionId !== 'string' ||
    typeof ref.artifactId !== 'string'
  ) {
    return null;
  }
  return {
    materialId: ref.materialId,
    versionId: ref.versionId,
    versionNo: Number(ref.versionNo ?? 0),
    artifactId: ref.artifactId,
    pages: Array.isArray(ref.pages) ? ref.pages.map(Number).filter(Number.isInteger) : [],
    label: typeof ref.label === 'string' ? ref.label : null,
  };
}

// ── answers ─────────────────────────────────────────────────────────────────

/** Text Postgres can store, line endings unified; outer spaces of the final answer trimmed. */
function answerText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
  return text.length > max ? null : text;
}

function parseOpenAnswer(value: unknown, subtype: OpenSubtype | undefined): OpenAnswer | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = answerText(record.text ?? '', ATTEMPT_LIMITS.openText);
  if (text === null) return null;
  if (record.final === undefined || record.final === null) return { text };
  // Only calculations have a final-answer field.
  if (subtype !== 'calculation') return null;
  const final = answerText(record.final, ATTEMPT_LIMITS.finalText);
  if (final === null) return null;
  return final.trim() ? { text, final: final.trim() } : { text };
}

/**
 * Validate a draft or submitted answer set against the paper: only known
 * positions, only the item's option values, no repeats, one value for a
 * single-choice item; open items take `{ text, final? }` within the length
 * limits. Empty selections and blank texts are dropped (unanswered).
 */
export function parseAnswers(
  raw: unknown,
  items: readonly Pick<PaperItemView, 'position' | 'type' | 'options' | 'subtype'>[],
): AttemptAnswers | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const byPosition = new Map(items.map((item) => [String(item.position), item]));
  const answers: AttemptAnswers = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const item = byPosition.get(key);
    if (!item) return null;
    if (item.type === 'short_answer') {
      const open = parseOpenAnswer(value, item.subtype);
      if (!open) return null;
      if (open.text.trim() || open.final) answers[key] = open;
      continue;
    }
    if (!Array.isArray(value)) return null;
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
      .map((key) => {
        const answer = answers[key]!;
        return [
          key,
          Array.isArray(answer) ? [...answer].sort() : [answer.text, answer.final ?? ''],
        ];
      }),
  );
}

/** Serialized size of an answer set as stored (the database limits it). */
export function answersByteLength(answers: AttemptAnswers): number {
  return new TextEncoder().encode(JSON.stringify(answers)).length;
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
  answer: ItemAnswer | undefined,
  guide: GradingGuide | null = null,
): ItemResult {
  const base = { position: item.position, points: item.points };
  if (item.type === 'short_answer') {
    // Open items are graded afterwards against their guide; blank ones score nothing.
    if (!guide) return { ...base, outcome: 'ungradable', earned: 0 };
    return { ...base, outcome: hasAnswer(answer) ? 'pending' : 'unanswered', earned: 0 };
  }
  const response = Array.isArray(answer) ? answer : undefined;
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

/**
 * Whole-attempt grading at submission. Multiple choice is all-or-nothing, as
 * in the classroom quiz; answered open items are `pending` (mixed-v1).
 */
export function gradeAttempt(
  items: ReadonlyArray<
    Pick<PaperItemView, 'position' | 'type' | 'options' | 'points'> & {
      key: readonly string[];
      guide?: GradingGuide | null;
    }
  >,
  answers: AttemptAnswers,
): AttemptGrading {
  const results = items.map((item) =>
    gradeItem(item, item.key, answers[String(item.position)], item.guide ?? null),
  );
  const gradable = results.filter((result) => result.outcome !== 'ungradable');
  const mixed = items.some((item) => item.type === 'short_answer');
  return {
    version: mixed ? MIXED_GRADING_VERSION : GRADING_VERSION,
    items: results,
    earned: results.reduce((sum, result) => sum + result.earned, 0),
    totalPoints: gradable.reduce((sum, result) => sum + result.points, 0),
    correct: results.filter((result) => result.outcome === 'correct').length,
    unanswered: results.filter((result) => result.outcome === 'unanswered').length,
    ungradable: results.length - gradable.length,
    ...(mixed ? { pending: results.filter((result) => result.outcome === 'pending').length } : {}),
  };
}

/** The grading that counts for an open item: the newest by the grader (auto or review), not the student's own. */
export function officialGrading(gradings: readonly ItemGradingView[]): ItemGradingView | null {
  for (let index = gradings.length - 1; index >= 0; index -= 1) {
    if (gradings[index]!.kind !== 'self') return gradings[index]!;
  }
  return null;
}

/** The latest succeeded official grading, if any (an earlier result stays valid while a review runs). */
export function scoredGrading(gradings: readonly ItemGradingView[]): ItemGradingView | null {
  for (let index = gradings.length - 1; index >= 0; index -= 1) {
    const grading = gradings[index]!;
    if (grading.kind !== 'self' && grading.status === 'succeeded') return grading;
  }
  return null;
}

export function latestSelfGrading(gradings: readonly ItemGradingView[]): ItemGradingView | null {
  for (let index = gradings.length - 1; index >= 0; index -= 1) {
    if (gradings[index]!.kind === 'self') return gradings[index]!;
  }
  return null;
}

/** Outcome of an open item from its points. */
export function openOutcome(earned: number, points: number): ItemOutcome {
  return earned >= points ? 'correct' : earned > 0 ? 'partial' : 'incorrect';
}

/**
 * Current outcome of each item and the report totals: the frozen grading of
 * choice items plus, for open items, the latest succeeded grading. An item
 * whose latest official grading is waiting, running or failed (and has no
 * earlier score) is `pending`.
 */
export function summarizeReport(
  grading: AttemptGrading,
  gradingsByPosition: ReadonlyMap<number, readonly ItemGradingView[]>,
): { summary: ReportSummary; items: ItemResult[] } {
  let pending = 0;
  let failed = 0;
  let selfEarned: number | null = null;
  const items = grading.items.map((result): ItemResult => {
    if (result.outcome !== 'pending') return result;
    const gradings = gradingsByPosition.get(result.position) ?? [];
    const official = officialGrading(gradings);
    const scored = scoredGrading(gradings);
    if (!scored) {
      if (official?.status === 'failed') failed += 1;
      else pending += 1;
    } else if (official && official !== scored && official.status !== 'failed') {
      // A review the student asked for is under way; the earlier score stands meanwhile.
      pending += 1;
    }
    const self = latestSelfGrading(gradings);
    if (self?.earned !== null && self?.earned !== undefined) {
      selfEarned = (selfEarned ?? 0) + self.earned - (scored?.earned ?? 0);
    }
    if (!scored || scored.earned === null) return result;
    return {
      ...result,
      outcome: openOutcome(scored.earned, result.points),
      earned: scored.earned,
    };
  });
  const earned = items.reduce((sum, item) => sum + item.earned, 0);
  return {
    items,
    summary: {
      earned,
      totalPoints: grading.totalPoints,
      correct: items.filter((item) => item.outcome === 'correct').length,
      unanswered: grading.unanswered,
      ungradable: grading.ungradable,
      pending,
      failed,
      state: pending ? 'grading' : failed ? 'partial' : 'complete',
      selfEarned: selfEarned === null ? null : earned + selfEarned,
    },
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
