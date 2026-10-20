/**
 * The review card of one wrong-answer item (learning plan B12), replayed from
 * its graded answers and the student's "reviewed" marks. Server only (it
 * imports ts-fsrs); deterministic, so replaying the same inputs gives the same
 * card and a regrade simply recomputes it.
 *
 * FSRS decides only *when* to review. Ratings (a product policy):
 * - wrong (incorrect, partial, unanswered), or right after seeing the
 *   solution → Again
 * - right after a hint, a question seen before redone within
 *   `immediateMinutes`, or a "reviewed" mark → Hard
 * - right on a new question without help, or a seen question later on → Good
 *
 * The evidence state (what the answers show) is a separate rule over the
 * answers since the last mistake; see `EvidenceState`.
 */
import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type Grade } from 'ts-fsrs';

import {
  REVIEW_POLICY,
  type CardEvidence,
  type EvidenceState,
  type ReviewAction,
  type ReviewAnswer,
  type StoredFsrsCard,
} from '@/lib/study/review/contracts';
import { isWrong } from '@/lib/study/wrongbook/contracts';

const scheduler = fsrs(
  generatorParameters({
    request_retention: REVIEW_POLICY.requestRetention,
    maximum_interval: REVIEW_POLICY.maximumInterval,
    enable_fuzz: false,
    enable_short_term: false,
  }),
);

export interface DerivedCard {
  card: StoredFsrsCard;
  fsrsDueAt: string;
  evidenceState: EvidenceState;
  evidence: CardEvidence;
}

function time(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** The FSRS grade one answer gets; `previousAt` is the answer or mark before it. */
export function ratingFor(answer: ReviewAnswer, previousAt: number | null): Grade {
  if (isWrong(answer.outcome)) return Rating.Again;
  const practice = answer.practice;
  if (practice?.assistance === 'solution_seen') return Rating.Again;
  if (practice?.assistance === 'hinted') return Rating.Hard;
  if (practice?.independent) return Rating.Good;
  const immediate =
    previousAt !== null &&
    time(answer.at) - previousAt < REVIEW_POLICY.immediateMinutes * 60_000;
  return immediate ? Rating.Hard : Rating.Good;
}

function stored(card: Card): StoredFsrsCard {
  return {
    due: card.due.toISOString(),
    stability: Number(card.stability.toFixed(6)),
    difficulty: Number(card.difficulty.toFixed(6)),
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  };
}

/** What the answers since the last mistake show. */
export function evidenceOf(
  answers: readonly ReviewAnswer[],
  actions: readonly ReviewAction[],
): { state: EvidenceState; evidence: CardEvidence } {
  const sorted = [...answers].sort((a, b) => time(a.at) - time(b.at));
  let lastWrongAt: string | null = null;
  let wrongCount = 0;
  const wrongTimes: string[] = [];
  let independent = new Set<string>();
  let nonImmediate = false;
  let helped = 0;
  let practiced = 0;
  for (const answer of sorted) {
    if (isWrong(answer.outcome)) {
      lastWrongAt = answer.at;
      wrongCount += 1;
      wrongTimes.unshift(answer.at);
      independent = new Set();
      nonImmediate = false;
      helped = 0;
      practiced = 0;
      continue;
    }
    if (!lastWrongAt) continue;
    const assistance = answer.practice?.assistance ?? 'unassisted';
    if (answer.practice?.independent) {
      independent.add(answer.questionDigest);
      if (time(answer.at) - time(lastWrongAt) >= REVIEW_POLICY.nonImmediateHours * 3_600_000) {
        nonImmediate = true;
      }
    } else if (assistance !== 'unassisted') {
      helped += 1;
    } else {
      practiced += 1;
    }
  }
  const last = sorted.at(-1) ?? null;
  let state: EvidenceState;
  if (!last || isWrong(last.outcome)) state = 'pending';
  else if (independent.size >= REVIEW_POLICY.stableQuestions && nonImmediate) state = 'stable';
  else if (independent.size > 0) state = 'independent';
  else if (helped > 0) state = 'helped';
  else state = 'practiced';
  return {
    state,
    evidence: {
      lastWrongAt,
      lastAnswerAt: last?.at ?? null,
      wrongCount,
      wrongTimes: wrongTimes.slice(0, REVIEW_POLICY.wrongTimesKept),
      independentQuestions: independent.size,
      nonImmediate,
      helped,
      practiced,
      reviewsDone: actions.filter((action) => action.kind === 'done').length,
    },
  };
}

/**
 * Replay an item's answers (from its first mistake) and "reviewed" marks
 * through FSRS. Null when there is no wrong answer to start from.
 */
export function deriveCard(
  answers: readonly ReviewAnswer[],
  actions: readonly ReviewAction[],
): DerivedCard | null {
  const sorted = [...answers].sort((a, b) => time(a.at) - time(b.at));
  const first = sorted.findIndex((answer) => isWrong(answer.outcome));
  if (first < 0) return null;
  const start = time(sorted[first]!.at);
  type Step = { at: number; answer: ReviewAnswer | null };
  const steps: Step[] = [
    ...sorted.slice(first).map((answer) => ({ at: time(answer.at), answer })),
    ...actions
      .filter((action) => action.kind === 'done' && time(action.at) >= start)
      .map((action) => ({ at: time(action.at), answer: null })),
  ].sort((a, b) => a.at - b.at || (a.answer ? 0 : 1) - (b.answer ? 0 : 1));

  let card = createEmptyCard(new Date(start));
  let previousAt: number | null = null;
  for (const step of steps) {
    // FSRS needs time to move forward; equal or earlier times review "now".
    const lastReview = card.last_review ? card.last_review.getTime() : start;
    const at = new Date(Math.max(step.at, lastReview));
    const grade = step.answer ? ratingFor(step.answer, previousAt) : Rating.Hard;
    card = scheduler.next(card, at, grade).card;
    previousAt = step.at;
  }
  const { state, evidence } = evidenceOf(sorted, actions);
  return {
    card: stored(card),
    fsrsDueAt: card.due.toISOString(),
    evidenceState: state,
    evidence,
  };
}

/** Same question → same digest (stem and options, whitespace-insensitive). */
export function questionDigest(question: {
  stem: string;
  options?: ReadonlyArray<{ label: string }>;
}): string {
  const text = [question.stem, ...(question.options ?? []).map((option) => option.label)]
    .join('\u0001')
    .replace(/\s+/gu, '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
