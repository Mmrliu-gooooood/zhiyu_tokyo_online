/**
 * Review tasks, mastery evidence and Memory summaries (learning plan B12),
 * pure parts: the FSRS replay and its ratings, the evidence rule, the daily
 * plan (order, reasons, minutes, exam date and scope, the student's dates,
 * Memory off), the summary basis and when a summary may be rewritten, and
 * the strict reading of the model's summary.
 */
import { Rating } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import { renderMemoryBlock, selectMemoryContext } from '@/lib/study/memory/contracts';
import {
  SUMMARY_POLICY,
  decideSummary,
  parseSummary,
  summaryBasis,
  type ReviewSnapshot,
  type SummaryRecord,
} from '@/lib/study/memory/summary';
import {
  REVIEW_RULE_VERSION,
  type ReviewAction,
  type ReviewAnswer,
} from '@/lib/study/review/contracts';
import {
  addDays,
  buildReviewOverview,
  conceptsInScope,
  localDate,
  scopeTerms,
  type PlanContext,
  type PlanItem,
} from '@/lib/study/review/plan';
import { deriveCard, evidenceOf, questionDigest, ratingFor } from '@/lib/study/review/schedule';

const T0 = '2026-10-01T02:00:00.000Z';
const hours = (base: string, h: number) => new Date(new Date(base).getTime() + h * 3_600_000).toISOString();

const wrong = (at: string, digest = 'q0'): ReviewAnswer => ({
  at,
  outcome: 'incorrect',
  sourceType: 'exam_attempt',
  questionDigest: digest,
});
const right = (
  at: string,
  digest: string,
  practice?: ReviewAnswer['practice'],
): ReviewAnswer => ({
  at,
  outcome: 'correct',
  sourceType: 'exam_attempt',
  questionDigest: digest,
  ...(practice ? { practice } : {}),
});
const independent = { novelty: 'new', assistance: 'unassisted', variant: true, independent: true } as const;
const hinted = { novelty: 'new', assistance: 'hinted', variant: true, independent: false } as const;
const solution = { novelty: 'new', assistance: 'solution_seen', variant: true, independent: false } as const;
const seen = { novelty: 'seen', assistance: 'unassisted', variant: false, independent: false } as const;

describe('FSRS ratings and replay', () => {
  it('rates answers by what they show', () => {
    expect(ratingFor(wrong(T0), null)).toBe(Rating.Again);
    expect(ratingFor(right(T0, 'a', solution), null)).toBe(Rating.Again);
    expect(ratingFor(right(T0, 'a', hinted), null)).toBe(Rating.Hard);
    expect(ratingFor(right(T0, 'a', independent), null)).toBe(Rating.Good);
    // A seen question redone straight away is a hard recall; a day later, good.
    const previous = new Date(T0).getTime();
    expect(ratingFor(right(hours(T0, 0.2), 'q0', seen), previous)).toBe(Rating.Hard);
    expect(ratingFor(right(hours(T0, 24), 'q0', seen), previous)).toBe(Rating.Good);
  });

  it('replays from the first mistake, deterministically, in whole days', () => {
    const answers = [wrong(T0), right(hours(T0, 48), 'v1', independent)];
    const card = deriveCard(answers, [])!;
    expect(card).toEqual(deriveCard([...answers].reverse(), []));
    expect(card.card.reps).toBe(2);
    // After a mistake the next review is the next day; a later good answer pushes it out.
    const afterWrong = deriveCard([wrong(T0)], [])!;
    expect(new Date(afterWrong.fsrsDueAt).getTime() - new Date(T0).getTime()).toBe(86_400_000);
    expect(new Date(card.fsrsDueAt).getTime()).toBeGreaterThan(new Date(hours(T0, 72)).getTime());
    // A "reviewed" mark is replayed as a hard recall at its time.
    const marked = deriveCard([wrong(T0)], [{ kind: 'done', at: hours(T0, 26) }])!;
    expect(marked.card.reps).toBe(2);
    expect(marked.fsrsDueAt).not.toBe(afterWrong.fsrsDueAt);
    // Postponing or skipping changes no FSRS state.
    expect(deriveCard([wrong(T0)], [{ kind: 'skip', at: hours(T0, 1) }])!.card).toEqual(
      afterWrong.card,
    );
    expect(deriveCard([right(T0, 'a')], [])).toBeNull();
  });
});

describe('evidence rule', () => {
  const state = (answers: ReviewAnswer[], actions: ReviewAction[] = []) =>
    evidenceOf(answers, actions).state;

  it('separates redo, help, one independent pass and stable evidence', () => {
    expect(state([wrong(T0)])).toBe('pending');
    // Redoing the same question right is practice, not proof.
    expect(state([wrong(T0), right(hours(T0, 1), 'q0', seen)])).toBe('practiced');
    expect(state([wrong(T0), right(hours(T0, 1), 'q0')])).toBe('practiced');
    expect(state([wrong(T0), right(hours(T0, 1), 'v1', hinted)])).toBe('helped');
    expect(state([wrong(T0), right(hours(T0, 1), 'v1', solution)])).toBe('helped');
    expect(state([wrong(T0), right(hours(T0, 1), 'v1', independent)])).toBe('independent');
    // Two different new questions, but both straight after the mistake: not yet stable.
    expect(
      state([wrong(T0), right(hours(T0, 1), 'v1', independent), right(hours(T0, 2), 'v2', independent)]),
    ).toBe('independent');
    // The same question twice is one question.
    expect(
      state([wrong(T0), right(hours(T0, 1), 'v1', independent), right(hours(T0, 30), 'v1', independent)]),
    ).toBe('independent');
    expect(
      state([wrong(T0), right(hours(T0, 1), 'v1', independent), right(hours(T0, 30), 'v2', independent)]),
    ).toBe('stable');
    // A new mistake starts over; "reviewed" marks are counted, never evidence.
    const again = evidenceOf(
      [
        wrong(T0),
        right(hours(T0, 1), 'v1', independent),
        right(hours(T0, 30), 'v2', independent),
        wrong(hours(T0, 40)),
      ],
      [{ kind: 'done', at: hours(T0, 41) }],
    );
    expect(again.state).toBe('pending');
    expect(again.evidence).toMatchObject({ wrongCount: 2, independentQuestions: 0, reviewsDone: 1 });
  });

  it('counts questions by content', () => {
    expect(questionDigest({ stem: 'a  b', options: [{ label: 'x' }] })).toBe(
      questionDigest({ stem: 'ab', options: [{ label: 'x' }] }),
    );
    expect(questionDigest({ stem: 'ab' })).not.toBe(questionDigest({ stem: 'ab', options: [{ label: 'x' }] }));
  });
});

// ── the daily plan ──────────────────────────────────────────────────────────

const NOW = new Date('2026-10-20T04:00:00.000Z'); // 12:00 in Shanghai
const TZ = 'Asia/Shanghai';

function planItem(id: string, overrides: Partial<PlanItem> & { answers?: ReviewAnswer[] } = {}): PlanItem {
  const answers = overrides.answers ?? [wrong(hours(NOW.toISOString(), -48))];
  const actions = overrides.actions ?? [];
  const card = deriveCard(answers, actions)!;
  return {
    itemId: id,
    question: { type: 'single', stem: `题 ${id}` },
    concepts: ['导数'],
    sourceType: 'exam_attempt',
    reviewState: 'none',
    flaggedAt: null,
    fsrsDueAt: card.fsrsDueAt,
    evidenceState: card.evidenceState,
    evidence: card.evidence,
    actions,
    redo: true,
    revision: 1,
    ...overrides,
  };
}

const context = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  spaceId: 'space-a',
  now: NOW,
  timezone: TZ,
  examDate: null,
  examScope: null,
  dailyMinutes: 20,
  customMinutes: false,
  settingsRevision: 0,
  mode: 'auto',
  ...overrides,
});

describe('daily plan', () => {
  it('counts calendar days in the space time zone', () => {
    expect(localDate('2026-10-19T17:00:00.000Z', TZ)).toBe('2026-10-20');
    expect(localDate('2026-10-19T17:00:00.000Z', 'UTC')).toBe('2026-10-19');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('lists due items with reasons, in an explained order, within the minutes', () => {
    const overdue = planItem('old', { answers: [wrong(hours(NOW.toISOString(), -24 * 5))] });
    const recent = planItem('recent', {
      answers: [wrong(hours(NOW.toISOString(), -30)), wrong(hours(NOW.toISOString(), -26))],
    });
    const later = planItem('later', {
      answers: [
        wrong(hours(NOW.toISOString(), -24 * 2)),
        right(hours(NOW.toISOString(), -2), 'v1', independent),
      ],
    });
    const overview = buildReviewOverview([later, recent, overdue], context());
    expect(overview.today).toBe('2026-10-20');
    expect(overview.todayTasks.map((task) => task.itemId)).toEqual(['old', 'recent']);
    expect(overview.todayTasks[0]!.reasons).toContainEqual({ kind: 'overdue', days: 4 });
    expect(overview.todayTasks[1]!.reasons).toContainEqual({
      kind: 'recent_wrong',
      count: 2,
      days: 7,
    });
    expect(overview.upcoming.map((task) => task.itemId)).toEqual(['later']);
    expect(overview.upcoming[0]!.evidenceState).toBe('independent');
    expect(overview.ruleVersion).toBe(REVIEW_RULE_VERSION);

    // Two minutes a choice question: 3 minutes fit one; the rest overflows (never none).
    const tight = buildReviewOverview([recent, overdue], context({ dailyMinutes: 3 }));
    expect(tight.todayTasks.map((task) => task.itemId)).toEqual(['old']);
    expect(tight.overflow.map((task) => task.itemId)).toEqual(['recent']);
  });

  it('puts the exam scope first and moves reviews before the exam', () => {
    const inScope = planItem('in', { concepts: ['导数的几何意义'] });
    const outside = planItem('out', {
      concepts: ['矩阵'],
      answers: [wrong(hours(NOW.toISOString(), -48)), wrong(hours(NOW.toISOString(), -47))],
    });
    const scoped = buildReviewOverview([outside, inScope], context({ examScope: '第三章 导数，切线' }));
    expect(scoped.todayTasks.map((task) => task.itemId)).toEqual(['in', 'out']);
    expect(scoped.todayTasks[0]!.reasons).toContainEqual({ kind: 'scope', concepts: ['导数的几何意义'] });
    expect(scoped.todayTasks[1]!.reasons).toContainEqual({ kind: 'out_of_scope' });
    expect(scopeTerms('第三章 导数，切线')).toEqual(['第三章', '导数', '切线']);
    expect(conceptsInScope(['导数', '积分'], ['导数的应用'])).toEqual(['导数']);

    // A good answer schedules weeks ahead; an exam in 3 days pulls it to the day before.
    const good = planItem('good', {
      answers: [
        wrong(hours(NOW.toISOString(), -24 * 3)),
        right(hours(NOW.toISOString(), -24 * 2), 'v1', independent),
        right(hours(NOW.toISOString(), -2), 'v2', independent),
      ],
    });
    const free = [...buildReviewOverview([good], context()).stable][0]!;
    expect(free.evidenceState).toBe('stable');
    expect(free.due! > '2026-10-22').toBe(true);
    const exam = [...buildReviewOverview([good], context({ examDate: '2026-10-23' })).stable][0]!;
    expect(exam).toMatchObject({ due: '2026-10-22', dueSource: 'exam' });
    expect(exam.reasons).toContainEqual({ kind: 'exam', examDate: '2026-10-23' });
    // An exam already passed moves nothing.
    expect(buildReviewOverview([good], context({ examDate: '2026-10-19' })).stable[0]!.due).toBe(
      free.due,
    );
  });

  it('lets the student’s dates, flags and skips win, until the next answer', () => {
    const postponed = planItem('p', {
      actions: [{ kind: 'postpone', at: hours(NOW.toISOString(), -1), until: '2026-10-25' }],
    });
    const skipped = planItem('s', { actions: [{ kind: 'skip', at: hours(NOW.toISOString(), -1) }] });
    const flagged = planItem('f', {
      answers: [
        wrong(hours(NOW.toISOString(), -24 * 10)),
        right(hours(NOW.toISOString(), -24 * 9), 'v1', independent),
      ],
      reviewState: 'to_review',
      flaggedAt: hours(NOW.toISOString(), -1),
    });
    const overview = buildReviewOverview([postponed, skipped, flagged], context());
    expect(overview.upcoming.find((task) => task.itemId === 'p')).toMatchObject({
      due: '2026-10-25',
      dueSource: 'manual',
    });
    expect(overview.skipped.map((task) => task.itemId)).toEqual(['s']);
    expect(overview.todayTasks.map((task) => task.itemId)).toEqual(['f']);
    expect(overview.todayTasks[0]!.reasons).toContainEqual({ kind: 'flagged' });

    // A new answer after a postponement ends it; `clear` undoes a skip.
    const answered = planItem('p2', {
      answers: [wrong(hours(NOW.toISOString(), -48)), wrong(hours(NOW.toISOString(), -0.5))],
      actions: [{ kind: 'postpone', at: hours(NOW.toISOString(), -1), until: '2026-10-25' }],
    });
    const cleared = planItem('s2', {
      actions: [
        { kind: 'skip', at: hours(NOW.toISOString(), -2) },
        { kind: 'clear', at: hours(NOW.toISOString(), -1) },
      ],
    });
    const after = buildReviewOverview([answered, cleared], context());
    expect(after.skipped).toHaveLength(0);
    expect(after.upcoming.concat(after.todayTasks).find((task) => task.itemId === 'p2')?.dueSource).toBe(
      'fsrs',
    );
  });

  it('schedules nothing by rule with Memory off; own dates still apply', () => {
    const plain = planItem('plain');
    const own = planItem('own', {
      actions: [{ kind: 'postpone', at: hours(NOW.toISOString(), -1), until: '2026-10-22' }],
    });
    const overview = buildReviewOverview([plain, own], context({ mode: 'manual' }));
    expect(overview.mode).toBe('manual');
    expect(overview.todayTasks).toHaveLength(0);
    expect(overview.unscheduled.map((task) => task.itemId)).toEqual(['plain']);
    expect(overview.unscheduled[0]!.reasons.some((reason) => reason.kind === 'overdue')).toBe(false);
    expect(overview.upcoming.map((task) => task.itemId)).toEqual(['own']);
  });

  it('groups evidence by knowledge point without inferring across items', () => {
    const overview = buildReviewOverview(
      [
        planItem('a', { concepts: ['导数'] }),
        planItem('b', {
          concepts: ['导数', '切线'],
          answers: [wrong(hours(NOW.toISOString(), -48)), right(hours(NOW.toISOString(), -1), 'v', independent)],
        }),
        planItem('c', { concepts: [] }),
      ],
      context({ examScope: '切线' }),
    );
    expect(overview.concepts).toEqual([
      expect.objectContaining({ name: '切线', inScope: true, items: 1, states: expect.objectContaining({ independent: 1 }) }),
      expect.objectContaining({ name: '导数', inScope: false, items: 2, states: expect.objectContaining({ pending: 1, independent: 1 }) }),
    ]);
    const unlinked = [...overview.todayTasks, ...overview.upcoming].find((task) => task.itemId === 'c');
    expect(unlinked?.reasons).toContainEqual({ kind: 'unlinked' });
  });
});

// ── summaries ───────────────────────────────────────────────────────────────

const REVIEW: ReviewSnapshot = {
  states: { pending: 2, practiced: 0, helped: 1, independent: 0, stable: 0 },
  weakConcepts: ['导数'],
  stableConcepts: [],
};

const records = (count: number, start = 1): SummaryRecord[] =>
  Array.from({ length: count }, (_, index) => ({
    seq: start + index,
    type: 'course_progressed' as const,
    occurredAt: hours(T0, index),
    payload: { furthestPage: index + 1, pageCount: 9 },
    correction: null,
  }));

describe('Memory summaries', () => {
  it('hashes the inputs: same records, same hash; a payload, correction or review change differs', () => {
    const base = summaryBasis('space-a', records(4), REVIEW);
    expect(summaryBasis('space-a', [...records(4)].reverse(), REVIEW)).toEqual(base);
    expect(base.sourceWatermark).toBe(4);
    const changedPayload = records(4);
    changedPayload[1] = { ...changedPayload[1]!, payload: { furthestPage: 9, pageCount: 9 } };
    expect(summaryBasis('space-a', changedPayload, REVIEW).inputHash).not.toBe(base.inputHash);
    const corrected = records(4);
    corrected[0] = { ...corrected[0]!, correction: '这节课是别人帮我点开的' };
    expect(summaryBasis('space-a', corrected, REVIEW).inputHash).not.toBe(base.inputHash);
    expect(
      summaryBasis('space-a', records(4), { ...REVIEW, states: { ...REVIEW.states, pending: 1 } }).inputHash,
    ).not.toBe(base.inputHash);
  });

  it('calls the model only when the inputs changed enough', () => {
    const now = new Date(hours(T0, 100));
    const list = records(4);
    const basis = summaryBasis('space-a', list, REVIEW);
    expect(decideSummary(null, basis, list, now, false)).toEqual({ generate: true, reason: 'first' });
    expect(decideSummary(null, basis, list.slice(0, 2), now, false).generate).toBe(false);
    expect(decideSummary(null, basis, list, now, true)).toEqual({ generate: false, reason: 'suppressed' });
    const stored = { ...basis, status: 'ready' as const, createdAt: hours(T0, 10) };
    // Nothing new: opening the page again never calls the model.
    expect(decideSummary(stored, basis, list, now, false)).toEqual({ generate: false, reason: 'unchanged' });
    // Two more viewing records: not enough yet; a finished course or a graded paper is.
    const more = [...list, ...records(2, 5)];
    expect(decideSummary(stored, summaryBasis('space-a', more, REVIEW), more, now, false).reason).toBe(
      'too_little',
    );
    const milestone = [...more, { ...records(1, 7)[0]!, type: 'exam_graded' as const }];
    expect(
      decideSummary(stored, summaryBasis('space-a', milestone, REVIEW), milestone, now, false),
    ).toEqual({ generate: true, reason: 'changed' });
    // Never twice within the interval; a failure waits longer.
    const fresh = { ...stored, createdAt: hours(T0, 99.9) };
    expect(
      decideSummary(fresh, summaryBasis('space-a', milestone, REVIEW), milestone, now, false).reason,
    ).toBe('too_soon');
    const failed = { ...stored, status: 'failed' as const, createdAt: hours(T0, 98) };
    expect(
      decideSummary(failed, summaryBasis('space-a', milestone, REVIEW), milestone, now, false).reason,
    ).toBe('retry_later');
  });

  it('reads only a short JSON summary', () => {
    expect(parseSummary('{"summary": "最近看完了导数第一讲，测验 3 题对 2 题。"}')).toBe(
      '最近看完了导数第一讲，测验 3 题对 2 题。',
    );
    expect(parseSummary('好的：{"summary":"最近两周做了两份导数试卷，切线相关的题还有错。"}')).toMatch(/切线/);
    expect(parseSummary('最近学了导数')).toBeNull();
    expect(parseSummary('{"summary": "短"}')).toBeNull();
    expect(parseSummary(`{"summary": "${'很'.repeat(SUMMARY_POLICY.maxChars + 1)}"}`)).toBeNull();
  });

  it('is injected apart from what the student set, within its own cap', () => {
    const items = selectMemoryContext({
      preferences: [{ key: 'example_order', value: 'example_first', spaceId: null }],
      facts: [],
      spaceGoal: null,
      spaceId: 'space-a',
      summary: { text: '最近做了导数试卷，切线方程的题还有错。', sourceWatermark: 12 },
    });
    expect(items.map((item) => item.ref)).toEqual(['pref:example_order@global', 'summary:space-a@12']);
    const block = renderMemoryBlock(items);
    expect(block).toContain('本学科近期学习情况');
    expect(block.indexOf('先举一个具体例子')).toBeLessThan(block.indexOf('切线方程'));
    expect(renderMemoryBlock(items.filter((item) => item.kind === 'summary'))).not.toContain(
      '学生在 Memory 里设定',
    );
  });
});
