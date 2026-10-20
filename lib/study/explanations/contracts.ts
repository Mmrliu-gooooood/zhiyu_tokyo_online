/**
 * Explanations of one wrong question on request (learning plan B13): wire
 * contracts and limits. Pure — no Next.js, browser store, database or model
 * imports.
 *
 * Help comes in steps (B10 already offers the first three): the question's
 * own explanation → looking back at the course or material → asking a
 * classmate → an explanation written for this one question. Nothing here is
 * generated unless the student asks for it, in one of four forms:
 *
 * - `text`: a short written explanation (one model call).
 * - `whiteboard`: the same, worked step by step on a whiteboard — elements of
 *   the classroom whiteboard, checked with its validator (one call).
 * - `interactive`: a light interactive page made by the classroom's
 *   interactive-scene generator (a plan call, then the page).
 * - `course`: a full course through the normal course generation, added to
 *   the subject once; images, speech and video only when ticked.
 *
 * The inputs are the student's own (their answer and grading), so an
 * explanation is reused only for the same owner, question, answer, grading,
 * materials, preferences, form and language — never across students.
 */
import type { PPTElement } from '@openmaic/dsl';

export const EXPLANATION_FORMATS = ['text', 'whiteboard', 'interactive', 'course'] as const;
export type ExplanationFormat = (typeof EXPLANATION_FORMATS)[number];
/** The forms written by this feature itself (a course is written by course generation). */
export const LIGHT_FORMATS = ['text', 'whiteboard', 'interactive'] as const;
export type LightFormat = (typeof LIGHT_FORMATS)[number];

export const EXPLANATION_STATUSES = ['pending', 'ready', 'failed', 'cancelled'] as const;
export type ExplanationStatus = (typeof EXPLANATION_STATUSES)[number];

export const EXPLANATION_LIMITS = {
  /** Part of the reuse key: a new prompt or rule set writes new explanations. */
  policyVersion: 'explain-v1',
  /** Explanations (model ones) one student may start per day. */
  perDay: 20,
  /** Tries per explanation: the first and two retries. */
  attempts: 3,
  /** Model calls one try may make. */
  callCap: { text: 2, whiteboard: 2, interactive: 3, course: 0 } as Record<
    ExplanationFormat,
    number
  >,
  /** One request runs an explanation at a time. */
  leaseMs: 6 * 60_000,
  /** Material passages frozen with a request. */
  evidencePassages: 4,
  passageChars: 700,
  /** The interactive page uses the model's own limit, like classroom interactive scenes. */
  outputTokens: { text: 2200, whiteboard: 3200, plan: 1000 },
  timeoutMs: { text: 100_000, whiteboard: 120_000, plan: 60_000, page: 240_000 },
  text: { minSteps: 2, maxSteps: 6, stepChars: 700, fieldChars: 400 },
  whiteboard: {
    minSteps: 2,
    maxSteps: 6,
    maxDrawsPerStep: 6,
    maxDraws: 24,
    sayChars: 300,
    textChars: 160,
    latexChars: 300,
    width: 1000,
    height: 562.5,
  },
  /** The interactive page as generated (it runs sandboxed, see InteractiveExplanation). */
  pageMaxBytes: 400_000,
  titleChars: 60,
  requirementChars: 600,
} as const;

/** `ex-` + 12 url-safe characters. */
export function isExplanationId(value: unknown): value is string {
  return typeof value === 'string' && /^ex-[A-Za-z0-9_-]{12}$/.test(value);
}

export function isExplanationFormat(value: unknown): value is ExplanationFormat {
  return typeof value === 'string' && (EXPLANATION_FORMATS as readonly string[]).includes(value);
}

export function isLightFormat(value: unknown): value is LightFormat {
  return typeof value === 'string' && (LIGHT_FORMATS as readonly string[]).includes(value);
}

// ── what a request is built from (frozen on the server) ─────────────────────

/** A passage of the subject's materials (fixed version), cited as `M1`… */
export interface ExplanationPassage {
  id: string;
  text: string;
  materialId: string;
  versionId: string;
  versionNo: number;
  page: number | null;
  title: string;
}

/** Media a full course may use; each off unless the student ticked it. */
export interface CourseMedia {
  image: boolean;
  tts: boolean;
  video: boolean;
}

export interface ExplanationRequest {
  version: 1;
  format: ExplanationFormat;
  /** Output language (an app locale code). */
  language: string;
  spaceName: string;
  /** The question as last answered wrongly. */
  question: {
    kind: string;
    stem: string;
    options: string[];
    correct: string | null;
    explanation: string | null;
    concepts: string[];
  };
  where: string;
  studentAnswer: string;
  grading: string;
  /** The occurrence it was built from (a newer wrong answer is a different request). */
  sourceKey: string;
  passages: ExplanationPassage[];
  /** The student's explanation-style preferences (Memory on), as they were. */
  preferences: { text: string; refs: string[] } | null;
  /** Course only. */
  course?: { requirement: string; media: CourseMedia };
}

// ── content ─────────────────────────────────────────────────────────────────

export interface TextExplanation {
  kind: 'text';
  title: string;
  /** What went wrong in the student's answer. */
  diagnosis: string;
  steps: string[];
  takeaway: string;
  /** A short question to check oneself, with its answer (hidden until asked). */
  check: { question: string; answer: string } | null;
  refs: string[];
}

export interface WhiteboardStep {
  say: string;
  /** Elements this step adds (whiteboard elements, validated). */
  elements: PPTElement[];
}

export interface WhiteboardExplanation {
  kind: 'whiteboard';
  title: string;
  steps: WhiteboardStep[];
  takeaway: string;
  refs: string[];
}

/**
 * A page made by the classroom's interactive-scene generator. It is shown
 * only in a sandboxed iframe without same-origin access (like classroom
 * interactive scenes), so it cannot reach the account.
 */
export interface InteractiveExplanation {
  kind: 'interactive';
  title: string;
  intro: string;
  widgetType: 'simulation' | 'diagram';
  html: string;
  refs: string[];
}

export type ExplanationContent = TextExplanation | WhiteboardExplanation | InteractiveExplanation;

// ── views ───────────────────────────────────────────────────────────────────

export interface ExplanationSource {
  id: string;
  materialId: string;
  versionId: string;
  versionNo: number;
  page: number | null;
  title: string;
}

export interface ExplanationSummary {
  id: string;
  spaceId: string;
  itemId: string;
  format: ExplanationFormat;
  status: ExplanationStatus;
  title: string | null;
  stem: string;
  concepts: string[];
  /** A request is running it now. */
  running: boolean;
  attempts: number;
  canRetry: boolean;
  lastError: string | null;
  calls: number;
  callCap: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  /** Course only. */
  jobId: string | null;
  stageId: string | null;
  media: CourseMedia | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExplanationDetail extends ExplanationSummary {
  content: ExplanationContent | null;
  sources: ExplanationSource[];
  /** Whether the student's explanation preferences were used. */
  preferencesUsed: boolean;
  /** Course only: what the course is asked to cover. */
  requirement: string | null;
}

export interface ExplanationCreateResult {
  explanation: ExplanationDetail;
  /** A saved explanation of the same inputs was returned; no model was called. */
  reused: boolean;
}

// ── checks shared by client and server ──────────────────────────────────────

export function parseCourseMedia(value: unknown): CourseMedia | null {
  if (value === undefined || value === null) return { image: false, tts: false, video: false };
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !['image', 'tts', 'video'].includes(key))) return null;
  const flag = (key: string) => {
    const raw = record[key];
    return raw === undefined ? false : raw === true ? true : raw === false ? false : null;
  };
  const image = flag('image');
  const tts = flag('tts');
  const video = flag('video');
  if (image === null || tts === null || video === null) return null;
  return { image, tts, video };
}

/** Error codes a failed try may leave (shown to the student). */
export const EXPLANATION_ERRORS = [
  'model_error',
  'timeout',
  'invalid_output',
  'budget',
  'interrupted',
  'internal',
] as const;
export type ExplanationError = (typeof EXPLANATION_ERRORS)[number];
