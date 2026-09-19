import { describe, expect, it } from 'vitest';

import {
  allowedTeachBackCommands,
  assertCanSubmitExplanation,
  bindTeachBackSource,
  nextTurnIndex,
  projectTeachBackActivity,
} from '@/lib/learning/teach-back/activity';
import {
  TEACH_BACK_MAX_EXPLANATIONS,
  type TeachBackRecordPayloadV1,
  type TeachBackSource,
} from '@/lib/learning/teach-back/contracts';

const source: TeachBackSource = {
  stageId: 'stage-1',
  sceneId: 'scene-1',
  sceneType: 'slide',
  title: 'Osmosis',
  courseTitle: 'Biology',
  snapshotAlgorithmVersion: 'learning-content-v1',
  sourceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  fragments: [
    {
      id: 'scene:scene-1',
      digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      text: 'Water moves across a membrane from a dilute solution to a concentrated solution.',
    },
  ],
  coverageLimited: false,
};

const peer = {
  id: 'default-3',
  name: 'Yueyang',
  role: 'student',
  persona: 'curious classmate',
  avatar: '/avatars/student.png',
  color: '#f59e0b',
};

const plan = {
  topic: 'Osmosis',
  criteria: [
    {
      criterionId: 'criterion-1',
      description: 'Direction of water movement',
      quote: 'Water moves across a membrane',
      fragmentId: 'scene:scene-1',
    },
  ],
  peer,
  openingQuestion: {
    questionId: 'question-open',
    text: 'Which way does water move, and why?',
    criterionId: 'criterion-1',
  },
};

function record(
  seq: number,
  commandId: string,
  event: TeachBackRecordPayloadV1['event'],
): { seq: number; payload: TeachBackRecordPayloadV1 } {
  return {
    seq,
    payload: { payloadVersion: 1, activityId: 'act-1', commandId, event },
  };
}

describe('teach-back activity projection', () => {
  it('does not treat a failed prepare as a started practice', () => {
    const activity = projectTeachBackActivity('act-1', [
      record(0, 'prepare:1', {
        kind: 'prepare_requested',
        createdAt: '2026-09-19T00:00:00.000Z',
        requestId: 'r1',
        source,
        topic: 'Osmosis',
        peer,
      }),
    ]);
    expect(activity.hasStarted).toBe(false);
    expect(allowedTeachBackCommands(activity).size).toBe(0);
  });

  it('waits for a real student after prepare and counts at most three explanations', () => {
    const prepared = projectTeachBackActivity('act-1', [
      record(0, 'prepare:1', {
        kind: 'prepare_requested',
        createdAt: '2026-09-19T00:00:00.000Z',
        requestId: 'r1',
        source,
        topic: 'Osmosis',
        peer,
      }),
      record(1, 'prepared:1', {
        kind: 'activity_prepared',
        createdAt: '2026-09-19T00:00:01.000Z',
        plan,
        source,
      }),
    ]);
    expect(prepared.phase).toBe('awaiting_explanation');
    expect(prepared.currentQuestion?.questionId).toBe('question-open');
    expect(() => assertCanSubmitExplanation(prepared)).not.toThrow();
    expect(nextTurnIndex(prepared.explanations)).toBe(1);

    const records = [
      record(0, 'prepare:1', {
        kind: 'prepare_requested',
        createdAt: '2026-09-19T00:00:00.000Z',
        requestId: 'r1',
        source,
        topic: 'Osmosis',
        peer,
      }),
      record(1, 'prepared:1', {
        kind: 'activity_prepared',
        createdAt: '2026-09-19T00:00:01.000Z',
        plan,
        source,
      }),
    ];
    for (const turn of [1, 2, 3] as const) {
      records.push(
        record(turn * 2, `explain:${turn}`, {
          kind: 'explanation_submitted',
          createdAt: `2026-09-19T00:00:0${turn + 1}.000Z`,
          explanation: {
            turnId: `turn-${turn}`,
            turnIndex: turn,
            text: `explanation ${turn}`,
            submittedAt: `2026-09-19T00:00:0${turn + 1}.000Z`,
            questionId: 'question-open',
          },
        }),
        record(turn * 2 + 1, `evaluated:turn-${turn}`, {
          kind: 'turn_evaluated',
          createdAt: `2026-09-19T00:00:1${turn}.000Z`,
          result: {
            turnId: `turn-${turn}`,
            criteria: [
              {
                criterionId: 'criterion-1',
                status: turn === 3 ? 'explained' : 'needs_supplement',
                reason: 'Need the condition',
                citation: { turnId: `turn-${turn}`, excerpt: `explanation ${turn}` },
              },
            ],
            suggestion: 'Add the condition',
            ...(turn === 3
              ? { endReason: 'max_turns' as const }
              : {
                  nextQuestion: {
                    questionId: `q-${turn}`,
                    text: 'What condition is required?',
                    criterionId: 'criterion-1',
                  },
                }),
          },
        }),
      );
    }
    const explained = projectTeachBackActivity('act-1', records);
    expect(explained.explanations).toHaveLength(TEACH_BACK_MAX_EXPLANATIONS);
    expect(explained.logicalPhase).toBe('summary_ready');
    expect(explained.currentQuestion).toBeUndefined();
    expect(explained.remainingExplanations).toBe(0);
  });

  it('enters the result phase as soon as every criterion is explained', () => {
    const activity = projectTeachBackActivity('act-1', [
      record(1, 'prepared:1', {
        kind: 'activity_prepared',
        createdAt: '2026-09-19T00:00:01.000Z',
        plan,
        source,
      }),
      record(2, 'explain:turn-1', {
        kind: 'explanation_submitted',
        createdAt: '2026-09-19T00:00:02.000Z',
        explanation: {
          turnId: 'turn-1',
          turnIndex: 1,
          text: 'Water moves from dilute to concentrated.',
          submittedAt: '2026-09-19T00:00:02.000Z',
          questionId: 'question-open',
        },
      }),
      record(3, 'evaluated:turn-1', {
        kind: 'turn_evaluated',
        createdAt: '2026-09-19T00:00:03.000Z',
        result: {
          turnId: 'turn-1',
          criteria: [
            {
              criterionId: 'criterion-1',
              status: 'explained',
              reason: 'Direction is clear',
              citation: { turnId: 'turn-1', excerpt: 'from dilute to concentrated' },
            },
          ],
          suggestion: 'Yes, that is the direction.',
          endReason: 'all_explained',
        },
      }),
    ]);
    expect(activity.logicalPhase).toBe('summary_ready');
    expect(activity.currentQuestion).toBeUndefined();
    expect(activity.explanations).toHaveLength(1);
  });

  it('lets a retry keep the same explanation turn', () => {
    const activity = projectTeachBackActivity('act-1', [
      record(1, 'prepared:1', {
        kind: 'activity_prepared',
        createdAt: '2026-09-19T00:00:01.000Z',
        plan,
        source,
      }),
      record(2, 'explain:turn-1', {
        kind: 'explanation_submitted',
        createdAt: '2026-09-19T00:00:02.000Z',
        explanation: {
          turnId: 'turn-1',
          turnIndex: 1,
          text: 'Water moves.',
          submittedAt: '2026-09-19T00:00:02.000Z',
          questionId: 'question-open',
        },
      }),
      record(3, 'evaluate:a', {
        kind: 'evaluation_requested',
        createdAt: '2026-09-19T00:00:03.000Z',
        requestId: 'a',
        turnId: 'turn-1',
      }),
      record(4, 'evaluate:b', {
        kind: 'evaluation_requested',
        createdAt: '2026-09-19T00:00:04.000Z',
        requestId: 'b',
        turnId: 'turn-1',
      }),
    ]);
    expect(activity.explanations).toHaveLength(1);
    expect(activity.callsInitiated).toBe(2);
    expect(activity.pendingTurnId).toBe('turn-1');
  });

  it('manual finish uses existing records and does not invent a fourth question', () => {
    const activity = projectTeachBackActivity('act-1', [
      record(1, 'prepared:1', {
        kind: 'activity_prepared',
        createdAt: '2026-09-19T00:00:01.000Z',
        plan,
        source,
      }),
      record(2, 'finish:1', {
        kind: 'activity_finished',
        createdAt: '2026-09-19T00:00:02.000Z',
        reason: 'manual_stop',
      }),
    ]);
    expect(activity.phase).toBe('finished');
    expect(activity.summary?.partial).toBe(true);
    expect(activity.currentQuestion).toBeUndefined();
  });

  it('rejects a source revision change without treating it as a new score', () => {
    const activity = projectTeachBackActivity('act-1', [
      record(1, 'prepared:1', {
        kind: 'activity_prepared',
        createdAt: '2026-09-19T00:00:01.000Z',
        plan,
        source,
      }),
    ]);
    expect(
      bindTeachBackSource(activity, {
        ...source,
        sourceRevision: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      }),
    ).toBe('source_stale');
    expect(activity.summary).toBeUndefined();
  });
});
