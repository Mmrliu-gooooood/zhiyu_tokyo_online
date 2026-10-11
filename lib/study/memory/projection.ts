/**
 * Rules that turn saved facts into learning events (learning plan B06).
 * Pure: the server reads the sources and writes the events; these functions
 * only decide which events a source state implies and whether the student's
 * switches allow recording them. Same input → same source keys, so a replay
 * never duplicates anything.
 */
import { decodeCompanionMessage } from '@/lib/study/companion/contracts';
import { MEMORY_LIMITS, type LearningEventInput } from '@/lib/study/memory/contracts';

// ── course progress (B01 study_progress) ────────────────────────────────────

export interface ProgressSource {
  stageId: string;
  sceneIndex: number;
  sceneCount: number;
  furthestSceneIndex: number;
  reachedEndAt: string | null;
  startedAt: string;
  observedAt: string;
  updatedAt: string;
}

/**
 * Started (first saved position), the furthest page reached (one key per
 * page, so later pages add records and earlier ones stay) and watched to the
 * end. These are viewing records: nothing here says "learned".
 */
export function progressEvents(source: ProgressSource): LearningEventInput[] {
  const base = {
    payloadVersion: 1 as const,
    sourceType: 'study_progress' as const,
    sourceId: source.stageId,
    stageId: source.stageId,
    spaceId: null,
  };
  const events: LearningEventInput[] = [
    {
      ...base,
      type: 'course_started',
      sourceKey: `progress:${source.stageId}:started`,
      // The row is inserted a moment after the browser observed the first position.
      occurredAt:
        Date.parse(source.observedAt) < Date.parse(source.startedAt)
          ? source.observedAt
          : source.startedAt,
      payload: {},
    },
  ];
  const furthestPage = source.furthestSceneIndex + 1;
  if (furthestPage >= 2) {
    events.push({
      ...base,
      type: 'course_progressed',
      sourceKey: `progress:${source.stageId}:page:${furthestPage}`,
      // The position is the furthest page only when the learner is on it.
      occurredAt:
        source.sceneIndex === source.furthestSceneIndex ? source.observedAt : source.updatedAt,
      payload: { furthestPage, pageCount: source.sceneCount },
    });
  }
  if (source.reachedEndAt) {
    events.push({
      ...base,
      type: 'course_finished',
      sourceKey: `progress:${source.stageId}:finished`,
      occurredAt: source.reachedEndAt,
      payload: { pageCount: source.sceneCount },
    });
  }
  return events;
}

// ── classroom quiz attempts (RuntimeStore quizAttempt) ──────────────────────

export interface QuizRecordSource {
  seq: number;
  sceneId: string | null;
  createdAt: string;
  payload: unknown;
}

/** A quiz question as the server's stored course has it. */
export interface ServerQuizQuestion {
  id: string;
  type: string;
  question: string;
  answer?: string[];
}

type Answers = Record<string, string | string[]>;

interface AttemptPayload {
  payloadVersion?: unknown;
  phase?: unknown;
  answers?: unknown;
  questionSnapshot?: unknown;
  grading?: unknown;
}

function asArray(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function asAttempt(value: unknown): AttemptPayload | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AttemptPayload)
    : null;
}

interface SnapshotQuestion {
  id: string;
  type: string;
  question: string;
  answer?: string[];
  points: number;
}

function snapshotOf(payload: AttemptPayload): SnapshotQuestion[] | null {
  if (payload.payloadVersion !== 2 || !Array.isArray(payload.questionSnapshot)) return null;
  return payload.questionSnapshot.flatMap((item): SnapshotQuestion[] => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== 'string' || typeof raw.type !== 'string') return [];
    return [
      {
        id: raw.id,
        type: raw.type,
        question: typeof raw.question === 'string' ? raw.question : '',
        answer: Array.isArray(raw.answer) ? asArray(raw.answer) : undefined,
        points: typeof raw.points === 'number' && raw.points > 0 ? raw.points : 1,
      },
    ];
  });
}

/**
 * Re-grade the attempt's choice questions against the course as the server
 * stores it. The classroom grades in the browser, so its recorded score is
 * not trusted: the score counts only when every choice question in the
 * attempt still exists unchanged (same text and answer key) on the server.
 */
export function serverCheckedObjective(
  snapshot: readonly SnapshotQuestion[],
  answers: Answers,
  serverQuestions: readonly ServerQuizQuestion[] | null,
): { correct: number; total: number } | null {
  if (!serverQuestions) return null;
  const choice = snapshot.filter((question) => question.type !== 'short_answer');
  if (choice.length === 0) return null;
  let correct = 0;
  for (const question of choice) {
    const stored = serverQuestions.find((candidate) => candidate.id === question.id);
    const key = asArray(stored?.answer);
    if (
      !stored ||
      stored.type !== question.type ||
      stored.question !== question.question ||
      key.length === 0 ||
      !sameSet(key, asArray(question.answer))
    ) {
      return null;
    }
    if (sameSet(asArray(answers[question.id]), key)) correct += 1;
  }
  return { correct, total: choice.length };
}

/** Open questions the AI grader scored, as the classroom recorded them. */
function aiGradedOf(
  snapshot: readonly SnapshotQuestion[],
  grading: Record<string, unknown>,
): { count: number; earned: number; points: number } | null {
  let count = 0;
  let earned = 0;
  let points = 0;
  for (const question of snapshot) {
    if (question.type !== 'short_answer') continue;
    const fact = grading[question.id] as
      | { status?: unknown; result?: { earned?: unknown }; provenance?: { basis?: unknown } }
      | undefined;
    if (fact?.status !== 'graded') continue;
    const basis = fact.provenance?.basis;
    if (basis !== 'rubric' && basis !== 'reference-answer') continue;
    count += 1;
    earned += typeof fact.result?.earned === 'number' ? fact.result.earned : 0;
    points += question.points;
  }
  return count ? { count, earned, points } : null;
}

/**
 * Submitted (first submitted record) and graded (first record with nothing
 * pending) for one attempt session. Draft-only attempts produce nothing.
 */
export function quizEvents(
  sessionId: string,
  stageId: string,
  records: readonly QuizRecordSource[],
  serverQuestions: (sceneId: string) => readonly ServerQuizQuestion[] | null,
): LearningEventInput[] {
  const ordered = [...records].sort((a, b) => a.seq - b.seq);
  const base = {
    payloadVersion: 1 as const,
    sourceType: 'quiz_attempt' as const,
    sourceId: sessionId,
    stageId,
    spaceId: null,
  };
  const events: LearningEventInput[] = [];
  const submitted = ordered.find((record) => {
    const phase = asAttempt(record.payload)?.phase;
    return phase === 'submitted' || phase === 'reviewed';
  });
  if (!submitted?.sceneId) return events;
  const sceneId = submitted.sceneId;
  const first = asAttempt(submitted.payload)!;
  const firstSnapshot = snapshotOf(first);
  const questionCount = firstSnapshot
    ? firstSnapshot.length
    : Object.keys((first.answers as Answers | undefined) ?? {}).length;
  events.push({
    ...base,
    type: 'quiz_submitted',
    sourceKey: `quiz:${sessionId}:submitted`,
    occurredAt: submitted.createdAt,
    payload: { sceneId, questionCount },
  });

  const graded = ordered.find((record) => {
    const payload = asAttempt(record.payload);
    if (!payload || record.seq < submitted.seq) return false;
    if (payload.payloadVersion !== 2) return payload.phase === 'reviewed';
    const grading = (payload.grading ?? {}) as Record<string, { status?: unknown }>;
    const snapshot = snapshotOf(payload) ?? [];
    return (
      (payload.phase === 'submitted' || payload.phase === 'reviewed') &&
      snapshot.length > 0 &&
      snapshot.every((question) => grading[question.id]?.status !== 'pending') &&
      snapshot.some((question) => grading[question.id]?.status === 'graded')
    );
  });
  if (!graded) return events;
  const payload = asAttempt(graded.payload)!;
  const snapshot = snapshotOf(payload);
  const objective = snapshot
    ? serverCheckedObjective(snapshot, (payload.answers as Answers) ?? {}, serverQuestions(sceneId))
    : null;
  events.push({
    ...base,
    type: 'quiz_graded',
    sourceKey: `quiz:${sessionId}:graded`,
    occurredAt: graded.createdAt,
    payload: {
      sceneId,
      questionCount: snapshot ? snapshot.length : questionCount,
      verification: objective ? 'server_checked' : 'unverified',
      objective,
      aiGraded: snapshot
        ? aiGradedOf(snapshot, (payload.grading ?? {}) as Record<string, unknown>)
        : null,
    },
  });
  return events;
}

// ── after-class chats (B05) ─────────────────────────────────────────────────

export interface CompanionMessageSource {
  sessionId: string;
  spaceId: string;
  classmateId: string;
  /** agent_session_events.seq of the user_message. */
  seq: number;
  /** Epoch milliseconds. */
  ts: number;
  text: string;
}

/** One record per question the student sent (the options envelope stripped). */
export function companionEvents(sources: readonly CompanionMessageSource[]): LearningEventInput[] {
  return sources.map((source) => ({
    type: 'companion_question',
    payloadVersion: 1,
    sourceType: 'companion_chat',
    sourceId: source.sessionId,
    sourceKey: `companion:${source.sessionId}:${source.seq}`,
    stageId: null,
    spaceId: source.spaceId,
    occurredAt: new Date(source.ts).toISOString(),
    payload: {
      sessionId: source.sessionId,
      classmateId: source.classmateId,
      preview: Array.from(decodeCompanionMessage(source.text).text.replace(/\s+/gu, ' ').trim())
        .slice(0, MEMORY_LIMITS.questionPreview)
        .join(''),
    },
  }));
}

// ── subject papers (B07) ────────────────────────────────────────────────────

export interface ExamAttemptSource {
  attemptId: string;
  paperId: string;
  spaceId: string;
  submittedAt: string;
  itemCount: number;
  correct: number;
  unanswered: number;
  earned: number;
  totalPoints: number;
}

/** One record per submitted attempt (its server grading; drafts are not recorded). */
export function examEvents(sources: readonly ExamAttemptSource[]): LearningEventInput[] {
  return sources.map((source) => ({
    type: 'exam_graded',
    payloadVersion: 1,
    sourceType: 'exam_attempt',
    sourceId: source.attemptId,
    sourceKey: `exam:${source.attemptId}:graded`,
    stageId: null,
    spaceId: source.spaceId,
    occurredAt: source.submittedAt,
    payload: {
      paperId: source.paperId,
      itemCount: source.itemCount,
      correct: source.correct,
      unanswered: source.unanswered,
      earned: source.earned,
      totalPoints: source.totalPoints,
    },
  }));
}

// ── switches ────────────────────────────────────────────────────────────────

export interface ProjectionControls {
  global: { enabled: boolean; enabledSince: string | null };
  spaces: ReadonlyMap<string, { enabled: boolean; enabledSince: string | null }>;
}

function onAt(control: { enabled: boolean; enabledSince: string | null }, at: number): boolean {
  return control.enabled && (!control.enabledSince || at >= Date.parse(control.enabledSince));
}

/**
 * Whether the switches allow recording this event: Memory on (and on since
 * before the event happened, so off periods stay unrecorded), and — for an
 * event inside subjects — on for at least one of its subjects. A course in
 * no subject follows the global switch only.
 */
export function eventAllowed(
  event: Pick<LearningEventInput, 'occurredAt' | 'spaceId' | 'stageId'>,
  controls: ProjectionControls,
  spacesOfStage: (stageId: string) => readonly string[],
): boolean {
  const at = Date.parse(event.occurredAt);
  if (!Number.isFinite(at) || !onAt(controls.global, at)) return false;
  const spaces = event.spaceId
    ? [event.spaceId]
    : event.stageId
      ? spacesOfStage(event.stageId)
      : [];
  if (spaces.length === 0) return true;
  return spaces.some((spaceId) => {
    const control = controls.spaces.get(spaceId);
    return !control || onAt(control, at);
  });
}
