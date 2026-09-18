import { describe, expect, it, vi } from 'vitest';
import {
  runGuidedCoach,
  validateGuidedSourceContext,
  type GuidedModelCall,
} from '@/lib/server/learning/coach';

const baseContext = {
  schemaVersion: 1 as const,
  requestId: 'request-1',
  chatSessionId: 'session-1',
  stageId: 'stage-1',
  contentRevision: 'content-7',
  scopedRevision: 'scene-2:sha256:abc',
  phase: 'explain' as const,
  source: { kind: 'scene' as const, sceneId: 'scene-2' },
  evidence: [{ ref: 'scene#body', content: 'Plants store captured energy in glucose.' }],
};

function modelStub(outputs: string[]) {
  return vi.fn<GuidedModelCall>(async () => ({ text: outputs.shift() ?? '{}' }));
}

describe('validateGuidedSourceContext', () => {
  const contentRevision = `sha256:${'a'.repeat(64)}`;
  const attemptContext = {
    schemaVersion: 1 as const,
    requestId: 'request-1',
    chatSessionId: 'session-1',
    stageId: 'stage-1',
    contentRevision,
    scopedRevision: `${contentRevision}:learning_attempt:attempt-1:q1`,
    phase: 'explain' as const,
    source: {
      kind: 'learning_attempt' as const,
      attemptId: 'attempt-1',
      questionId: 'q1',
    },
    evidence: [
      {
        ref: 'remediation:learning_attempt:attempt-1:q1',
        content: JSON.stringify({
          prompt: 'What does net force change?',
          answer: ['motion'],
          explanation: 'Net force changes motion.',
          scoringGuide: 'Name motion or velocity.',
          grading: {
            status: 'graded',
            score: 0,
            maxScore: 2,
            comment: 'The submitted answer needs review.',
            basis: 'deterministic',
            interpretation: 'needs_review',
          },
        }),
      },
      { ref: 'scene:scene-1', content: 'Net force changes motion.' },
    ],
  };

  it('accepts a structurally bound frozen attempt and rejects revision or anchor substitution', () => {
    expect(validateGuidedSourceContext(attemptContext)).toBe(true);
    expect(
      validateGuidedSourceContext({ ...attemptContext, scopedRevision: `${contentRevision}:q1` }),
    ).toBe(false);
    expect(
      validateGuidedSourceContext({
        ...attemptContext,
        contentRevision: 'unversioned-content',
      }),
    ).toBe(false);
    expect(
      validateGuidedSourceContext({
        ...attemptContext,
        evidence: attemptContext.evidence.map((item, index) =>
          index === 0 ? { ...item, ref: 'remediation:learning_attempt:attempt-2:q1' } : item,
        ),
      }),
    ).toBe(false);
  });

  it('rejects malformed frozen question facts and inconsistent grading semantics', () => {
    const withQuestion = (question: unknown) => ({
      ...attemptContext,
      evidence: [
        { ...attemptContext.evidence[0]!, content: JSON.stringify(question) },
        attemptContext.evidence[1]!,
      ],
    });

    expect(validateGuidedSourceContext(withQuestion({ prompt: 'No grading fact.' }))).toBe(false);
    expect(
      validateGuidedSourceContext(
        withQuestion({
          prompt: 'What does net force change?',
          grading: {
            status: 'graded',
            score: 2,
            maxScore: 2,
            comment: 'Full credit.',
            basis: 'deterministic',
            interpretation: 'needs_review',
          },
        }),
      ),
    ).toBe(false);
  });

  it('binds quiz attempts to the quiz snapshot revision algorithm', () => {
    const quizRevision = 'quiz-snapshot-v1:deadbeef';
    const quizContext = {
      ...attemptContext,
      contentRevision: quizRevision,
      scopedRevision: `${quizRevision}:quiz_attempt:quiz-1:q1`,
      source: { kind: 'quiz_attempt' as const, attemptId: 'quiz-1', questionId: 'q1' },
      evidence: [
        {
          ref: 'remediation:quiz_attempt:quiz-1:q1',
          content: JSON.stringify({
            prompt: 'Explain inertia.',
            grading: {
              status: 'pending',
              interpretation: 'needs_verification',
            },
          }),
        },
      ],
    };

    expect(validateGuidedSourceContext(quizContext)).toBe(true);
    expect(
      validateGuidedSourceContext({
        ...quizContext,
        contentRevision: `sha256:${'a'.repeat(64)}`,
      }),
    ).toBe(false);
  });
});

describe('runGuidedCoach', () => {
  it('publishes a candidate only after a bounded independent review', async () => {
    const callModel = modelStub([
      JSON.stringify({ explanation: 'Energy is stored in glucose.', checkPrompt: 'Stored where?' }),
      JSON.stringify({
        verdict: 'no_issue_found',
        reviewNote: 'Consistent with the supplied scene.',
        evidenceRefs: ['scene#body'],
      }),
    ]);

    const result = await runGuidedCoach(baseContext, 'Where is the energy stored?', { callModel });

    expect(callModel.mock.calls.map(([request]) => request.phase)).toEqual(['explain', 'review']);
    expect(callModel.mock.calls.every(([request]) => request.maxRetries === 0)).toBe(true);
    expect(result).toMatchObject({
      phase: 'wait_student',
      published: {
        explanation: 'Energy is stored in glucose.',
        reviewNote: 'Consistent with the supplied scene.',
      },
      review: { verdict: 'no_issue_found', evidenceRefs: ['scene#body'] },
      budget: { callsUsed: 2, callLimit: 4, stopReason: 'completed' },
    });
  });

  it('allows at most one revision and requires a re-review before publishing it as checked', async () => {
    const callModel = modelStub([
      JSON.stringify({ explanation: 'PRIVATE WRONG DRAFT', checkPrompt: 'Stored where?' }),
      JSON.stringify({
        verdict: 'issue_found',
        reviewNote: 'The molecule is wrong.',
        evidenceRefs: ['scene#body'],
      }),
      JSON.stringify({ explanation: 'Energy is stored in glucose.', checkPrompt: 'Stored where?' }),
      JSON.stringify({
        verdict: 'no_issue_found',
        reviewNote: 'The correction matches the supplied scene.',
        evidenceRefs: ['scene#body'],
      }),
    ]);

    const result = await runGuidedCoach(baseContext, 'Where is the energy stored?', { callModel });

    expect(callModel.mock.calls.map(([request]) => request.phase)).toEqual([
      'explain',
      'review',
      'revise',
      're-review',
    ]);
    expect(callModel).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(result)).not.toContain('PRIVATE WRONG DRAFT');
    expect(result.published.explanation).toBe('Energy is stored in glucose.');
    expect(result.review.verdict).toBe('no_issue_found');
  });

  it('labels unresolved or source-free reviews as unverified and never exceeds four calls', async () => {
    const callModel = modelStub([
      JSON.stringify({ explanation: 'First draft.', checkPrompt: 'Why?' }),
      JSON.stringify({
        verdict: 'issue_found',
        reviewNote: 'Unsupported claim.',
        evidenceRefs: [],
      }),
      JSON.stringify({ explanation: 'Limited revision.', checkPrompt: 'Why?' }),
      JSON.stringify({
        verdict: 'issue_found',
        reviewNote: 'Still unsupported.',
        evidenceRefs: [],
      }),
    ]);

    const result = await runGuidedCoach({ ...baseContext, evidence: [] }, 'Can you verify this?', {
      callModel,
    });

    expect(callModel).toHaveBeenCalledTimes(4);
    expect(result.review.verdict).toBe('insufficient_evidence');
    expect(result.published.reviewNote).toBe('Unable to verify: Still unsupported.');
    expect(result.budget.callsUsed).toBe(4);
  });

  it('uses exactly one model call for feedback after a nonblank real student answer', async () => {
    const priorOutcome = {
      schemaVersion: 1 as const,
      requestId: 'request-1',
      phase: 'wait_student' as const,
      published: {
        explanation: 'Energy is stored in glucose.',
        reviewNote: 'Consistent with the supplied scene.',
      },
      checkPrompt: 'Where is energy stored?',
      review: { verdict: 'no_issue_found' as const, evidenceRefs: ['scene#body'] },
      budget: { callsUsed: 2, callLimit: 4 as const, stopReason: 'completed' as const },
      usage: { status: 'unknown' as const },
    };
    const context = {
      ...baseContext,
      phase: 'feedback' as const,
      studentAnswer: 'In glucose.',
      priorOutcome,
    };
    const callModel = modelStub([
      JSON.stringify({
        feedback: 'Yes. You identified glucose as the storage molecule.',
        reviewNote: 'Feedback is limited to the supplied answer and evidence.',
        evidenceRefs: ['scene#body'],
      }),
    ]);

    const result = await runGuidedCoach(context, 'In glucose.', { callModel });

    expect(callModel.mock.calls.map(([request]) => request.phase)).toEqual(['feedback']);
    expect(result).toMatchObject({
      phase: 'feedback',
      budget: { callsUsed: 1, callLimit: 1 },
    });
  });

  it('uses a neutral, stable fallback when feedback cannot be generated', async () => {
    const context = {
      ...baseContext,
      phase: 'feedback' as const,
      studentAnswer: 'In glucose.',
      priorOutcome: {
        schemaVersion: 1 as const,
        requestId: 'request-1',
        phase: 'wait_student' as const,
        published: { explanation: 'Energy is stored in glucose.', reviewNote: 'Checked.' },
        checkPrompt: 'Where is energy stored?',
        review: { verdict: 'no_issue_found' as const, evidenceRefs: ['scene#body'] },
        budget: { callsUsed: 2, callLimit: 4 as const, stopReason: 'completed' as const },
        usage: { status: 'unknown' as const },
      },
    };
    const callModel = modelStub(['not-json']);

    const result = await runGuidedCoach(context, 'In glucose.', { callModel });

    expect(result.published).toEqual({
      explanation: 'Your answer was saved, but feedback could not be generated this time.',
      reviewNote:
        'Unable to verify: the available course evidence or review result was insufficient.',
    });
  });

  it('propagates caller cancellation and does not enter a later phase', async () => {
    const controller = new AbortController();
    const callModel = vi.fn<GuidedModelCall>(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );

    const running = runGuidedCoach(baseContext, 'Where?', {
      callModel,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(callModel).toHaveBeenCalledOnce());
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(callModel).toHaveBeenCalledOnce();
  });
});
