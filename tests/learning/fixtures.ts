import {
  LEARNING_PROMPT_VERSION,
  LEARNING_SCHEMA_VERSION,
  LEARNING_SCORING_VERSION,
  LEARNING_SNAPSHOT_ALGORITHM_VERSION,
  type LearningCheckPayloadV1,
} from '@/lib/learning/contracts';

export function learningPayload(
  phase: 'draft' | 'submitted' | 'reviewed' = 'draft',
): LearningCheckPayloadV1 {
  return {
    payloadVersion: 1,
    identity: {
      checkId: 'check-1',
      attemptId: 'attempt-1',
      source: 'course_check',
      requestId: 'request-1',
    },
    source: {
      snapshotAlgorithmVersion: LEARNING_SNAPSHOT_ALGORITHM_VERSION,
      contentRevision: `sha256:${'a'.repeat(64)}`,
      courseTitle: 'Physics',
      fragments: [
        {
          id: 'scene:scene-1',
          sourceRef: { sceneId: 'scene-1', sceneType: 'slide', sceneTitle: 'Forces' },
          text: 'Net force changes motion.',
          digest: `sha256:${'b'.repeat(64)}`,
        },
      ],
      coverage: { includedSceneIds: ['scene-1'], limitedSceneIds: [], notes: [] },
    },
    questionSet: {
      questionSetId: 'question-set-1',
      scoringVersion: LEARNING_SCORING_VERSION,
      coverageNote: 'Covers the force scene.',
      questions: [
        {
          id: 'q1',
          type: 'single',
          prompt: 'What does net force change?',
          options: [
            { label: 'Motion', value: 'A' },
            { label: 'Color', value: 'B' },
          ],
          correctAnswer: ['A'],
          scoringGuide: 'A is the only correct answer.',
          explanation: 'Net force changes velocity.',
          maxScore: 2,
          conceptId: 'force',
          sourceRefs: ['scene:scene-1'],
        },
      ],
    },
    lifecycle: {
      phase,
      answers: phase === 'draft' ? {} : { q1: ['A'] },
      grading:
        phase === 'reviewed'
          ? {
              q1: {
                status: 'graded',
                score: 2,
                comment: 'Correct.',
                basis: 'deterministic',
              },
            }
          : {},
      startedAt: '2026-09-14T00:00:00.000Z',
      ...(phase === 'draft' ? {} : { submittedAt: '2026-09-14T00:01:00.000Z' }),
      ...(phase === 'reviewed' ? { reviewedAt: '2026-09-14T00:02:00.000Z' } : {}),
    },
    generation: {
      promptVersion: LEARNING_PROMPT_VERSION,
      schemaVersion: LEARNING_SCHEMA_VERSION,
      model: 'openai/test',
      calls: 2,
      usage: 'unknown',
      review: { status: 'passed', notes: [] },
    },
  };
}
