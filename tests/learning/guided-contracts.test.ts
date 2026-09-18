import { describe, expect, it } from 'vitest';
import {
  parseGuidedLearningContext,
  parseGuidedLearningOutcome,
} from '@/lib/learning/guided-contracts';

const context = {
  schemaVersion: 1,
  requestId: 'request-1',
  chatSessionId: 'session-1',
  stageId: 'stage-1',
  contentRevision: 'content-7',
  scopedRevision: 'scene-2:sha256:abc',
  phase: 'explain',
  source: { kind: 'scene', sceneId: 'scene-2' },
  evidence: [{ ref: 'scene-2#body', content: 'Plants convert light energy into chemical energy.' }],
};

describe('guided learning contracts', () => {
  it('accepts a bounded versioned context and rejects unknown or inconsistent fields', () => {
    expect(parseGuidedLearningContext(context)).toEqual(context);
    expect(() => parseGuidedLearningContext({ ...context, schemaVersion: 2 })).toThrow(
      'guided learning context',
    );
    expect(() =>
      parseGuidedLearningContext({
        ...context,
        phase: 'feedback',
        studentAnswer: '   ',
      }),
    ).toThrow('student answer');
    expect(() => parseGuidedLearningContext({ ...context, unexpected: true })).toThrow(
      'guided learning context',
    );
  });

  it('accepts only public, source-bound review outcomes', () => {
    const outcome = {
      schemaVersion: 1,
      requestId: 'request-1',
      phase: 'wait_student',
      published: {
        explanation: 'Light energy is stored in glucose.',
        reviewNote: 'No issue was found against the supplied scene.',
      },
      checkPrompt: 'Where is the captured energy stored?',
      review: {
        verdict: 'no_issue_found',
        evidenceRefs: ['scene-2#body'],
      },
      budget: { callsUsed: 2, callLimit: 4 },
      usage: { status: 'unknown' },
    };

    expect(parseGuidedLearningOutcome(outcome, new Set(['scene-2#body']))).toEqual(outcome);
    expect(() =>
      parseGuidedLearningOutcome(
        {
          ...outcome,
          review: { ...outcome.review, evidenceRefs: ['https://invented.example/source'] },
        },
        new Set(['scene-2#body']),
      ),
    ).toThrow('evidence reference');
    expect(() =>
      parseGuidedLearningOutcome(
        { ...outcome, budget: { callsUsed: 5, callLimit: 4 } },
        new Set(['scene-2#body']),
      ),
    ).toThrow('call budget');
  });
});
