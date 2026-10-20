/**
 * Review tasks and mastery evidence (learning plan B12): wire contracts and
 * the review policy. Pure — no Next.js, browser store, database or FSRS
 * imports (the scheduler lives in `schedule.ts`, used by the server only).
 *
 * Two questions are kept apart:
 * - *when* to look at a wrong question again: an FSRS card per wrong-answer
 *   item, replayed from the item's graded answers and the student's own
 *   "reviewed" marks. The student's dates (postpone, reschedule) win over it.
 * - *what the answers show*: an evidence rule over the answers since the last
 *   mistake. Only new questions answered right without a hint or the
 *   solution count as independent; redoing the same question, or answering
 *   after a hint, is practice. No ability score is computed.
 *
 * Nothing is inferred across items: a knowledge point only groups items.
 */
import type { WrongOrigin, WrongOutcome, WrongSourceType } from '@/lib/study/wrongbook/contracts';

/** A configurable product policy, not an educational-measurement claim. */
export const REVIEW_POLICY = {
  version: 'review-v1',
  /** FSRS: target recall, longest interval in days; no same-day learning steps, no fuzz. */
  requestRetention: 0.9,
  maximumInterval: 365,
  /** Stable evidence: this many different new questions passed independently… */
  stableQuestions: 2,
  /** …at least one of them this long after the last mistake (not straight after it). */
  nonImmediateHours: 24,
  /** Answering an already-seen question again this soon counts as an immediate redo. */
  immediateMinutes: 60,
  /** "Wrong recently" in the reasons. */
  recentWrongDays: 7,
  defaultDailyMinutes: 20,
  minDailyMinutes: 5,
  maxDailyMinutes: 600,
  minutesPerItem: { choice: 2, open: 5 },
  /** Student actions one card keeps (newest). */
  actionsKept: 40,
  /** Wrong-answer times one card keeps for the reasons (newest). */
  wrongTimesKept: 10,
  /** Upcoming tasks one overview lists. */
  upcomingListed: 60,
  /** Furthest a postponement may go. */
  maxPostponeDays: 365,
} as const;

/** Bumped when the policy or the FSRS parameters change: every card is recomputed. */
export const REVIEW_RULE_VERSION = `${REVIEW_POLICY.version}/fsrs-6@ts-fsrs-5.4.2/r${REVIEW_POLICY.requestRetention}/max${REVIEW_POLICY.maximumInterval}`;

export const EVIDENCE_STATES = ['pending', 'practiced', 'helped', 'independent', 'stable'] as const;
/**
 * - pending: the newest answer is still wrong (nothing since the mistake, or wrong again).
 * - practiced: answered right since, but only on a question seen before (a redo,
 *   a classroom retake) — practice, not proof.
 * - helped: answered right after a hint or the solution.
 * - independent: one new question answered right without help.
 * - stable: `stableQuestions` different new questions, one of them not straight
 *   after the mistake.
 */
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export const REVIEW_ACTION_KINDS = ['done', 'postpone', 'skip', 'clear'] as const;
/**
 * - done: the student reviewed it (re-read the explanation, worked it again on
 *   paper): schedules the next review like a hard recall; not evidence.
 * - postpone: review on `until` (a date in the space's time zone) instead.
 * - skip: leave it out of the review list until the next answer or `clear`.
 * - clear: undo a postponement or a skip.
 */
export type ReviewActionKind = (typeof REVIEW_ACTION_KINDS)[number];

export interface ReviewAction {
  kind: ReviewActionKind;
  at: string;
  /** `YYYY-MM-DD`, postpone only. */
  until?: string;
}

/** One graded answer of an item, as the scheduler reads it. */
export interface ReviewAnswer {
  at: string;
  outcome: WrongOutcome;
  sourceType: WrongSourceType;
  /** Subject papers since B11: novelty and help. */
  practice?: WrongOrigin['practice'];
  /** Same question → same digest (independent passes count different questions). */
  questionDigest: string;
}

export interface CardEvidence {
  lastWrongAt: string | null;
  lastAnswerAt: string | null;
  wrongCount: number;
  /** Newest first, at most `wrongTimesKept`. */
  wrongTimes: string[];
  /** Since the last mistake. */
  independentQuestions: number;
  nonImmediate: boolean;
  helped: number;
  practiced: number;
  reviewsDone: number;
}

/** The FSRS state as stored (ts-fsrs Card with ISO dates). */
export interface StoredFsrsCard {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
}

// ── views ───────────────────────────────────────────────────────────────────

export type ReviewReason =
  /** FSRS put it on this date (already passed by `days`). */
  | { kind: 'overdue'; days: number }
  | { kind: 'due'; date: string }
  /** Moved before the exam (the FSRS date was after it). */
  | { kind: 'exam'; examDate: string }
  | { kind: 'scope'; concepts: string[] }
  | { kind: 'out_of_scope' }
  | { kind: 'recent_wrong'; count: number; days: number }
  | { kind: 'not_rechecked' }
  | { kind: 'flagged' }
  | { kind: 'manual'; date: string }
  | { kind: 'unlinked' };

export type DueSource = 'fsrs' | 'exam' | 'manual' | 'flag';

export interface ReviewTaskView {
  itemId: string;
  question: { type: 'single' | 'multiple' | 'short_answer'; subtype?: string; stem: string };
  concepts: string[];
  sourceType: WrongSourceType;
  evidenceState: EvidenceState;
  evidence: Omit<CardEvidence, 'wrongTimes'>;
  /** Local date (space time zone); null when nothing schedules it (Memory off, no date set). */
  due: string | null;
  dueSource: DueSource | null;
  reasons: ReviewReason[];
  minutes: number;
  skipped: boolean;
  /** The newest postpone/skip/done the student made, if any. */
  lastAction: ReviewAction | null;
  /** Its question can be answered again as it was (a question-bank question). */
  redo: boolean;
  revision: number;
}

export interface ConceptEvidence {
  name: string;
  /** null when the space has no exam scope. */
  inScope: boolean | null;
  items: number;
  states: Record<EvidenceState, number>;
}

export interface ReviewOverview {
  spaceId: string;
  /** `auto`: scheduled by the rules; `manual`: Memory is off — only the student's own dates. */
  mode: 'auto' | 'manual';
  timezone: string;
  today: string;
  exam: { date: string | null; scope: string | null; daysLeft: number | null };
  settings: { dailyMinutes: number; revision: number; custom: boolean };
  /** Due today, within the daily minutes, in priority order. */
  todayTasks: ReviewTaskView[];
  /** Also due today, beyond the daily minutes. */
  overflow: ReviewTaskView[];
  upcoming: ReviewTaskView[];
  /** Manual mode: items without a date. */
  unscheduled: ReviewTaskView[];
  stable: ReviewTaskView[];
  skipped: ReviewTaskView[];
  concepts: ConceptEvidence[];
  ruleVersion: string;
}

// ── validation ──────────────────────────────────────────────────────────────

export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

export function parseDailyMinutes(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= REVIEW_POLICY.minDailyMinutes &&
    value <= REVIEW_POLICY.maxDailyMinutes
    ? value
    : null;
}

export function minutesFor(type: ReviewTaskView['question']['type']): number {
  return type === 'short_answer'
    ? REVIEW_POLICY.minutesPerItem.open
    : REVIEW_POLICY.minutesPerItem.choice;
}
