/**
 * Question bank (learning plan B07): wire contracts, the JSON import schema
 * and content validation shared by the APIs, the import preview and the
 * editor. Pure — no Next.js, browser store or database imports.
 *
 * The import format follows the concepts of IMS QTI / Moodle GIFT (type,
 * options, answer key, feedback, points) so other formats can be mapped onto
 * it later; only JSON is accepted. Choice options use the classroom quiz
 * shape (`{ value: 'A', label }`) so grading and math rendering are shared.
 *
 * Two things stay separate: where a question came from (`origin`) and whether
 * its answer was checked (`verification`). A question without an answer can
 * be kept as a draft but never enters a paper that is graded automatically.
 *
 * Open questions (B09, `short_answer` with a short/calculation/proof
 * subtype) carry a grading guide instead of options and an answer key: a
 * reference answer, a final answer for calculations, and scoring points. One
 * without any of them is a draft for self-checking — nothing makes up a key.
 */

// ── vocabulary ──────────────────────────────────────────────────────────────

/** Choice types graded by the program alone. */
export const OBJECTIVE_TYPES = ['single', 'multiple'] as const;
export type ObjectiveType = (typeof OBJECTIVE_TYPES)[number];

/** Every bank type: the choice types plus open questions graded with assistance (B09). */
export const QUESTION_TYPES = [...OBJECTIVE_TYPES, 'short_answer'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** Kinds of open question; calculations may also have a final answer the program can compare. */
export const OPEN_SUBTYPES = ['short', 'calculation', 'proof'] as const;
export type OpenSubtype = (typeof OPEN_SUBTYPES)[number];

export function isObjectiveType(type: QuestionType): type is ObjectiveType {
  return type === 'single' || type === 'multiple';
}

export const QUESTION_ORIGINS = [
  'user_import',
  'manual',
  'official',
  'public_source',
  'ai_generated',
  'material_extracted',
] as const;
export type QuestionOrigin = (typeof QUESTION_ORIGINS)[number];

/**
 * Whether the answer was checked, independent of origin. `user_verified`:
 * the student confirmed it (in the import preview or the editor);
 * `official_verified`: checked by the maintainer of an official pack.
 * Evidence such as an answer printed in a material or suggested by a model
 * (B08, `source.answerBasis`) or an AI review (B11) never counts as a human
 * check.
 */
export const VERIFICATION_STATES = ['unverified', 'user_verified', 'official_verified'] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const QUESTION_LIMITS = {
  stem: 4000,
  optionLabel: 1000,
  minOptions: 2,
  maxOptions: 8,
  explanation: 4000,
  conceptsPerQuestion: 8,
  conceptName: 40,
  minPoints: 1,
  maxPoints: 100,
  sourceText: 200,
  sourceUrl: 500,
  importItems: 500,
  /** Request bytes of one import (preview or commit). */
  importBytes: 1_000_000,
  /** Request bytes of one question written or edited in the editor. */
  editBytes: 64_000,
  questionsPerSpace: 5000,
  listPage: 50,
  referenceAnswer: 4000,
  finalAnswer: 200,
  rubricCriteria: 10,
  criterionText: 300,
} as const;

export interface QuestionOption {
  /** Selection key: "A", "B", … */
  value: string;
  label: string;
}

/** Where the question text came from; shown with the question and frozen into papers. */
export interface QuestionSource {
  title?: string;
  url?: string;
  /** Printed page or exercise number, as written in the source (never invented). */
  page?: string;
  license?: string;
  attribution?: string;
  /** Public sources (B08): when the student fetched it, and its own version or edition label. */
  retrievedAt?: string;
  version?: string;
  /**
   * Whether the student knows the licence lets them use the questions; a
   * public source with `unclear` stays marked "licence to be confirmed".
   */
  licenseStatus?: 'clear' | 'unclear';
  /** Set when the question was copied from an official pack. */
  pack?: { id: string; version: number; questionId: string };
  /** Set by the server when the question was extracted from a study material (B08). */
  material?: MaterialSourceRef;
  /** Where the answer key came from when it was not written by the student (B08). */
  answerBasis?: 'source' | 'model';
}

/** The material version, file pages and printed number an extracted question came from. */
export interface MaterialSourceRef {
  materialId: string;
  versionId: string;
  versionNo: number;
  artifactId: string;
  /** File page numbers (1-based) the question was read from. */
  pages: number[];
  /** The question number as printed ("3", "例2"); null when there was none. */
  label: string | null;
}

/** A figure of an extracted question: one image of a parsed material version. */
export interface QuestionFigure {
  materialId: string;
  versionId: string;
  artifactId: string;
  imageId: string;
}

/**
 * One scoring point of an open question. `final` marks the point earned by
 * the final answer of a calculation, which the program compares when it can.
 * Server-made points (see effectiveRubric) have empty text.
 */
export interface RubricCriterion {
  id: string;
  text: string;
  points: number;
  final?: boolean;
}

/** What an open question is graded against (never shown before submission). */
export interface GradingGuide {
  referenceAnswer: string | null;
  /** Calculations only: the result as a number or expression (`1/2`, `x^2-1`, `\frac{\sqrt3}{2}`). */
  finalAnswer: string | null;
  /** Empty: graded as a whole against the reference or final answer. */
  rubric: RubricCriterion[];
}

/** The editable content of one question version. */
export interface QuestionContent {
  type: QuestionType;
  /** Open questions only. */
  subtype?: OpenSubtype;
  stem: string;
  /** Choice questions only (open questions have none). */
  options: QuestionOption[];
  /** Option values; empty when the source has no answer (a draft) and for open questions. */
  answer: string[];
  /** Open questions only. */
  guide?: GradingGuide;
  explanation: string | null;
  /** Flat knowledge-point names within the study space. */
  concepts: string[];
  /** 1 (easy) – 5 (hard); null when unknown. */
  difficulty: number | null;
  points: number;
  source: QuestionSource | null;
  /** Figures shown with the stem (extracted questions only; set by the server). */
  figures?: QuestionFigure[];
}

export interface ConceptView {
  id: string;
  name: string;
  questionCount: number;
}

export interface QuestionView extends QuestionContent {
  id: string;
  spaceId: string;
  version: number;
  origin: QuestionOrigin;
  verification: VerificationState;
  /** Whether the program can grade it (complete, consistent answer key). */
  gradable: boolean;
  conceptIds: string[];
  /** The course in this space the question belongs to, if the student linked one. */
  stageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionListResult {
  questions: QuestionView[];
  total: number;
  /** Counts over the whole space (not the filter), for the bank header. */
  counts: { all: number; gradable: number; verified: number; drafts: number };
}

// ── validation ──────────────────────────────────────────────────────────────

/** A problem in one question, located by a path such as `options[2].label`. */
export interface QuestionIssue {
  path: string;
  code:
    | 'not_object'
    | 'type_unsupported'
    | 'stem_missing'
    | 'stem_too_long'
    | 'options_invalid'
    | 'options_too_few'
    | 'options_too_many'
    | 'option_empty'
    | 'option_too_long'
    | 'option_duplicate'
    | 'answer_invalid'
    | 'answer_not_in_options'
    | 'answer_duplicate'
    | 'answer_single_needs_one'
    | 'answer_missing'
    | 'explanation_too_long'
    | 'concepts_invalid'
    | 'difficulty_invalid'
    | 'points_invalid'
    | 'source_invalid'
    | 'verified_invalid'
    | 'subtype_invalid'
    | 'options_not_allowed'
    | 'reference_too_long'
    | 'final_answer_invalid'
    | 'rubric_invalid'
    | 'rubric_points_mismatch'
    | 'guide_missing';
}

/**
 * Warnings never block saving; `answer_missing` (choice) and `guide_missing`
 * (open question without reference answer, final answer or scoring points)
 * make the question a draft.
 */
export const WARNING_CODES: ReadonlySet<QuestionIssue['code']> = new Set([
  'answer_missing',
  'guide_missing',
]);

/**
 * Stored text keeps what the student wrote (full-width Chinese punctuation
 * included); only line endings and outer spaces are tidied. Width folding
 * (NFKC) is for comparison keys only.
 */
export function normalizeText(value: string): string {
  return cleanText(value.replace(/\r\n?/g, '\n')).trim();
}

/**
 * Text Postgres can store in jsonb: NUL is dropped (PDF text layers without a
 * Unicode map produce it), other control characters become spaces, and lone
 * surrogates become U+FFFD. Tabs and line breaks are kept.
 */
export function cleanText(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/** An option letter or answer as written ("ａ", "Ａ", "a" → "A"). */
function letterKey(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase();
}

/** Comparison key of a concept name (case, width and spacing folded). */
export function conceptKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

const OPTION_KEYS = 'ABCDEFGH';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? normalizeText(value) : undefined;
}

/**
 * Options as written in an import file: `["…", "…"]` (keys A, B, … in order),
 * `[{ value|key, label|text }]` or `{ "A": "…", "B": "…" }`.
 */
function readOptions(raw: unknown, issues: QuestionIssue[]): QuestionOption[] {
  let entries: Array<[string | undefined, unknown]>;
  if (Array.isArray(raw)) {
    entries = raw.map((entry, index) =>
      isRecord(entry)
        ? [
            typeof (entry.value ?? entry.key) === 'string'
              ? letterKey(String(entry.value ?? entry.key))
              : undefined,
            entry.label ?? entry.text,
          ]
        : [OPTION_KEYS[index], entry],
    );
  } else if (isRecord(raw)) {
    entries = Object.entries(raw).map(([key, label]) => [letterKey(key), label]);
  } else {
    issues.push({ path: 'options', code: 'options_invalid' });
    return [];
  }
  const options: QuestionOption[] = [];
  entries.forEach(([value, label], index) => {
    const text = str(label);
    if (!value || !/^[A-Z]$/.test(value)) {
      issues.push({ path: `options[${index}]`, code: 'options_invalid' });
    } else if (!text) {
      issues.push({ path: `options[${index}].label`, code: 'option_empty' });
    } else if (text.length > QUESTION_LIMITS.optionLabel) {
      issues.push({ path: `options[${index}].label`, code: 'option_too_long' });
    } else {
      options.push({ value, label: text });
      return;
    }
    // Keep the slot so later answers still refer to the right letters.
    if (value && /^[A-Z]$/.test(value)) options.push({ value, label: text ?? '' });
  });
  return options;
}

/** Answer as written: `["A","C"]`, `"A"`, `"AC"` or `"A,C"`. */
function readAnswer(raw: unknown, issues: QuestionIssue[]): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw === 'string') {
    const text = letterKey(raw);
    return text.includes(',') || text.includes('，') || text.includes(' ')
      ? text.split(/[,，\s]+/).filter(Boolean)
      : [...text];
  }
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    return raw.map((entry) => letterKey(entry)).filter(Boolean);
  }
  issues.push({ path: 'answer', code: 'answer_invalid' });
  return [];
}

function readSource(raw: unknown, issues: QuestionIssue[]): QuestionSource | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    issues.push({ path: 'source', code: 'source_invalid' });
    return null;
  }
  const source: QuestionSource = {};
  for (const key of ['title', 'page', 'license', 'attribution'] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === 'number' ? String(value) : str(value);
    if (!text || text.length > QUESTION_LIMITS.sourceText) {
      issues.push({ path: `source.${key}`, code: 'source_invalid' });
      continue;
    }
    source[key] = text;
  }
  if (raw.url !== undefined && raw.url !== null) {
    const url = str(raw.url);
    if (!url || url.length > QUESTION_LIMITS.sourceUrl || !/^https?:\/\//i.test(url)) {
      issues.push({ path: 'source.url', code: 'source_invalid' });
    } else {
      source.url = url;
    }
  }
  if (raw.version !== undefined && raw.version !== null) {
    const version = typeof raw.version === 'number' ? String(raw.version) : str(raw.version);
    if (!version || version.length > QUESTION_LIMITS.sourceText) {
      issues.push({ path: 'source.version', code: 'source_invalid' });
    } else {
      source.version = version;
    }
  }
  if (raw.retrievedAt !== undefined && raw.retrievedAt !== null) {
    const date = str(raw.retrievedAt);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
      issues.push({ path: 'source.retrievedAt', code: 'source_invalid' });
    } else {
      source.retrievedAt = date;
    }
  }
  if (raw.licenseStatus !== undefined && raw.licenseStatus !== null) {
    if (raw.licenseStatus === 'clear' || raw.licenseStatus === 'unclear') {
      source.licenseStatus = raw.licenseStatus;
    } else {
      issues.push({ path: 'source.licenseStatus', code: 'source_invalid' });
    }
  }
  // `pack`, `material` and `answerBasis` are set by the server, never read from files.
  return Object.keys(source).length ? source : null;
}

/** Type (or subtype) names an import file may use for open questions. */
const OPEN_TYPE_NAMES: Record<string, OpenSubtype | undefined> = {
  short_answer: 'short',
  short: 'short',
  open: 'short',
  essay: 'short',
  subjective: 'short',
  简答: 'short',
  简答题: 'short',
  calculation: 'calculation',
  计算: 'calculation',
  计算题: 'calculation',
  proof: 'proof',
  证明: 'proof',
  证明题: 'proof',
};

/**
 * The grading guide of an open question as written in a file or sent by the
 * editor: `referenceAnswer` (or a text `answer`), `finalAnswer` and
 * `rubric: [{ text|description, points|score, final? }]`.
 */
function readGuide(raw: Record<string, unknown>, issues: QuestionIssue[]): GradingGuide {
  const guideRaw = isRecord(raw.guide) ? raw.guide : raw;
  const referenceRaw =
    guideRaw.referenceAnswer ??
    (typeof raw.answer === 'string' || typeof raw.answer === 'number' ? raw.answer : undefined);
  const referenceAnswer =
    (typeof referenceRaw === 'number' ? String(referenceRaw) : str(referenceRaw)) || null;
  if (
    referenceRaw !== undefined &&
    referenceRaw !== null &&
    typeof referenceRaw !== 'string' &&
    typeof referenceRaw !== 'number'
  ) {
    issues.push({ path: 'guide.referenceAnswer', code: 'answer_invalid' });
  }
  const finalRaw = guideRaw.finalAnswer;
  const finalAnswer =
    typeof finalRaw === 'number' ? String(finalRaw) : str(finalRaw)?.replace(/\s+/g, ' ') || null;
  const rubric: RubricCriterion[] = [];
  const rubricRaw = guideRaw.rubric;
  if (rubricRaw !== undefined && rubricRaw !== null) {
    if (!Array.isArray(rubricRaw)) {
      issues.push({ path: 'guide.rubric', code: 'rubric_invalid' });
    } else {
      rubricRaw.forEach((entry, index) => {
        if (!isRecord(entry)) {
          issues.push({ path: `guide.rubric[${index}]`, code: 'rubric_invalid' });
          return;
        }
        const final = entry.final === true;
        const points = entry.points ?? entry.score;
        rubric.push({
          id:
            typeof entry.id === 'string' && /^[a-z0-9_-]{1,16}$/.test(entry.id)
              ? entry.id
              : final
                ? 'final'
                : `c${index + 1}`,
          text: str(entry.text ?? entry.description ?? entry.criterion) ?? '',
          points: typeof points === 'number' ? points : Number.NaN,
          ...(final ? { final: true } : {}),
        });
      });
    }
  }
  return { referenceAnswer, finalAnswer, rubric };
}

/** Import-time source details the student enters for a whole file (B08 public sources). */
export function parseSourceDetails(raw: unknown): {
  source: QuestionSource | null;
  issues: QuestionIssue[];
} {
  const issues: QuestionIssue[] = [];
  const source = readSource(raw, issues);
  return { source, issues };
}

/**
 * Consistency of a question's content (also run on every edit and on
 * official packs). The returned issues include the `answer_missing` warning.
 */
export function validateQuestionContent(content: QuestionContent): QuestionIssue[] {
  const issues: QuestionIssue[] = [];
  if (!(QUESTION_TYPES as readonly string[]).includes(content.type)) {
    issues.push({ path: 'type', code: 'type_unsupported' });
  }
  if (!content.stem) issues.push({ path: 'stem', code: 'stem_missing' });
  else if (content.stem.length > QUESTION_LIMITS.stem) {
    issues.push({ path: 'stem', code: 'stem_too_long' });
  }
  if (content.type === 'short_answer') validateOpen(content, issues);
  else validateChoice(content, issues);
  validateMetadata(content, issues);
  return issues;
}

function validateChoice(content: QuestionContent, issues: QuestionIssue[]): void {
  if (content.options.length < QUESTION_LIMITS.minOptions) {
    issues.push({ path: 'options', code: 'options_too_few' });
  } else if (content.options.length > QUESTION_LIMITS.maxOptions) {
    issues.push({ path: 'options', code: 'options_too_many' });
  }
  const values = new Set<string>();
  const labels = new Set<string>();
  content.options.forEach((option, index) => {
    if (!/^[A-Z]$/.test(option.value)) {
      issues.push({ path: `options[${index}]`, code: 'options_invalid' });
    }
    if (!option.label) issues.push({ path: `options[${index}].label`, code: 'option_empty' });
    else if (option.label.length > QUESTION_LIMITS.optionLabel) {
      issues.push({ path: `options[${index}].label`, code: 'option_too_long' });
    }
    const labelKey = option.label.toLowerCase();
    if (values.has(option.value) || (option.label && labels.has(labelKey))) {
      issues.push({ path: `options[${index}]`, code: 'option_duplicate' });
    }
    values.add(option.value);
    labels.add(labelKey);
  });
  if (content.answer.length === 0) {
    issues.push({ path: 'answer', code: 'answer_missing' });
  } else {
    if (new Set(content.answer).size !== content.answer.length) {
      issues.push({ path: 'answer', code: 'answer_duplicate' });
    }
    if (content.answer.some((value) => !values.has(value))) {
      issues.push({ path: 'answer', code: 'answer_not_in_options' });
    }
    if (content.type === 'single' && content.answer.length !== 1) {
      issues.push({ path: 'answer', code: 'answer_single_needs_one' });
    }
  }
  if (content.subtype !== undefined || content.guide !== undefined) {
    issues.push({ path: 'subtype', code: 'subtype_invalid' });
  }
}

/** Open questions: no options or key; the guide must be consistent, and its points add up. */
function validateOpen(content: QuestionContent, issues: QuestionIssue[]): void {
  if (!content.subtype || !(OPEN_SUBTYPES as readonly string[]).includes(content.subtype)) {
    issues.push({ path: 'subtype', code: 'subtype_invalid' });
  }
  if (content.options.length) issues.push({ path: 'options', code: 'options_not_allowed' });
  if (content.answer.length) issues.push({ path: 'answer', code: 'options_not_allowed' });
  const guide = content.guide ?? { referenceAnswer: null, finalAnswer: null, rubric: [] };
  if (guide.referenceAnswer && guide.referenceAnswer.length > QUESTION_LIMITS.referenceAnswer) {
    issues.push({ path: 'guide.referenceAnswer', code: 'reference_too_long' });
  }
  if (
    guide.finalAnswer !== null &&
    (!guide.finalAnswer ||
      guide.finalAnswer.length > QUESTION_LIMITS.finalAnswer ||
      content.subtype !== 'calculation')
  ) {
    issues.push({ path: 'guide.finalAnswer', code: 'final_answer_invalid' });
  }
  const rubric = guide.rubric;
  if (rubric.length > QUESTION_LIMITS.rubricCriteria) {
    issues.push({ path: 'guide.rubric', code: 'rubric_invalid' });
  }
  const ids = new Set<string>();
  let finals = 0;
  rubric.forEach((criterion, index) => {
    const path = `guide.rubric[${index}]`;
    if (!/^[a-z0-9_-]{1,16}$/.test(criterion.id) || ids.has(criterion.id)) {
      issues.push({ path, code: 'rubric_invalid' });
    }
    ids.add(criterion.id);
    if (criterion.final) finals += 1;
    else if (!criterion.text) issues.push({ path: `${path}.text`, code: 'rubric_invalid' });
    if (criterion.text.length > QUESTION_LIMITS.criterionText) {
      issues.push({ path: `${path}.text`, code: 'rubric_invalid' });
    }
    if (
      !Number.isInteger(criterion.points) ||
      criterion.points < 1 ||
      criterion.points > QUESTION_LIMITS.maxPoints
    ) {
      issues.push({ path: `${path}.points`, code: 'rubric_invalid' });
    }
  });
  if (finals > 1 || (finals === 1 && !guide.finalAnswer)) {
    issues.push({ path: 'guide.rubric', code: 'rubric_invalid' });
  }
  if (
    rubric.length &&
    rubric.reduce((sum, criterion) => sum + criterion.points, 0) !== content.points
  ) {
    issues.push({ path: 'guide.rubric', code: 'rubric_points_mismatch' });
  }
  if (!guide.referenceAnswer && !guide.finalAnswer && rubric.length === 0) {
    issues.push({ path: 'guide', code: 'guide_missing' });
  }
}

function validateMetadata(content: QuestionContent, issues: QuestionIssue[]): void {
  if (content.explanation && content.explanation.length > QUESTION_LIMITS.explanation) {
    issues.push({ path: 'explanation', code: 'explanation_too_long' });
  }
  if (
    content.concepts.length > QUESTION_LIMITS.conceptsPerQuestion ||
    content.concepts.some((name) => !name || name.length > QUESTION_LIMITS.conceptName)
  ) {
    issues.push({ path: 'concepts', code: 'concepts_invalid' });
  }
  if (
    content.difficulty !== null &&
    !(Number.isInteger(content.difficulty) && content.difficulty >= 1 && content.difficulty <= 5)
  ) {
    issues.push({ path: 'difficulty', code: 'difficulty_invalid' });
  }
  if (
    !Number.isInteger(content.points) ||
    content.points < QUESTION_LIMITS.minPoints ||
    content.points > QUESTION_LIMITS.maxPoints
  ) {
    issues.push({ path: 'points', code: 'points_invalid' });
  }
}

export function blockingIssues(issues: readonly QuestionIssue[]): QuestionIssue[] {
  return issues.filter((issue) => !WARNING_CODES.has(issue.code));
}

/**
 * Complete and consistent, so it can be graded: by the program alone (choice)
 * or with assistance against its guide (open questions).
 */
export function isGradable(content: QuestionContent): boolean {
  return validateQuestionContent(content).length === 0;
}

/** Whether there is anything to check: an answer key, or for open questions a grading guide. */
export function hasAnswerKey(content: QuestionContent): boolean {
  if (content.type !== 'short_answer') return content.answer.length > 0;
  const guide = content.guide;
  return Boolean(guide && (guide.referenceAnswer || guide.finalAnswer || guide.rubric.length));
}

/**
 * The scoring points an open question is graded by. Without written points:
 * a calculation with a final answer is scored on that answer, anything else
 * as a whole against the reference answer. Server-made points have no text.
 */
export function effectiveRubric(
  content: Pick<QuestionContent, 'points' | 'guide'>,
): RubricCriterion[] {
  const guide = content.guide;
  if (guide?.rubric.length) return guide.rubric;
  if (guide?.finalAnswer) return [{ id: 'final', text: '', points: content.points, final: true }];
  return [{ id: 'overall', text: '', points: content.points }];
}

export interface ParsedQuestion {
  /** Null when the entry is not a question object at all. */
  content: QuestionContent | null;
  /** The file's own claim that the answer was checked (the student confirms it in the preview). */
  verified: boolean;
  /** The file's id for this question, used only to locate errors. */
  externalId: string | null;
  issues: QuestionIssue[];
}

/** One question from an import file or the editor (any of the accepted spellings). */
export function parseQuestion(
  raw: unknown,
  defaults: { source?: QuestionSource | null } = {},
): ParsedQuestion {
  const issues: QuestionIssue[] = [];
  if (!isRecord(raw)) {
    return {
      content: null,
      verified: false,
      externalId: null,
      issues: [{ path: '', code: 'not_object' }],
    };
  }
  const typeText = str(raw.type)?.toLowerCase();
  const openSubtype = typeText ? OPEN_TYPE_NAMES[typeText] : undefined;
  const type = (
    openSubtype
      ? 'short_answer'
      : typeText === 'single_choice'
        ? 'single'
        : typeText === 'multiple_choice'
          ? 'multiple'
          : typeText
  ) as QuestionType;
  if (!(QUESTION_TYPES as readonly string[]).includes(type)) {
    issues.push({ path: 'type', code: 'type_unsupported' });
  }
  const stem = str(raw.stem ?? raw.question) ?? '';
  const open = type === 'short_answer';
  const options = open
    ? raw.options === undefined || raw.options === null
      ? []
      : readOptions(raw.options, issues)
    : readOptions(raw.options, issues);
  const answer = open ? [] : readAnswer(raw.answer, issues);
  let subtype: OpenSubtype | undefined;
  let guide: GradingGuide | undefined;
  if (open) {
    const named = str(raw.subtype)?.toLowerCase();
    subtype = named ? OPEN_TYPE_NAMES[named] : openSubtype;
    if (named && !subtype) issues.push({ path: 'subtype', code: 'subtype_invalid' });
    guide = readGuide(raw, issues);
  }
  const explanationText = str(raw.explanation ?? raw.analysis);
  let concepts: string[] = [];
  const rawConcepts = raw.concepts ?? raw.knowledgePoints;
  if (rawConcepts !== undefined && rawConcepts !== null) {
    if (Array.isArray(rawConcepts) && rawConcepts.every((entry) => typeof entry === 'string')) {
      const seen = new Set<string>();
      concepts = rawConcepts
        .map((entry) => normalizeText(entry).replace(/\s+/g, ' '))
        .filter((entry) => {
          const key = conceptKey(entry);
          if (!entry || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    } else {
      issues.push({ path: 'concepts', code: 'concepts_invalid' });
    }
  }
  let difficulty: number | null = null;
  if (raw.difficulty !== undefined && raw.difficulty !== null) {
    if (typeof raw.difficulty === 'number') difficulty = raw.difficulty;
    else issues.push({ path: 'difficulty', code: 'difficulty_invalid' });
  }
  let points = 1;
  if (raw.points !== undefined && raw.points !== null) {
    if (typeof raw.points === 'number') points = raw.points;
    else issues.push({ path: 'points', code: 'points_invalid' });
  }
  if (raw.verified !== undefined && typeof raw.verified !== 'boolean') {
    issues.push({ path: 'verified', code: 'verified_invalid' });
  }
  const source = readSource(raw.source, issues) ?? defaults.source ?? null;
  const externalId =
    typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id).slice(0, 80) : null;
  const content: QuestionContent = {
    type,
    ...(open ? { subtype: subtype ?? 'short' } : {}),
    stem,
    options,
    answer,
    ...(open ? { guide } : {}),
    explanation: explanationText ? explanationText : null,
    concepts,
    difficulty,
    points,
    source,
  };
  const seen = new Set(issues.map((issue) => `${issue.path}|${issue.code}`));
  for (const issue of validateQuestionContent(content)) {
    if (!seen.has(`${issue.path}|${issue.code}`)) issues.push(issue);
  }
  return { content, verified: raw.verified === true, externalId, issues };
}

// ── import files ────────────────────────────────────────────────────────────

export const IMPORT_FORMAT = 'zhiyu-question-bank';

export interface ImportDocumentResult {
  /** Problems with the file as a whole (wrong shape, too many questions). */
  fileError: 'not_question_bank' | 'too_many_questions' | 'empty' | null;
  /** Defaults for every question (a question's own source wins). */
  source: QuestionSource | null;
  items: ParsedQuestion[];
}

/**
 * Parse an import document: `{ format, version, source?, questions: [...] }`
 * or a bare array of questions.
 */
export function parseImportDocument(raw: unknown): ImportDocumentResult {
  let list: unknown;
  let source: QuestionSource | null = null;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (isRecord(raw) && Array.isArray(raw.questions)) {
    if (raw.format !== undefined && raw.format !== IMPORT_FORMAT) {
      return { fileError: 'not_question_bank', source: null, items: [] };
    }
    list = raw.questions;
    const sourceIssues: QuestionIssue[] = [];
    source = readSource(raw.source, sourceIssues);
    if (sourceIssues.length) source = null;
  } else {
    return { fileError: 'not_question_bank', source: null, items: [] };
  }
  const questions = list as unknown[];
  if (questions.length === 0) return { fileError: 'empty', source, items: [] };
  if (questions.length > QUESTION_LIMITS.importItems) {
    return { fileError: 'too_many_questions', source, items: [] };
  }
  return {
    fileError: null,
    source,
    items: questions.map((entry) => parseQuestion(entry, { source })),
  };
}

/**
 * Canonical text of what makes two questions the same (type, stem, options,
 * answer key). Hashed on the server for de-duplication; explanation, concepts
 * and points are metadata and do not make a question different.
 */
export function canonicalQuestionText(content: QuestionContent): string {
  const fold = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const parts: unknown[] = [
    content.type,
    fold(content.stem),
    content.options.map((option) => [option.value, fold(option.label)]),
    [...content.answer].sort(),
  ];
  // An open question's key is its reference and final answer; the subtype and
  // scoring points are metadata, like points. (Choice questions: unchanged.)
  if (content.type === 'short_answer') {
    parts.push({
      reference: fold(content.guide?.referenceAnswer ?? ''),
      final: fold(content.guide?.finalAnswer ?? ''),
    });
  }
  // A question with figures differs from the same words without them. Which
  // material version holds the image does not matter: the same exercise in a
  // re-uploaded book is the same question. (No figures: unchanged B07 hashes.)
  if (content.figures?.length) parts.push({ figures: content.figures.length });
  return JSON.stringify(parts);
}

/** Stable key of a question copied from an official pack. */
export function packFingerprint(packId: string, version: number, questionId: string): string {
  return `pack:${packId}@${version}/${questionId}`;
}

/** Server-made ids (`q-` + 12 base64url characters). */
export function isQuestionId(value: unknown): value is string {
  return typeof value === 'string' && /^q-[A-Za-z0-9_-]{12}$/.test(value);
}

// ── import preview and commit (API shapes) ──────────────────────────────────

export interface ImportPreviewItem {
  index: number;
  externalId: string | null;
  content: QuestionContent | null;
  /** What the file claims; the student confirms it before committing. */
  verified: boolean;
  errors: QuestionIssue[];
  warnings: QuestionIssue[];
  /** An existing question with the same content, or `batch` for a repeat within the file. */
  duplicateOf: string | null;
}

export interface ImportPreview {
  items: ImportPreviewItem[];
  summary: { total: number; ready: number; drafts: number; invalid: number; duplicates: number };
}

export interface ImportCommitResult {
  created: number;
  duplicates: number;
  invalid: number;
  outcomes: Array<{
    index: number;
    status: 'created' | 'duplicate' | 'invalid';
    id: string | null;
  }>;
}
