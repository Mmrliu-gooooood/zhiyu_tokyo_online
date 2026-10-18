/**
 * AI practice (learning plan B11): wire contracts shared by the server, the
 * paper builder, the wrong-answer book and the attempt page. Pure — no
 * Next.js, browser store or database imports.
 *
 * A practice job writes new questions with the student's model after they
 * confirmed its plan: the gap of a mixed paper (bank first, AI only for what
 * is missing), a whole AI paper, or variants of one wrong question. Every
 * question is written from frozen evidence (material passages of fixed
 * versions; for variants also the original question), checked by the
 * program, then reviewed by a second model call. What passes is added to the
 * subject's bank as `ai_generated`, never as checked: an AI review is not a
 * human check.
 */
import type { ExamBlueprint } from '@/lib/study/questions/blueprint';
import type { OpenSubtype, QuestionType } from '@/lib/study/questions/contracts';

export const PRACTICE_LIMITS = {
  /** Questions one job may write. */
  maxQuestions: 20,
  /** Questions one generation call is asked for. */
  batchSize: 5,
  /** Calls one batch may take: generation, one repair of non-JSON output, review. */
  callsPerBatch: 3,
  /** Times a stopped job may be continued with a new call allowance. */
  continues: 2,
  /** Variants of one wrong question per job. */
  variantMax: 3,
  /** Material passages frozen as evidence. */
  evidencePassages: 10,
  /** Characters of one passage and of all passages together. */
  passageChars: 900,
  evidenceChars: 8000,
  /** Material versions a paper job may draw from. */
  materialVersions: 10,
  /** Jobs one student may start per day (each job is bounded by its call cap). */
  jobsPerDay: 30,
  hintChars: 300,
  /** Questions kept in a job's rejected list (the rest are counted only). */
  rejectedKept: 60,
  /** One step (generation + review of a batch) may hold the job this long. */
  stepLeaseMs: 300_000,
  /** A question this similar to the original (variants) or to a bank question is a near repeat. */
  nearDuplicate: 0.9,
  /** Similarity worth showing next to a kept question. */
  similarityShown: 0.6,
  generationOutputTokens: 6000,
  reviewOutputTokens: 1500,
} as const;

export type PracticeMode = 'mixed' | 'ai';
export type PracticeJobKind = 'paper' | 'variant';
/**
 * `pending`: work and allowance left (the page runs the next step);
 * `completed`: every requested question was written; `stopped`: the call
 * allowance ran out or the model failed — the student may continue (new
 * allowance, at most twice), publish what there is, or cancel.
 */
export type PracticeJobStatus = 'pending' | 'completed' | 'stopped' | 'cancelled';

/** How many questions of one type to write, in paper order. */
export interface GenerationTarget {
  type: QuestionType;
  count: number;
}

/** A material version the questions may be written from (current version with an index). */
export interface PracticeMaterial {
  materialId: string;
  versionId: string;
  versionNo: number;
  title: string;
}

/** What the student confirms before anything calls a model. */
export interface GenerationPlan {
  mode: PracticeMode;
  targets: GenerationTarget[];
  total: number;
  /** Knowledge points the new questions should cover. */
  concepts: string[];
  /** Materials of the subject the questions may draw from (the student may narrow it). */
  materials: PracticeMaterial[];
  /** Most model calls the job may make before it stops and asks. */
  maxCalls: number;
  /** Why the plan cannot run (none: it can). */
  blocked: null | 'nothing_to_generate' | 'no_materials' | 'too_many' | 'retrieval_unavailable';
}

/** Most calls a job writing `total` questions may make (before any continue). */
export function callCapFor(total: number): number {
  return Math.max(1, Math.ceil(total / PRACTICE_LIMITS.batchSize)) * PRACTICE_LIMITS.callsPerBatch;
}

// ── job contents ────────────────────────────────────────────────────────────

/**
 * One piece of evidence a question may cite. `E<n>`: a material passage of a
 * fixed version; `Q0`: the original question of a variant job.
 */
export interface PracticeEvidence {
  id: string;
  kind: 'material' | 'question';
  text: string;
  materialId?: string;
  versionId?: string;
  versionNo?: number;
  artifactId?: string;
  page?: number | null;
  blockId?: string;
  title?: string;
  contentHash?: string;
}

export interface PaperJobRequest {
  kind: 'paper';
  mode: PracticeMode;
  /** The previewed blueprint with its seed (the bank part is re-picked from it on publish). */
  blueprint: ExamBlueprint;
  /** Bank questions the blueprint picked when the job was created (mixed); empty for AI papers. */
  bankRefs: string[];
  targets: GenerationTarget[];
  concepts: string[];
  /** Chosen knowledge points the bank part does not cover (the new questions should). */
  uncovered: string[];
  materials: PracticeMaterial[];
  /** The linked course's title, as context for the model. */
  courseTitle: string | null;
  spaceName: string;
}

export interface VariantJobRequest {
  kind: 'variant';
  wrongItemId: string;
  questionKey: string;
  targets: GenerationTarget[];
  /** Variants keep the original's kind of open question. */
  subtype: OpenSubtype | null;
  concepts: string[];
  materials: PracticeMaterial[];
  spaceName: string;
  /** The original's content hash and stem: a variant must not repeat it. */
  original: { hash: string; stem: string };
}

export type PracticeJobRequest = PaperJobRequest | VariantJobRequest;

/** A question a job added to the bank. */
export interface ProducedQuestion {
  questionId: string;
  version: number;
  type: QuestionType;
  subtype?: OpenSubtype;
  /** Start of the stem, for the job view. */
  stem: string;
  concepts: string[];
  refs: string[];
  /** One sentence that helps without giving the answer away (shown only when asked for). */
  hint: string | null;
  /** The most similar bank question (or the original, for variants), when similar enough to mention. */
  similarity: { score: number; questionId: string | null; original: boolean } | null;
  review: string;
  batch: number;
}

export type RejectionStage = 'output' | 'program' | 'review';

export type RejectionReason =
  | 'not_json'
  | 'too_many'
  | 'type_unrequested'
  | 'type_excess'
  | 'invalid'
  | 'no_answer_key'
  | 'concept_missing'
  | 'bad_refs'
  | 'duplicate'
  | 'near_duplicate'
  | 'review_rejected'
  | 'review_missing'
  | 'review_invalid';

export interface RejectedQuestion {
  batch: number;
  stage: RejectionStage;
  reason: RejectionReason;
  /** Start of the stem when there was one. */
  stem?: string;
  note?: string;
}

export interface PracticeJobView {
  id: string;
  spaceId: string;
  kind: PracticeJobKind;
  mode: PracticeMode | null;
  status: PracticeJobStatus;
  targets: GenerationTarget[];
  total: number;
  produced: ProducedQuestion[];
  /** Kept rejections, newest last, and how many there were in all. */
  rejected: RejectedQuestion[];
  rejectedCount: number;
  concepts: string[];
  /** Requested knowledge points no kept question covers yet. */
  uncoveredConcepts: string[];
  materials: PracticeMaterial[];
  /** Where each evidence id points (no text): material page, or the original question. */
  evidence: Array<{
    id: string;
    kind: 'material' | 'question';
    materialId?: string;
    versionId?: string;
    page?: number | null;
    title?: string;
  }>;
  calls: number;
  callCap: number;
  continues: number;
  /** Whether the student may continue a stopped job. */
  canContinue: boolean;
  lastError: string | null;
  /** A step is running right now. */
  running: boolean;
  paperId: string | null;
  wrongItemId: string | null;
  /** Bank questions (mixed papers) that the paper will also contain. */
  bankCount: number;
  createdAt: string;
  updatedAt: string;
}

export function producedCount(produced: readonly ProducedQuestion[], type: QuestionType): number {
  return produced.filter((question) => question.type === type).length;
}

/** What is still to write, per type, in target order. */
export function remainingTargets(
  targets: readonly GenerationTarget[],
  produced: readonly ProducedQuestion[],
): GenerationTarget[] {
  return targets
    .map((target) => ({
      type: target.type,
      count: Math.max(0, target.count - producedCount(produced, target.type)),
    }))
    .filter((target) => target.count > 0);
}

/** The next batch: up to `batchSize` of what is left, in target order. */
export function nextBatch(
  targets: readonly GenerationTarget[],
  produced: readonly ProducedQuestion[],
): GenerationTarget[] {
  let room: number = PRACTICE_LIMITS.batchSize;
  const batch: GenerationTarget[] = [];
  for (const target of remainingTargets(targets, produced)) {
    if (room === 0) break;
    const count = Math.min(room, target.count);
    batch.push({ type: target.type, count });
    room -= count;
  }
  return batch;
}

// ── attempts: novelty and assistance ────────────────────────────────────────

/** Per item, stored with the attempt by the server. */
export interface ItemAssistanceRecord {
  /** Whether the student had answered this question in an earlier submitted paper of the subject. */
  novelty?: 'new' | 'seen';
  hintAt?: string;
  solutionAt?: string;
}

export interface AttemptAssistanceRecord {
  items?: Record<string, ItemAssistanceRecord>;
}

export type AssistanceLevel = 'unassisted' | 'hinted' | 'solution_seen';

export function assistanceLevel(record: ItemAssistanceRecord | undefined): AssistanceLevel {
  if (record?.solutionAt) return 'solution_seen';
  if (record?.hintAt) return 'hinted';
  return 'unassisted';
}

/**
 * An independent check: a new question, answered right without a hint or
 * the solution. Anything else is practice (a repeat or helped answer) — it
 * is recorded, but it is not evidence of understanding.
 */
export function isIndependentPass(
  outcome: string,
  record: ItemAssistanceRecord | undefined,
): boolean {
  return (
    outcome === 'correct' && record?.novelty === 'new' && assistanceLevel(record) === 'unassisted'
  );
}

export interface ItemSolution {
  answer: string[];
  explanation: string | null;
  referenceAnswer: string | null;
  finalAnswer: string | null;
}

/** What the attempt page shows of one item's assistance. */
export interface ItemAssistanceView {
  novelty: 'new' | 'seen' | null;
  level: AssistanceLevel;
  hintAvailable: boolean;
  /** Only once the student asked for it. */
  hint: string | null;
  solution: ItemSolution | null;
}

export interface AttemptAssistanceView {
  /** Hints and solutions can be asked for (practice papers). */
  practice: boolean;
  items: Record<string, ItemAssistanceView>;
}

// ── ids ─────────────────────────────────────────────────────────────────────

export function isPracticeJobId(value: unknown): value is string {
  return typeof value === 'string' && /^pj-[A-Za-z0-9_-]{12}$/.test(value);
}
