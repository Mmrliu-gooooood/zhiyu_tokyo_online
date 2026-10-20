/**
 * The review list of one space (learning plan B12): which cards are due on
 * the student's calendar day, in what order, why, and how many fit the
 * minutes they set. Pure; the cards come from `schedule.ts`, the dates of
 * the student's own actions win over them.
 *
 * Order of today's tasks (every step is shown as a reason, no hidden score):
 * 1. what the student scheduled or flagged themselves;
 * 2. overdue first (longest overdue first);
 * 3. inside the exam scope before outside it (when a scope is set);
 * 4. wrong more often in the last `recentWrongDays`;
 * 5. earlier due date, then the most recent mistake.
 *
 * With Memory off for the space (`manual`) nothing is scheduled by the rules:
 * only the student's own dates and flags give a due date.
 */
import {
  EVIDENCE_STATES,
  REVIEW_POLICY,
  REVIEW_RULE_VERSION,
  minutesFor,
  type CardEvidence,
  type ConceptEvidence,
  type DueSource,
  type EvidenceState,
  type ReviewAction,
  type ReviewOverview,
  type ReviewReason,
  type ReviewTaskView,
} from '@/lib/study/review/contracts';
import type { WrongReviewState, WrongSourceType } from '@/lib/study/wrongbook/contracts';

export interface PlanItem {
  itemId: string;
  question: ReviewTaskView['question'];
  concepts: string[];
  sourceType: WrongSourceType;
  /** B10 "to review" flag and when it was set (the item's last change). */
  reviewState: WrongReviewState;
  flaggedAt: string | null;
  fsrsDueAt: string;
  evidenceState: EvidenceState;
  evidence: CardEvidence;
  actions: ReviewAction[];
  redo: boolean;
  revision: number;
}

export interface PlanContext {
  spaceId: string;
  now: Date;
  timezone: string;
  examDate: string | null;
  examScope: string | null;
  dailyMinutes: number;
  customMinutes: boolean;
  settingsRevision: number;
  mode: 'auto' | 'manual';
}

// ── calendar days in a time zone ────────────────────────────────────────────

export function validTimeZone(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD` of an instant in a time zone. */
export function localDate(instant: Date | string, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

// ── exam scope ──────────────────────────────────────────────────────────────

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

/** Scope words: the free-text scope split at punctuation and line breaks. */
export function scopeTerms(scope: string | null): string[] {
  if (!scope) return [];
  return [
    ...new Set(
      scope
        .split(/[\s,，、;；。.:：/|\n()（）《》「」【】]+/u)
        .map(normalize)
        .filter((term) => Array.from(term).length >= 2),
    ),
  ];
}

/** The item's knowledge points the scope names (either text containing the other). */
export function conceptsInScope(concepts: readonly string[], terms: readonly string[]): string[] {
  if (terms.length === 0) return [];
  return concepts.filter((concept) => {
    const name = normalize(concept);
    if (Array.from(name).length < 2) return false;
    return terms.some((term) => name.includes(term) || term.includes(name));
  });
}

// ── one task ────────────────────────────────────────────────────────────────

function time(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** The student's postpone/skip still in force: made after the newest answer or "reviewed" mark. */
export function standingAction(item: Pick<PlanItem, 'actions' | 'evidence'>): {
  reset: number;
  standing: ReviewAction | null;
  last: ReviewAction | null;
} {
  const actions = [...item.actions].sort((a, b) => time(a.at) - time(b.at));
  let reset = time(item.evidence.lastAnswerAt);
  for (const action of actions) {
    if (action.kind === 'done') reset = Math.max(reset, time(action.at));
  }
  let standing: ReviewAction | null = null;
  for (const action of actions) {
    if (time(action.at) <= reset) continue;
    if (action.kind === 'postpone' || action.kind === 'skip') standing = action;
    if (action.kind === 'clear') standing = null;
  }
  return { reset, standing, last: actions.at(-1) ?? null };
}

interface Scheduled {
  view: ReviewTaskView;
  overdue: number;
  inScope: boolean;
  userSet: boolean;
  recentWrong: number;
}

function schedule(item: PlanItem, context: PlanContext, terms: string[]): Scheduled {
  const today = localDate(context.now, context.timezone);
  const { reset, standing, last } = standingAction(item);
  const skipped = standing?.kind === 'skip';
  const flagged =
    item.reviewState === 'to_review' && (!item.flaggedAt || time(item.flaggedAt) > reset);
  let due: string | null = null;
  let dueSource: DueSource | null = null;
  const reasons: ReviewReason[] = [];
  if (standing?.kind === 'postpone' && standing.until) {
    due = standing.until;
    dueSource = 'manual';
    reasons.push({ kind: 'manual', date: standing.until });
  } else if (flagged) {
    due = today;
    dueSource = 'flag';
    reasons.push({ kind: 'flagged' });
  } else if (context.mode === 'auto') {
    due = localDate(item.fsrsDueAt, context.timezone);
    dueSource = 'fsrs';
    if (context.examDate && daysBetween(today, context.examDate) > 0) {
      const latest = addDays(context.examDate, -1);
      if (daysBetween(latest, due) > 0) {
        due = latest;
        dueSource = 'exam';
        reasons.push({ kind: 'exam', examDate: context.examDate });
      }
    }
    if (dueSource === 'fsrs') {
      const late = daysBetween(due, today);
      reasons.push(late > 0 ? { kind: 'overdue', days: late } : { kind: 'due', date: due });
    }
  }
  const overdue = due ? Math.max(0, daysBetween(due, today)) : 0;

  const matched = conceptsInScope(item.concepts, terms);
  if (terms.length > 0 && matched.length > 0) reasons.push({ kind: 'scope', concepts: matched });
  else if (terms.length > 0 && item.concepts.length > 0) reasons.push({ kind: 'out_of_scope' });
  if (item.concepts.length === 0) reasons.push({ kind: 'unlinked' });

  const since = context.now.getTime() - REVIEW_POLICY.recentWrongDays * 86_400_000;
  const recentWrong = item.evidence.wrongTimes.filter((at) => time(at) >= since).length;
  if (recentWrong > 0) {
    reasons.push({ kind: 'recent_wrong', count: recentWrong, days: REVIEW_POLICY.recentWrongDays });
  }
  if (
    item.evidenceState === 'pending' &&
    item.evidence.lastAnswerAt !== null &&
    item.evidence.lastAnswerAt === item.evidence.lastWrongAt &&
    item.evidence.wrongCount === 1
  ) {
    reasons.push({ kind: 'not_rechecked' });
  }

  const { wrongTimes: _times, ...evidence } = item.evidence;
  return {
    view: {
      itemId: item.itemId,
      question: item.question,
      concepts: item.concepts,
      sourceType: item.sourceType,
      evidenceState: item.evidenceState,
      evidence,
      due,
      dueSource,
      reasons,
      minutes: minutesFor(item.question.type),
      skipped,
      lastAction: last && last.kind !== 'clear' ? last : null,
      redo: item.redo,
      revision: item.revision,
    },
    overdue,
    inScope: matched.length > 0,
    userSet: dueSource === 'manual' || dueSource === 'flag',
    recentWrong,
  };
}

function priority(a: Scheduled, b: Scheduled, scoped: boolean): number {
  return (
    Number(b.userSet) - Number(a.userSet) ||
    b.overdue - a.overdue ||
    (scoped ? Number(b.inScope) - Number(a.inScope) : 0) ||
    b.recentWrong - a.recentWrong ||
    (a.view.due ?? '').localeCompare(b.view.due ?? '') ||
    time(b.view.evidence.lastWrongAt) - time(a.view.evidence.lastWrongAt)
  );
}

// ── the overview ────────────────────────────────────────────────────────────

export function buildReviewOverview(
  items: readonly PlanItem[],
  context: PlanContext,
): ReviewOverview {
  const today = localDate(context.now, context.timezone);
  const terms = scopeTerms(context.examScope);
  const scheduled = items.map((item) => schedule(item, context, terms));

  const dueToday: Scheduled[] = [];
  const upcoming: Scheduled[] = [];
  const unscheduled: Scheduled[] = [];
  const stable: Scheduled[] = [];
  const skipped: Scheduled[] = [];
  for (const entry of scheduled) {
    const { view } = entry;
    if (view.skipped) skipped.push(entry);
    else if (view.due && daysBetween(view.due, today) >= 0) dueToday.push(entry);
    else if (view.evidenceState === 'stable') stable.push(entry);
    else if (view.due) upcoming.push(entry);
    else unscheduled.push(entry);
  }
  dueToday.sort((a, b) => priority(a, b, terms.length > 0));
  const todayTasks: ReviewTaskView[] = [];
  const overflow: ReviewTaskView[] = [];
  let minutes = 0;
  for (const entry of dueToday) {
    const fits = minutes + entry.view.minutes <= context.dailyMinutes;
    if (fits || todayTasks.length === 0) {
      todayTasks.push(entry.view);
      minutes += entry.view.minutes;
    } else {
      overflow.push(entry.view);
    }
  }
  upcoming.sort(
    (a, b) => (a.view.due ?? '').localeCompare(b.view.due ?? '') || priority(a, b, terms.length > 0),
  );
  const byRecent = (a: Scheduled, b: Scheduled) =>
    time(b.view.evidence.lastWrongAt) - time(a.view.evidence.lastWrongAt);

  const concepts = new Map<string, ConceptEvidence>();
  for (const item of items) {
    for (const name of item.concepts) {
      let entry = concepts.get(name);
      if (!entry) {
        entry = {
          name,
          inScope: terms.length ? conceptsInScope([name], terms).length > 0 : null,
          items: 0,
          states: Object.fromEntries(EVIDENCE_STATES.map((state) => [state, 0])) as Record<
            EvidenceState,
            number
          >,
        };
        concepts.set(name, entry);
      }
      entry.items += 1;
      entry.states[item.evidenceState] += 1;
    }
  }

  return {
    spaceId: context.spaceId,
    mode: context.mode,
    timezone: context.timezone,
    today,
    exam: {
      date: context.examDate,
      scope: context.examScope,
      daysLeft: context.examDate ? daysBetween(today, context.examDate) : null,
    },
    settings: {
      dailyMinutes: context.dailyMinutes,
      revision: context.settingsRevision,
      custom: context.customMinutes,
    },
    todayTasks,
    overflow,
    upcoming: upcoming.slice(0, REVIEW_POLICY.upcomingListed).map((entry) => entry.view),
    unscheduled: unscheduled.sort(byRecent).map((entry) => entry.view),
    stable: stable.sort(byRecent).map((entry) => entry.view),
    skipped: skipped.sort(byRecent).map((entry) => entry.view),
    concepts: [...concepts.values()].sort(
      (a, b) =>
        Number(b.inScope ?? false) - Number(a.inScope ?? false) ||
        b.states.pending - a.states.pending ||
        b.items - a.items ||
        a.name.localeCompare(b.name),
    ),
    ruleVersion: REVIEW_RULE_VERSION,
  };
}
