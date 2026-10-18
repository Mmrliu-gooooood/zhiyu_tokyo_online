/**
 * Rules that turn saved answers into wrong-answer-book entries (learning
 * plan B10). Pure: the server reads the sources and writes the rows; these
 * functions only decide which entries a source state implies. Same input →
 * same source keys and content, so a replay never duplicates anything.
 *
 * - Papers: the current outcome of every item (choice items as frozen at
 *   submission, open items by their latest succeeded official grading).
 *   Waiting, running, failed and ungradable items produce nothing.
 * - Classroom quizzes: v2 attempts only (they froze the questions); the
 *   newest record of a submitted attempt has the most grading. Questions
 *   still pending or ungradable produce nothing. v1 attempts are counted as
 *   legacy (they never saved the questions, so nothing can be shown).
 * - Learning checks: graded questions of a submitted check.
 */
import {
  scoredGrading,
  summarizeReport,
  type AttemptAnswers,
  type AttemptGrading,
  type ItemGradingView,
  type PaperItemKey,
  type PaperItemView,
} from '@/lib/study/assessments/contracts';
import { isLearningCheckPayloadV1, type LearningCheckPayloadV1 } from '@/lib/learning/contracts';
import type { ServerQuizQuestion } from '@/lib/study/memory/projection';
import {
  assistanceLevel,
  isIndependentPass,
  type AttemptAssistanceRecord,
} from '@/lib/study/practice/contracts';
import { effectiveRubric } from '@/lib/study/questions/contracts';

import {
  WRONGBOOK_LIMITS,
  cleanConcepts,
  type WrongEntry,
  type WrongGrading,
  type WrongOutcome,
  type WrongQuestion,
  type WrongResponse,
} from './contracts';

function asArray(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function outcomeOf(earned: number, points: number, answered: boolean): WrongOutcome {
  if (earned >= points) return 'correct';
  if (!answered) return 'unanswered';
  return earned > 0 ? 'partial' : 'incorrect';
}

// ── subject papers (B07/B09) ────────────────────────────────────────────────

export interface ExamItemSource extends PaperItemView, PaperItemKey {
  questionId: string | null;
  packQuestion: string | null;
  contentHash: string;
}

export interface ExamAttemptSource {
  attemptId: string;
  paperId: string;
  paperTitle: string;
  submittedAt: string;
  answers: AttemptAnswers;
  grading: AttemptGrading;
  gradings: ReadonlyMap<number, readonly ItemGradingView[]>;
  items: readonly ExamItemSource[];
  /** Novelty and help shown per item (B11 attempts; empty before). */
  assistance?: AttemptAssistanceRecord;
}

/** Same bank question in later papers (any version) → same item. */
export function examQuestionKey(
  item: Pick<ExamItemSource, 'questionId' | 'packQuestion' | 'contentHash'> & {
    source?: Pick<ExamItemSource['source'], 'generation'>;
  },
) {
  // A variant (B11) answers join the history of the question it varies.
  const family = item.source?.generation?.family;
  if (family) return family.questionKey;
  if (item.questionId) return `bank:${item.questionId}`;
  if (item.packQuestion) return `pack:${item.packQuestion}`;
  return `exam:${item.contentHash}`;
}

export function examEntries(source: ExamAttemptSource): WrongEntry[] {
  const { items: current } = summarizeReport(source.grading, source.gradings);
  const results = new Map(current.map((result) => [result.position, result]));
  const entries: WrongEntry[] = [];
  for (const item of source.items) {
    const result = results.get(item.position);
    if (!result || result.outcome === 'pending' || result.outcome === 'ungradable') continue;
    const answer = source.answers[String(item.position)];
    const open = item.type === 'short_answer';
    let response: WrongResponse = null;
    if (Array.isArray(answer) && answer.length) response = { choices: [...answer] };
    else if (answer && !Array.isArray(answer) && (answer.text.trim() || answer.final)) {
      response = { text: answer.text, ...(answer.final ? { final: answer.final } : {}) };
    }
    let grading: WrongGrading = {
      by: 'server',
      method: open ? 'blank' : 'answer_key',
      version: source.grading.version,
    };
    if (open && result.outcome !== 'unanswered') {
      const gradings = source.gradings.get(item.position) ?? [];
      const scored = scoredGrading(gradings);
      if (!scored?.result) continue;
      const rubric = effectiveRubric({ points: item.points, guide: item.guide ?? undefined });
      grading = {
        by: 'server',
        method: 'rubric',
        version: scored.grader?.version ?? source.grading.version,
        model: scored.grader?.model ?? null,
        feedback: scored.result.feedback,
        shortcomings: scored.result.shortcomings,
        criteria: scored.result.criteria.map((criterion) => ({
          id: criterion.id,
          text: rubric.find((point) => point.id === criterion.id)?.text ?? '',
          awarded: criterion.awarded,
          points: criterion.points,
          by: criterion.by,
          comment: criterion.comment,
        })),
        ...(scored.kind === 'review' ? { reviewed: true } : {}),
      };
    }
    const question: WrongQuestion = {
      type: item.type,
      ...(item.subtype ? { subtype: item.subtype } : {}),
      stem: item.stem,
      options: item.options,
      answer: open ? [] : [...item.answer],
      ...(open && item.guide?.referenceAnswer ? { reference: item.guide.referenceAnswer } : {}),
      ...(open && item.guide?.finalAnswer ? { finalAnswer: item.guide.finalAnswer } : {}),
      ...(item.explanation ? { explanation: item.explanation } : {}),
      concepts: cleanConcepts(item.concepts),
      source: item.source,
      ...(item.figures.length ? { figures: item.figures } : {}),
    };
    const outcome: WrongOutcome =
      result.outcome === 'unanswered'
        ? 'unanswered'
        : outcomeOf(result.earned, result.points, response !== null);
    // B11: whether the question was new, whether help was shown, whether it is a variant.
    // Only attempts that recorded it (or variants) carry this, so earlier entries stay as they were.
    const record = source.assistance?.items?.[String(item.position)];
    const variant = Boolean(item.source.generation?.family);
    const practice =
      record || variant
        ? {
            practice: {
              novelty: record?.novelty ?? ('unknown' as const),
              assistance: assistanceLevel(record),
              variant,
              independent: isIndependentPass(outcome, record),
            },
          }
        : {};
    entries.push({
      questionKey: examQuestionKey(item),
      sourceType: 'exam_attempt',
      sourceKey: `exam:${source.attemptId}:${item.position}`,
      stageId: null,
      attemptId: source.attemptId,
      occurredAt: source.submittedAt,
      outcome,
      earned: result.earned,
      points: result.points,
      question,
      response,
      grading,
      origin: {
        paperId: source.paperId,
        paperTitle: source.paperTitle,
        attemptId: source.attemptId,
        position: item.position,
        ...practice,
      },
    });
  }
  return entries;
}

// ── classroom quizzes (RuntimeStore quizAttempt v2) ─────────────────────────

/** One submitted attempt: its newest record (most grading) and when it was first submitted. */
export interface QuizSessionSource {
  sessionId: string;
  stageId: string;
  courseTitle: string;
  sceneId: string | null;
  submittedAt: string;
  payload: unknown;
}

const SUBMITTED = new Set(['submitted', 'reviewed']);

/** Whether a choice question still exists unchanged (text and key) in the stored course. */
function checkedAgainstCourse(
  question: { id: string; type: string; question: string; answer: string[] },
  stored: readonly ServerQuizQuestion[] | null,
): boolean {
  const match = stored?.find((candidate) => candidate.id === question.id);
  const key = asArray(match?.answer);
  return (
    !!match &&
    match.type === question.type &&
    match.question === question.question &&
    key.length > 0 &&
    sameSet(key, question.answer)
  );
}

/** A classroom quiz question (a v2 snapshot entry or the stored course's question) in wrong-book form. */
export function quizQuestion(snapshot: Record<string, unknown>): WrongQuestion | null {
  const type =
    snapshot.type === 'multiple'
      ? 'multiple'
      : snapshot.type === 'short_answer'
        ? 'short_answer'
        : snapshot.type === 'single'
          ? 'single'
          : null;
  if (!type) return null;
  const key = asArray(snapshot.answer);
  const options = Array.isArray(snapshot.options)
    ? snapshot.options.flatMap((option) => {
        const value = record(option);
        return value && typeof value.value === 'string'
          ? [{ value: value.value, label: String(value.label ?? '') }]
          : [];
      })
    : [];
  return {
    type,
    stem: typeof snapshot.question === 'string' ? snapshot.question : '',
    options,
    answer: type === 'short_answer' ? [] : key,
    ...(type === 'short_answer' && text(snapshot.commentPrompt)
      ? { reference: text(snapshot.commentPrompt) }
      : type === 'short_answer' && key.length
        ? { reference: key.join('\n') }
        : {}),
    ...(text(snapshot.analysis) ? { explanation: text(snapshot.analysis) } : {}),
    concepts: [],
  };
}

/**
 * Whether the course still asks the question exactly as it was asked
 * (wording, options, key, explanation), compared field by field so the
 * stored key order does not matter.
 */
export function sameQuizQuestion(asked: WrongQuestion, current: unknown): boolean {
  const now = record(current) ? quizQuestion(record(current)!) : null;
  return now !== null && stable(now) === stable({ ...asked, concepts: [] });
}

export function quizEntries(
  source: QuizSessionSource,
  serverQuestions: (sceneId: string) => readonly ServerQuizQuestion[] | null,
): { entries: WrongEntry[]; legacy: boolean } {
  const payload = record(source.payload);
  if (!payload || !SUBMITTED.has(String(payload.phase)) || !source.sceneId) {
    return { entries: [], legacy: false };
  }
  if (payload.payloadVersion !== 2 || !Array.isArray(payload.questionSnapshot)) {
    return { entries: [], legacy: true };
  }
  const sceneId = source.sceneId;
  const answers = record(payload.answers) ?? {};
  const grading = record(payload.grading) ?? {};
  const contentRevision = text(payload.contentRevision);
  const stored = serverQuestions(sceneId);
  const entries: WrongEntry[] = [];
  for (const raw of payload.questionSnapshot) {
    const snapshot = record(raw);
    if (!snapshot || typeof snapshot.id !== 'string' || typeof snapshot.type !== 'string') continue;
    const question = quizQuestion(snapshot);
    if (!question) continue;
    const type = question.type;
    const fact = record(grading[snapshot.id]);
    if (fact?.status !== 'graded') continue;
    const result = record(fact.result) ?? {};
    const provenance = record(fact.provenance) ?? {};
    const points = typeof snapshot.points === 'number' && snapshot.points > 0 ? snapshot.points : 1;
    const earned =
      typeof result.earned === 'number' && result.earned >= 0 ? Math.min(result.earned, points) : 0;
    const key = question.answer;
    const rawAnswer = answers[snapshot.id];
    let response: WrongResponse = null;
    if (type === 'short_answer') {
      if (typeof rawAnswer === 'string' && rawAnswer.trim()) response = { text: rawAnswer };
    } else {
      const choices = asArray(rawAnswer);
      if (choices.length) response = { choices };
    }
    const basis = provenance.basis;
    const stem = question.stem;
    entries.push({
      questionKey: `quiz:${source.stageId}:${sceneId}:${snapshot.id}`,
      sourceType: 'quiz_attempt',
      sourceKey: `quiz:${source.sessionId}:${snapshot.id}`,
      stageId: source.stageId,
      attemptId: null,
      occurredAt: source.submittedAt,
      outcome:
        basis === 'blank-answer' ? 'unanswered' : outcomeOf(earned, points, response !== null),
      earned,
      points,
      question,
      response,
      grading: {
        by: 'classroom',
        method:
          basis === 'answer-key' ? 'answer_key' : basis === 'blank-answer' ? 'blank' : 'model',
        version: text(provenance.ruleVersion) ?? 'quiz-grading-v1',
        ...(text(provenance.model) ? { model: text(provenance.model) } : {}),
        ...(type !== 'short_answer'
          ? {
              checked: checkedAgainstCourse(
                { id: snapshot.id, type, question: stem, answer: key },
                stored,
              ),
            }
          : {}),
        ...(text(result.aiComment) ? { feedback: text(result.aiComment) } : {}),
      },
      origin: {
        stageId: source.stageId,
        sceneId,
        courseTitle: source.courseTitle,
        ...(contentRevision ? { contentRevision } : {}),
      },
    });
  }
  return { entries, legacy: false };
}

// ── classroom learning checks (RuntimeStore learningCheck) ──────────────────

export interface CheckSessionSource {
  sessionId: string;
  stageId: string;
  submittedAt: string;
  /** The newest record's payload. */
  payload: unknown;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function checkEntries(source: CheckSessionSource): WrongEntry[] {
  if (!isLearningCheckPayloadV1(source.payload)) return [];
  const payload: LearningCheckPayloadV1 = source.payload;
  if (!SUBMITTED.has(payload.lifecycle.phase)) return [];
  const fragments = new Map(payload.source.fragments.map((fragment) => [fragment.id, fragment]));
  const entries: WrongEntry[] = [];
  for (const item of payload.questionSet.questions) {
    const grade = payload.lifecycle.grading[item.id];
    if (grade?.status !== 'graded') continue;
    const raw = payload.lifecycle.answers[item.id];
    let response: WrongResponse = null;
    if (item.type === 'short_answer') {
      if (typeof raw === 'string' && raw.trim()) response = { text: raw };
    } else {
      const choices = asArray(raw);
      if (choices.length) response = { choices };
    }
    const evidence = item.sourceRefs
      .flatMap((ref) => (fragments.has(ref) ? [fragments.get(ref)!] : []))
      .slice(0, WRONGBOOK_LIMITS.evidenceFragments)
      .map((fragment) => ({
        sceneId: fragment.sourceRef.sceneId,
        sceneTitle: fragment.sourceRef.sceneTitle,
        digest: fragment.digest,
        text: clip(fragment.text, WRONGBOOK_LIMITS.evidenceChars),
      }));
    entries.push({
      questionKey: `check:${payload.identity.attemptId}:${item.id}`,
      sourceType: 'learning_check',
      sourceKey: `check:${payload.identity.attemptId}:${item.id}`,
      stageId: source.stageId,
      attemptId: null,
      occurredAt: source.submittedAt,
      outcome: outcomeOf(grade.score, item.maxScore, response !== null),
      earned: grade.score,
      points: item.maxScore,
      question: {
        type: item.type,
        stem: item.prompt,
        options: (item.options ?? []).map((option) => ({
          value: option.value,
          label: option.label,
        })),
        answer: item.type === 'short_answer' ? [] : [...(item.correctAnswer ?? [])],
        ...(item.type === 'short_answer' ? { reference: item.scoringGuide } : {}),
        explanation: item.explanation,
        concepts: cleanConcepts([item.conceptId]),
        evidence,
      },
      response,
      grading: {
        by: 'classroom',
        method: grade.basis === 'deterministic' ? 'answer_key' : 'model',
        version: payload.questionSet.scoringVersion,
        // The classroom records no grader model for a check answer
        // (generation.model is the model that wrote the questions), so none is shown.
        feedback: grade.comment,
      },
      origin: {
        stageId: source.stageId,
        ...(evidence[0] ? { sceneId: evidence[0].sceneId } : {}),
        courseTitle: payload.source.courseTitle,
        contentRevision: payload.source.contentRevision,
        checkKind: payload.identity.source,
      },
    });
  }
  return entries;
}

// ── storage ─────────────────────────────────────────────────────────────────

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, member]) => `${JSON.stringify(key)}:${stable(member)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** What a stored occurrence is compared on (hashed by the server). */
export function entryFingerprint(entry: WrongEntry): string {
  return stable({
    occurredAt: entry.occurredAt,
    outcome: entry.outcome,
    earned: entry.earned,
    points: entry.points,
    question: entry.question,
    response: entry.response,
    grading: entry.grading,
    origin: entry.origin,
  });
}
