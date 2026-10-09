/**
 * Learning plan B06 pure rules: explicit-statement detection for confirm
 * prompts, what one turn receives from Memory (subject over global, caps),
 * which saved facts become which events (stable keys, server-checked quiz
 * scores, no mastery), the on/off filter, and the rule-based recent state.
 */
import { describe, expect, it } from 'vitest';

import {
  approximateTokens,
  detectPreferenceStatements,
  parseEvidence,
  parsePreferenceValue,
  renderMemoryBlock,
  selectMemoryContext,
  suggestionsToOffer,
  summaryNeedsRefresh,
  type PreferenceView,
} from '@/lib/study/memory/contracts';
import {
  companionEvents,
  eventAllowed,
  progressEvents,
  quizEvents,
  serverCheckedObjective,
  type ProjectionControls,
} from '@/lib/study/memory/projection';
import { aggregateRecentState, type RecentStateRecord } from '@/lib/study/memory/recent-state';
import { encodeCompanionMessage } from '@/lib/study/companion/contracts';

const pref = (
  key: PreferenceView['key'],
  value: string,
  spaceId: string | null = null,
): Pick<PreferenceView, 'key' | 'value' | 'spaceId'> => ({ key, value, spaceId });

describe('confirm prompts: explicit standing statements only', () => {
  it('detects standing wishes and ignores one-off requests', () => {
    expect(detectPreferenceStatements('以后先举个例子再讲吧')).toEqual([
      { key: 'example_order', value: 'example_first' },
    ]);
    expect(detectPreferenceStatements('我更喜欢你先给我一点提示，别直接告诉我答案')).toEqual([
      { key: 'hint_mode', value: 'hint_first' },
    ]);
    expect(detectPreferenceStatements('每次都讲得简短一点')).toEqual([
      { key: 'explanation_length', value: 'brief' },
    ]);
    expect(detectPreferenceStatements('From now on, start with an example please')).toEqual([
      { key: 'example_order', value: 'example_first' },
    ]);
    // No standing marker: a request for this answer only.
    expect(detectPreferenceStatements('这题先举个例子')).toEqual([]);
    expect(detectPreferenceStatements('导数是什么？')).toEqual([]);
  });

  it('does not offer what is already set or was deleted/declined', () => {
    const text = '以后都先举例子';
    expect(suggestionsToOffer(text, [], new Set(), 'space-a')).toHaveLength(1);
    expect(
      suggestionsToOffer(text, [pref('example_order', 'example_first')], new Set(), 'space-a'),
    ).toEqual([]);
    // A subject override decides for that subject.
    expect(
      suggestionsToOffer(
        text,
        [
          pref('example_order', 'example_first'),
          pref('example_order', 'definition_first', 'space-a'),
        ],
        new Set(),
        'space-a',
      ),
    ).toHaveLength(1);
    expect(
      suggestionsToOffer(text, [], new Set(['example_order=example_first']), 'space-a'),
    ).toEqual([]);
  });

  it('validates values and evidence', () => {
    expect(parsePreferenceValue('hint_mode', 'direct')).toBe('direct');
    expect(parsePreferenceValue('hint_mode', 'sometimes')).toBeNull();
    expect(parsePreferenceValue('learning_goal', '  期末 85 分 \n')).toBe('期末 85 分');
    expect(parsePreferenceValue('learning_goal', 'x'.repeat(201))).toBeNull();
    expect(parseEvidence({ sessionId: 'abc_1', excerpt: '以后先举例' })).toEqual({
      sessionId: 'abc_1',
      excerpt: '以后先举例',
    });
    expect(parseEvidence({ sessionId: '../x' })).toBeUndefined();
    expect(parseEvidence(null)).toBeNull();
  });
});

describe('what one turn receives', () => {
  it('prefers the subject value, adds the goal and facts, and skips corrections', () => {
    const items = selectMemoryContext({
      preferences: [
        pref('example_order', 'definition_first'),
        pref('example_order', 'example_first', 'space-a'),
        pref('hint_mode', 'hint_first'),
        pref('explanation_length', 'brief', 'space-b'),
      ],
      facts: [
        { id: 'mf-1', text: '我在准备期中考试', spaceId: 'space-a', origin: 'manual' },
        { id: 'mf-2', text: '这次测验是乱点的', spaceId: null, origin: 'correction' },
        { id: 'mf-3', text: '我是高二学生', spaceId: null, origin: 'confirmed_prompt' },
      ],
      spaceGoal: { goal: '期末 85 分', examDate: '2026-12-20' },
      spaceId: 'space-a',
    });
    expect(items.map((item) => item.ref)).toEqual([
      'pref:example_order@space',
      'pref:hint_mode@global',
      'goal:space',
      'fact:mf-1',
      'fact:mf-3',
    ]);
    expect(items[0]!.text).toContain('先举一个具体例子');
    const block = renderMemoryBlock(items);
    expect(block).toContain('所有学伴共用');
    expect(block).toContain('不要把它当作学生已经掌握');
    expect(block).not.toContain('乱点');
    expect(block).not.toContain('简短');
    expect(renderMemoryBlock([])).toBe('');
  });

  it('respects the item and token caps', () => {
    const facts = Array.from({ length: 10 }, (_, index) => ({
      id: `mf-${index}`,
      text: '很长的事实'.repeat(30),
      spaceId: null,
      origin: 'manual' as const,
    }));
    const items = selectMemoryContext(
      { preferences: [], facts, spaceGoal: null, spaceId: 'space-a' },
      { items: 8, facts: 4, tokens: 300 },
    );
    const tokens = items.reduce((sum, item) => sum + approximateTokens(item.text) + 2, 0);
    expect(tokens).toBeLessThanOrEqual(300);
    expect(items.length).toBeLessThanOrEqual(4);
    expect(approximateTokens('先举例 abcd')).toBe(3 + 2);
  });
});

describe('projection rules', () => {
  it('maps progress to stable viewing records, never mastery', () => {
    const base = {
      stageId: 'stage-a',
      sceneIndex: 2,
      sceneCount: 3,
      furthestSceneIndex: 2,
      reachedEndAt: null,
      startedAt: '2026-10-08T01:00:00.000Z',
      observedAt: '2026-10-08T01:10:00.000Z',
      updatedAt: '2026-10-08T01:10:01.000Z',
    };
    expect(progressEvents(base).map((event) => event.sourceKey)).toEqual([
      'progress:stage-a:started',
      'progress:stage-a:page:3',
    ]);
    const finished = progressEvents({ ...base, reachedEndAt: '2026-10-08T01:12:00.000Z' });
    expect(finished.map((event) => event.type)).toEqual([
      'course_started',
      'course_progressed',
      'course_finished',
    ]);
    expect(JSON.stringify(finished)).not.toMatch(/master|掌握/i);
    // Back on page 1 after reaching page 3: same keys, the page time is the last save.
    const back = progressEvents({ ...base, sceneIndex: 0 });
    expect(back[1]!.occurredAt).toBe(base.updatedAt);
    expect(progressEvents({ ...base, furthestSceneIndex: 0, sceneIndex: 0 })).toHaveLength(1);
  });

  const snapshot = [
    { id: 'q1', type: 'single', question: '1+1?', answer: ['B'], points: 1 },
    { id: 'q2', type: 'multiple', question: '偶数?', answer: ['A', 'C'], points: 1 },
    { id: 'q3', type: 'short_answer', question: '解释', points: 2 },
  ];
  const server = [
    { id: 'q1', type: 'single', question: '1+1?', answer: ['B'] },
    { id: 'q2', type: 'multiple', question: '偶数?', answer: ['C', 'A'] },
    { id: 'q3', type: 'short_answer', question: '解释' },
  ];

  it('re-grades choice questions on the server and refuses changed quizzes', () => {
    const answers = { q1: 'B', q2: ['A'], q3: '因为' };
    expect(serverCheckedObjective(snapshot, answers, server)).toEqual({ correct: 1, total: 2 });
    // The client claimed both correct: the server's key decides.
    expect(serverCheckedObjective(snapshot, { q1: 'B', q2: ['A', 'C'] }, server)).toEqual({
      correct: 2,
      total: 2,
    });
    const edited = server.map((question) =>
      question.id === 'q1' ? { ...question, answer: ['C'] } : question,
    );
    expect(serverCheckedObjective(snapshot, answers, edited)).toBeNull();
    expect(serverCheckedObjective(snapshot, answers, null)).toBeNull();
  });

  it('emits submitted then graded for one attempt, with AI grades labelled', () => {
    const submitted = {
      payloadVersion: 2,
      phase: 'submitted',
      questionSnapshot: snapshot,
      answers: { q1: 'B', q2: ['A', 'C'], q3: '因为' },
      grading: { q1: { status: 'graded' }, q2: { status: 'graded' }, q3: { status: 'pending' } },
    };
    const graded = {
      ...submitted,
      grading: {
        q1: { status: 'graded' },
        q2: { status: 'graded' },
        q3: {
          status: 'graded',
          result: { earned: 1 },
          provenance: { basis: 'rubric' },
        },
      },
    };
    const records = [
      {
        seq: 0,
        sceneId: 'scene-q',
        createdAt: '2026-10-08T02:00:00.000Z',
        payload: { payloadVersion: 2, phase: 'draft', answers: {} },
      },
      { seq: 1, sceneId: 'scene-q', createdAt: '2026-10-08T02:01:00.000Z', payload: submitted },
      { seq: 2, sceneId: 'scene-q', createdAt: '2026-10-08T02:02:00.000Z', payload: graded },
    ];
    const events = quizEvents('quiz-attempt:s1', 'stage-a', records, () => server);
    expect(events.map((event) => [event.type, event.sourceKey])).toEqual([
      ['quiz_submitted', 'quiz:quiz-attempt:s1:submitted'],
      ['quiz_graded', 'quiz:quiz-attempt:s1:graded'],
    ]);
    expect(events[1]!.payload).toEqual({
      sceneId: 'scene-q',
      questionCount: 3,
      verification: 'server_checked',
      objective: { correct: 2, total: 2 },
      aiGraded: { count: 1, earned: 1, points: 2 },
    });
    // Draft only: nothing.
    expect(quizEvents('quiz-attempt:s2', 'stage-a', records.slice(0, 1), () => server)).toEqual([]);
    // Still pending: submitted only.
    expect(
      quizEvents('quiz-attempt:s3', 'stage-a', records.slice(0, 2), () => server),
    ).toHaveLength(1);
  });

  it('records one chat question per message, without the options envelope', () => {
    const [event] = companionEvents([
      {
        sessionId: 's-1',
        spaceId: 'space-a',
        classmateId: 'cm-0123456789abcdef',
        seq: 4,
        ts: Date.parse('2026-10-08T03:00:00.000Z'),
        text: encodeCompanionMessage('导数的几何意义是什么？', {
          discuss: ['cm-fedcba9876543210'],
        }),
      },
    ]);
    expect(event).toMatchObject({
      sourceKey: 'companion:s-1:4',
      spaceId: 'space-a',
      payload: { preview: '导数的几何意义是什么？', classmateId: 'cm-0123456789abcdef' },
    });
  });

  it('applies the global switch, its last turn-on time and the subject switches', () => {
    const at = '2026-10-08T05:00:00.000Z';
    const on: ProjectionControls = {
      global: { enabled: true, enabledSince: null },
      spaces: new Map(),
    };
    const event = { occurredAt: at, spaceId: null, stageId: 'stage-a' };
    expect(eventAllowed(event, on, () => [])).toBe(true);
    expect(
      eventAllowed(event, { ...on, global: { enabled: false, enabledSince: null } }, () => []),
    ).toBe(false);
    // Turned back on after the event: the off period stays unrecorded.
    expect(
      eventAllowed(
        event,
        { ...on, global: { enabled: true, enabledSince: '2026-10-08T06:00:00.000Z' } },
        () => [],
      ),
    ).toBe(false);
    const spaces = new Map([['space-a', { enabled: false, enabledSince: null }]]);
    expect(eventAllowed(event, { ...on, spaces }, () => ['space-a'])).toBe(false);
    // In two subjects, one still on: recorded.
    expect(eventAllowed(event, { ...on, spaces }, () => ['space-a', 'space-b'])).toBe(true);
    expect(eventAllowed({ ...event, spaceId: 'space-a' }, { ...on, spaces }, () => [])).toBe(false);
  });
});

describe('rule-based recent state', () => {
  const now = new Date('2026-10-09T00:00:00.000Z');
  const record = (
    seq: number,
    type: RecentStateRecord['type'],
    payload: Record<string, unknown> = {},
    extra: Partial<RecentStateRecord> = {},
  ): RecentStateRecord => ({
    seq,
    type,
    occurredAt: '2026-10-08T00:00:00.000Z',
    payload,
    stageId: 'stage-a',
    spaceIds: ['space-a'],
    classmateId: null,
    ...extra,
  });

  it('counts what happened without any mastery field', () => {
    const records = [
      record(1, 'course_started'),
      record(2, 'course_progressed', { furthestPage: 2, pageCount: 3 }),
      record(3, 'course_finished', { pageCount: 3 }),
      record(4, 'quiz_submitted'),
      record(5, 'quiz_graded', {
        verification: 'server_checked',
        objective: { correct: 3, total: 4 },
      }),
      record(6, 'quiz_graded', { verification: 'unverified', objective: null }),
      record(7, 'companion_question', {}, { stageId: null, classmateId: 'cm-a' }),
      record(
        8,
        'companion_question',
        {},
        { stageId: null, classmateId: 'cm-a', spaceIds: ['space-b'] },
      ),
      record(9, 'course_started', {}, { occurredAt: '2026-09-01T00:00:00.000Z' }),
    ];
    const all = aggregateRecentState(records, null, now);
    expect(all).toMatchObject({
      coursesViewed: 1,
      coursesFinished: 1,
      quizzesSubmitted: 1,
      quizzesGraded: 2,
      objective: { correct: 3, total: 4 },
      quizzesUnverified: 1,
      companionQuestions: 2,
      companionByClassmate: [{ classmateId: 'cm-a', count: 2 }],
      sourceWatermark: 8,
      policyVersion: 'recent-state-rules-v1',
    });
    expect(Object.keys(all).join(',')).not.toMatch(/master/i);
    const spaceA = aggregateRecentState(records, 'space-a', now);
    expect(spaceA.companionQuestions).toBe(1);
    // Same records → same hash (no refresh); a new record → refresh.
    expect(summaryNeedsRefresh(all, aggregateRecentState(records, null, now))).toBe(false);
    expect(
      summaryNeedsRefresh(
        all,
        aggregateRecentState([...records, record(10, 'quiz_submitted')], null, now),
      ),
    ).toBe(true);
    expect(summaryNeedsRefresh(null, all)).toBe(true);
  });
});
