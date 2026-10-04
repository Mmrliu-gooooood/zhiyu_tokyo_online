/**
 * Study spaces (learning plan B01): wire contracts and input validation shared
 * by the API routes and the study pages. Pure — no Next.js, browser store or
 * database imports.
 *
 * A study space is a long-lived subject ("高数") that groups existing courses.
 * It is not a course: courses stay Stages, and a course may sit in several
 * spaces. Progress records where the learner last was in a course; it is a
 * viewing fact and never a mastery claim.
 */

export const EDUCATION_LEVELS = ['primary', 'junior', 'senior', 'university', 'other'] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

export const STUDY_SPACE_STATUSES = ['active', 'archived'] as const;
export type StudySpaceStatus = (typeof STUDY_SPACE_STATUSES)[number];

export const STUDY_SPACE_LIMITS = {
  name: 60,
  subject: 60,
  goal: 500,
  examScope: 2000,
  timezone: 64,
  /** Live spaces per owner (archived ones included). */
  spacesPerOwner: 100,
  coursesPerSpace: 200,
} as const;

export interface StudySpaceSummary {
  id: string;
  name: string;
  educationLevel: EducationLevel | null;
  subject: string | null;
  goal: string | null;
  /** Calendar date `YYYY-MM-DD`, interpreted in `timezone`. */
  examDate: string | null;
  examScope: string | null;
  timezone: string | null;
  status: StudySpaceStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  courseCount: number;
  /** The most recently studied course in this space, if any. */
  lastStudied: StudyCourseProgressView | null;
}

export type CourseGenerationState = 'complete' | 'incomplete';

/** A linked course as shown in a space. */
export interface StudySpaceCourse {
  stageId: string;
  name: string;
  sceneCount: number;
  generation: CourseGenerationState;
  addedAt: string;
  addedVia: 'link' | 'generation';
  courseUpdatedAt: string;
  progress: StudyCourseProgressView | null;
}

export interface StudySpaceDetail extends StudySpaceSummary {
  courses: StudySpaceCourse[];
}

/**
 * The viewing state of one course for its owner. `sceneIndex`/`sceneCount`
 * are recomputed from the current document on every read; `sceneChanged`
 * says the scene was edited after the position was recorded, and
 * `sceneMissing` that it no longer exists.
 */
export interface StudyCourseProgressView {
  stageId: string;
  courseName: string;
  sceneId: string;
  sceneIndex: number | null;
  sceneCount: number;
  actionIndex: number;
  actionId: string | null;
  furthestSceneIndex: number;
  reachedEnd: boolean;
  sceneChanged: boolean;
  sceneMissing: boolean;
  /**
   * Where "continue" should open: the same position; the next scene when the
   * recorded scene was finished; the scene's start when it was edited since;
   * null (the course start) when the scene is gone.
   */
  resumeSceneId: string | null;
  resumeActionIndex: number;
  revision: number;
  observedAt: string;
  updatedAt: string;
}

/** A course the owner may link into a space. */
export interface LinkableCourse {
  stageId: string;
  name: string;
  sceneCount: number;
  generation: CourseGenerationState;
  updatedAt: string;
  spaceIds: string[];
}

export interface StudySpaceInput {
  name: string;
  educationLevel: EducationLevel | null;
  subject: string | null;
  goal: string | null;
  examDate: string | null;
  examScope: string | null;
  timezone: string | null;
}

export type StudySpacePatch = Partial<StudySpaceInput> & { status?: StudySpaceStatus };

export interface ProgressWriteInput {
  sceneId: string;
  /**
   * Null when only the scene changed (navigation): the server keeps the stored
   * action index for the same scene and starts a different scene at 0. The
   * value equal to the scene's action count marks the scene as finished.
   */
  actionIndex: number | null;
  /** The revision this write was based on; null when the client has none. */
  baseRevision: number | null;
  /** When the learner was at this position (client clock, ISO 8601). */
  observedAt: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; field: string };

function optionalText(
  value: unknown,
  max: number,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if ([...trimmed].length > max) return { ok: false };
  return { ok: true, value: trimmed };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date `YYYY-MM-DD` between 2000 and 2100, or null. */
export function parseExamDate(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const match = DATE.exec(value);
  if (!match) return { ok: false };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2000 || year > 2100) return { ok: false };
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false };
  }
  return { ok: true, value };
}

function parseTimezone(value: unknown): { ok: true; value: string | null } | { ok: false } {
  const text = optionalText(value, STUDY_SPACE_LIMITS.timezone);
  if (!text.ok || text.value === null) return text;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: text.value });
    return text;
  } catch {
    return { ok: false };
  }
}

const FIELD_PARSERS: Record<
  keyof StudySpaceInput,
  (value: unknown) => { ok: true; value: unknown } | { ok: false }
> = {
  name: (value) => {
    const text = optionalText(value, STUDY_SPACE_LIMITS.name);
    return text.ok && text.value !== null ? text : { ok: false };
  },
  educationLevel: (value) =>
    value === undefined || value === null || value === ''
      ? { ok: true, value: null }
      : typeof value === 'string' && (EDUCATION_LEVELS as readonly string[]).includes(value)
        ? { ok: true, value }
        : { ok: false },
  subject: (value) => optionalText(value, STUDY_SPACE_LIMITS.subject),
  goal: (value) => optionalText(value, STUDY_SPACE_LIMITS.goal),
  examDate: parseExamDate,
  examScope: (value) => optionalText(value, STUDY_SPACE_LIMITS.examScope),
  timezone: parseTimezone,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a create body. Unknown fields are ignored. */
export function parseStudySpaceInput(body: unknown): ValidationResult<StudySpaceInput> {
  if (!isObject(body)) return { ok: false, field: 'body' };
  const out: Record<string, unknown> = {};
  for (const [field, parse] of Object.entries(FIELD_PARSERS)) {
    const parsed = parse(body[field]);
    if (!parsed.ok) return { ok: false, field };
    out[field] = parsed.value;
  }
  return { ok: true, value: out as unknown as StudySpaceInput };
}

/** Validate a partial update. Only present fields are changed. */
export function parseStudySpacePatch(body: unknown): ValidationResult<StudySpacePatch> {
  if (!isObject(body)) return { ok: false, field: 'body' };
  const out: Record<string, unknown> = {};
  for (const [field, parse] of Object.entries(FIELD_PARSERS)) {
    if (!(field in body)) continue;
    const parsed = parse(body[field]);
    if (!parsed.ok) return { ok: false, field };
    out[field] = parsed.value;
  }
  if ('status' in body) {
    if (!(STUDY_SPACE_STATUSES as readonly unknown[]).includes(body.status)) {
      return { ok: false, field: 'status' };
    }
    out.status = body.status;
  }
  if (Object.keys(out).length === 0) return { ok: false, field: 'body' };
  return { ok: true, value: out as StudySpacePatch };
}

/** Ids minted by this app: letters, digits, `_` and `-` only. */
export function isStudyId(value: unknown, max = 64): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && /^[\w-]+$/.test(value)
  );
}

/** Course and scene ids come from several generators; accept printable, bounded text. */
export function isContentId(value: unknown, max = 200): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f\uD800-\uDFFF]/.test(value)
  );
}

export function parseProgressWrite(body: unknown): ValidationResult<ProgressWriteInput> {
  if (!isObject(body)) return { ok: false, field: 'body' };
  if (!isContentId(body.sceneId)) return { ok: false, field: 'sceneId' };
  const actionIndex = body.actionIndex;
  if (
    actionIndex !== null &&
    actionIndex !== undefined &&
    !(
      Number.isInteger(actionIndex) &&
      (actionIndex as number) >= 0 &&
      (actionIndex as number) <= 100_000
    )
  ) {
    return { ok: false, field: 'actionIndex' };
  }
  const baseRevision = body.baseRevision;
  if (
    baseRevision !== null &&
    baseRevision !== undefined &&
    !(Number.isInteger(baseRevision) && (baseRevision as number) > 0)
  ) {
    return { ok: false, field: 'baseRevision' };
  }
  if (typeof body.observedAt !== 'string' || !Number.isFinite(Date.parse(body.observedAt))) {
    return { ok: false, field: 'observedAt' };
  }
  return {
    ok: true,
    value: {
      sceneId: body.sceneId,
      actionIndex: (actionIndex as number | null | undefined) ?? null,
      baseRevision: (baseRevision as number | null | undefined) ?? null,
      observedAt: new Date(body.observedAt).toISOString(),
    },
  };
}

/** Days from `today` to the exam date, both calendar dates; null when unset. */
export function daysUntilExam(examDate: string | null, today: string): number | null {
  if (!examDate) return null;
  const exam = parseExamDate(examDate);
  const now = parseExamDate(today);
  if (!exam.ok || !now.ok || !exam.value || !now.value) return null;
  return Math.round((Date.parse(exam.value) - Date.parse(now.value)) / 86_400_000);
}

/** Today's calendar date in a time zone, `YYYY-MM-DD`. */
export function calendarDateIn(timeZone: string | null, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone ?? undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
