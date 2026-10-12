/**
 * Exercise extraction from study materials (learning plan B08): wire
 * contracts shared by the APIs and the review page. Pure — no Next.js,
 * browser store or database imports.
 *
 * An extraction reads the parsed text of a page range of one material
 * version (the B02 artifact; scanned pages have no text and are reported,
 * never guessed) and produces candidate questions. Candidates are drafts the
 * student checks side by side with the original page, edits, splits, merges
 * or discards, and then commits to the question bank as
 * `material_extracted` questions.
 *
 * Where an answer came from is kept separately from whether the student
 * checked it: `source` (printed in the material, inline or in an answer key),
 * `model` (a model's suggestion the student adopted), `user` (the student
 * entered or changed it), `missing`. None of these makes a question
 * "checked"; only the student's tick at commit time does.
 */
import type { QuestionOption, QuestionType } from '@/lib/study/questions/contracts';

export const EXTRACTION_STRATEGY = 'rules-v1';

export const EXTRACTION_LIMITS = {
  /** Pages one extraction may read. */
  maxPages: 200,
  candidatesPerExtraction: 500,
  extractionsPerSpace: 100,
  /** Source lines kept per candidate (and characters per line). */
  linesPerCandidate: 120,
  lineChars: 2000,
  figuresPerQuestion: 4,
  unmatchedReported: 50,
  /** Candidates sent to the model in one assist request. */
  assistBatch: 6,
  /** Assist requests per extraction (budget for the optional model help). */
  assistCallsPerExtraction: 60,
  assistOutputTokens: 3000,
  commitBatch: 200,
} as const;

/** `open`: no options (computation, proof, fill-in) — kept, but committed only once open questions are supported (B09). */
export type CandidateType = QuestionType | 'open';

export type AnswerBasis = 'missing' | 'source' | 'model' | 'user';

export type CandidateStatus = 'draft' | 'discarded' | 'committed';

/** One line of the material as the parser read it. */
export interface SourceLine {
  page: number;
  text: string;
}

/** The editable draft of one candidate (the bank's question content, plus extraction-only fields). */
export interface CandidateContent {
  type: CandidateType;
  stem: string;
  options: QuestionOption[];
  answer: string[];
  explanation: string | null;
  concepts: string[];
  difficulty: number | null;
  points: number;
  /** Image ids of the extraction's artifact shown with the question. */
  figures: string[];
  /** Printed answer text of an open question (kept for B09; never graded here). */
  referenceAnswer: string | null;
}

/** Where a printed answer was found. */
export interface AnswerRef {
  kind: 'inline' | 'answer_key';
  page: number;
  text: string;
}

/** A model's proposal, kept apart from the answer until the student adopts it. */
export interface CandidateSuggestion {
  answer: string[];
  explanation: string | null;
  /** The model's tidied stem/options (LaTeX), applied only on adoption. */
  stem: string | null;
  options: QuestionOption[] | null;
  type: CandidateType | null;
  modelString: string;
  createdAt: string;
}

export interface ExtractionStats {
  /** Pages of the artifact, and the range read. */
  pageCount: number;
  pagesRead: number;
  /** Pages in the range without any text (scanned): not extracted, never guessed. */
  skippedPages: number[];
  textChars: number;
  candidates: number;
  choice: number;
  open: number;
  answersFromSource: number;
  /** Answer-key entries that matched no question. */
  unmatchedAnswers: Array<{ label: string; page: number; text: string }>;
  /** Figures on pages with questions that no question claimed. */
  unassignedFigures: Array<{ imageId: string; page: number }>;
  truncated: boolean;
  durationMs: number;
  /** The parser that produced the text (from the artifact). */
  extractorId: string;
}

export interface ExtractionUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** The last model used for help. */
  modelString: string | null;
  usageCompleteness: 'none' | 'complete' | 'partial';
}

export const EMPTY_EXTRACTION_USAGE: ExtractionUsage = {
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  modelString: null,
  usageCompleteness: 'none',
};

export interface ExtractionCounts {
  total: number;
  draft: number;
  committed: number;
  discarded: number;
  /** Drafts that can be committed now (complete objective questions). */
  ready: number;
}

export interface ExtractionView {
  id: string;
  spaceId: string;
  materialId: string;
  versionId: string;
  versionNo: number | null;
  materialTitle: string | null;
  /** The material is still in the library and linked to the space (new commits allowed). */
  sourceAvailable: boolean;
  isCurrentVersion: boolean;
  artifactId: string;
  pageFrom: number | null;
  pageTo: number | null;
  strategy: string;
  stats: ExtractionStats;
  usage: ExtractionUsage;
  counts: ExtractionCounts;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateView {
  id: string;
  position: number;
  status: CandidateStatus;
  label: string | null;
  section: string | null;
  content: CandidateContent;
  lines: SourceLine[];
  pages: number[];
  answerBasis: AnswerBasis;
  answerRef: AnswerRef | null;
  suggestion: CandidateSuggestion | null;
  /** The student's tick: commit as a checked (user_verified) question. */
  checked: boolean;
  questionId: string | null;
  revision: number;
  /** Edited since extraction (the extractor's result can be restored). */
  edited: boolean;
}

export interface ExtractionDetail {
  extraction: ExtractionView;
  candidates: CandidateView[];
}

export interface CommitOutcome {
  candidateId: string;
  status: 'created' | 'duplicate' | 'invalid' | 'skipped';
  questionId: string | null;
}

export function isExtractionId(value: unknown): value is string {
  return typeof value === 'string' && /^qx-[A-Za-z0-9_-]{12}$/.test(value);
}

export function isCandidateId(value: unknown): value is string {
  return typeof value === 'string' && /^qc-[A-Za-z0-9_-]{12}$/.test(value);
}
