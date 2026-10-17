import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  resolveRequestBinding: vi.fn(),
}));

vi.mock('@/lib/model-gateway', async (importOriginal) =>
  (await import('@/tests/helpers/model-gateway-mock')).mockGatewayModule(
    await importOriginal(),
    mocks,
  ),
);

import { POST } from '@/app/api/learning/check/route';
import { normalizeLearningCheckCandidate } from '@/lib/server/learning/check';
import { LEARNING_SCORING_VERSION, type LearningContentSnapshot } from '@/lib/learning/contracts';

function snapshot(): LearningContentSnapshot {
  return {
    snapshotAlgorithmVersion: 'learning-content-v1',
    contentRevision: `sha256:${'a'.repeat(64)}`,
    courseTitle: 'Physics',
    fragments: [
      {
        id: 'scene:scene-1',
        sourceRef: { sceneId: 'scene-1', sceneType: 'slide', sceneTitle: 'Forces' },
        text: 'Net force changes velocity. Balanced forces have zero net force.',
        digest: `sha256:${'b'.repeat(64)}`,
      },
    ],
    coverage: { includedSceneIds: ['scene-1'], limitedSceneIds: [], notes: [] },
  };
}

function question(id: string, prompt = `Question ${id}`) {
  return {
    id,
    type: 'single',
    prompt,
    options: [
      { label: 'Motion', value: 'A' },
      { label: 'Color', value: 'B' },
    ],
    correctAnswer: ['A'],
    scoringGuide: 'A is supported by the source.',
    explanation: 'Net force changes motion.',
    maxScore: 1,
    conceptId: 'force',
    sourceRefs: ['scene:scene-1'],
  };
}

function candidate() {
  return JSON.stringify({
    questionSetId: 'question-set-1',
    scoringVersion: LEARNING_SCORING_VERSION,
    coverageNote: 'Checks the provided force evidence.',
    questions: [question('q1'), question('q2'), question('q3')],
  });
}

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/learning/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/learning/check', () => {
  let originalFlag: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFlag = process.env.NEXT_PUBLIC_LEARNING_CHECKS_ENABLED;
    process.env.NEXT_PUBLIC_LEARNING_CHECKS_ENABLED = '1';
    mocks.resolveRequestBinding.mockResolvedValue({
      model: 'test-model',
      modelString: 'openai/test',
      thinkingConfig: undefined,
    });
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.NEXT_PUBLIC_LEARNING_CHECKS_ENABLED;
    else process.env.NEXT_PUBLIC_LEARNING_CHECKS_ENABLED = originalFlag;
  });

  it('rejects a disabled deployment before resolving or calling a model', async () => {
    delete process.env.NEXT_PUBLIC_LEARNING_CHECKS_ENABLED;
    const response = await POST(
      request({ requestId: 'request-1', scope: 'course', snapshot: snapshot() }),
    );
    expect(response.status).toBe(404);
    expect(mocks.resolveRequestBinding).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('rejects more than 128 KiB of raw JSON before parsing or calling a model', async () => {
    const response = await POST(
      request(`{"requestId":"request-1","padding":"${'x'.repeat(131_072)}"}`),
    );
    expect(response.status).toBe(413);
    expect(mocks.resolveRequestBinding).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('rejects evidence limits before model resolution', async () => {
    const evidence = snapshot();
    evidence.fragments = Array.from({ length: 31 }, (_, index) => ({
      ...evidence.fragments[0]!,
      id: `scene:${index}`,
    }));
    const response = await POST(
      request({ requestId: 'request-1', scope: 'course', snapshot: evidence }),
    );
    expect(response.status).toBe(400);
    expect(mocks.resolveRequestBinding).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('uses exactly one generation and one independent review call with retries disabled', async () => {
    mocks.complete
      .mockResolvedValueOnce({
        text: candidate(),
        totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      })
      .mockResolvedValueOnce({ text: '{"status":"passed","notes":["grounded"]}' });
    const body = {
      requestId: 'request-1',
      scope: 'course',
      snapshot: snapshot(),
      language: 'en-US',
    };
    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      questionSet: {
        questionSetId: 'learning-question-set:course:request-1',
        questions: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }],
      },
      review: { status: 'passed' },
      generation: { calls: 2, model: 'openai/test' },
    });
    expect(mocks.resolveRequestBinding).toHaveBeenCalledWith(
      expect.any(NextRequest),
      body,
      'quiz-grade',
    );
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    for (const [, params, opts] of mocks.complete.mock.calls) {
      expect(params).toMatchObject({ maxOutputTokens: 4_000 });
      expect(opts).toMatchObject({ retry: 'none' });
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    }
    expect(mocks.complete.mock.calls[0]![2].source).toBe('learning-check-generation');
    expect(mocks.complete.mock.calls[1]![2].source).toBe('learning-check-review');
  });

  it('binds question-set identity to each request instead of trusting a repeated model id', async () => {
    mocks.complete
      .mockResolvedValueOnce({ text: candidate() })
      .mockResolvedValueOnce({ text: '{"status":"passed","notes":[]}' })
      .mockResolvedValueOnce({ text: candidate() })
      .mockResolvedValueOnce({ text: '{"status":"passed","notes":[]}' });

    const first = await POST(
      request({ requestId: 'request-first', scope: 'course', snapshot: snapshot() }),
    );
    const second = await POST(
      request({ requestId: 'request-second', scope: 'course', snapshot: snapshot() }),
    );
    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(firstBody.questionSet.questionSetId).toBe('learning-question-set:course:request-first');
    expect(secondBody.questionSet.questionSetId).toBe(
      'learning-question-set:course:request-second',
    );
    expect(firstBody.questionSet.questionSetId).not.toBe(secondBody.questionSet.questionSetId);
    expect(firstBody.questionSet.questionSetId).not.toBe('question-set-1');
  });

  it('returns a retryable failure and no empty success when independent review rejects the set', async () => {
    mocks.complete
      .mockResolvedValueOnce({ text: candidate() })
      .mockResolvedValueOnce({ text: '{"status":"rejected","notes":["ambiguous answer"]}' });
    const response = await POST(
      request({ requestId: 'request-1', scope: 'course', snapshot: snapshot() }),
    );
    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json).not.toHaveProperty('questionSet');
  });

  it('rejects duplicate question ids before independent review', async () => {
    mocks.complete.mockResolvedValueOnce({
      text: JSON.stringify({
        questionSetId: 'duplicate-question-set',
        scoringVersion: LEARNING_SCORING_VERSION,
        coverageNote: 'Invalid duplicate identifiers.',
        questions: [question('duplicate'), question('duplicate'), question('q3')],
      }),
    });

    const response = await POST(
      request({ requestId: 'request-duplicate', scope: 'course', snapshot: snapshot() }),
    );

    expect(response.status).toBe(502);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it('binds a remediation question to the frozen concept and requires a new prompt', async () => {
    mocks.complete
      .mockResolvedValueOnce({
        text: JSON.stringify({
          questionSetId: 'remediation-set-1',
          scoringVersion: LEARNING_SCORING_VERSION,
          coverageNote: 'A new force question.',
          questions: [question('q-remediation', 'What changes when net force is non-zero?')],
        }),
      })
      .mockResolvedValueOnce({ text: '{"status":"passed","notes":[]}' });
    const body = {
      requestId: 'request-remediation-1',
      scope: 'remediation',
      focus: { conceptId: 'force', priorQuestionPrompt: 'Which statement describes net force?' },
      snapshot: snapshot(),
    } as const;

    const response = await POST(request(body));
    const responseBody = await response.json();

    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(responseBody.questionSet.questionSetId).toBe(
      'learning-question-set:remediation:request-remediation-1',
    );
    const generationPrompt = mocks.complete.mock.calls[0]![1].messages[0].content as string;
    expect(generationPrompt).toContain('"focus":{"conceptId":"force"');
  });

  it.each([
    [
      'wrong concept',
      question('q-remediation', 'What changes when net force is non-zero?'),
      'motion',
    ],
    ['reused prompt', question('q-remediation', 'Which statement describes net force?'), 'force'],
  ])('rejects remediation output with a %s before review', async (_label, generated, conceptId) => {
    generated.conceptId = conceptId;
    mocks.complete.mockResolvedValueOnce({
      text: JSON.stringify({
        questionSetId: 'remediation-set-1',
        scoringVersion: LEARNING_SCORING_VERSION,
        coverageNote: 'Remediation.',
        questions: [generated],
      }),
    });

    const response = await POST(
      request({
        requestId: 'request-remediation-1',
        scope: 'remediation',
        focus: { conceptId: 'force', priorQuestionPrompt: 'Which statement describes net force?' },
        snapshot: snapshot(),
      }),
    );

    expect(response.status).toBe(502);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it('states the exact output schema in the generation and review prompts', async () => {
    mocks.complete
      .mockResolvedValueOnce({ text: candidate() })
      .mockResolvedValueOnce({ text: '{"status":"passed","notes":[]}' });
    await POST(request({ requestId: 'request-1', scope: 'course', snapshot: snapshot() }));

    const generationSystem = mocks.complete.mock.calls[0]![1].system as string;
    expect(generationSystem).toContain('"single", "multiple", "short_answer"');
    expect(generationSystem).toContain('{"label": string, "value": string}');
    expect(generationSystem).toContain('an ARRAY of option values');
    expect(generationSystem).toContain('Omit "correctAnswer" entirely for short_answer');
    expect(generationSystem).toContain('"maxScore": integer greater than 0');
    expect(generationSystem).toContain('only ids copied from evidence[].id');
    expect(generationSystem).toContain('3-5 questions with at most 2 of type "short_answer"');
    expect(generationSystem).toContain('"scoringVersion": "learning-scoring-v1"');
    const reviewSystem = mocks.complete.mock.calls[1]![1].system as string;
    expect(reviewSystem).toContain('{"status": "passed" | "rejected", "notes": [string, ...]}');
  });

  // Shape returned by deepseek:deepseek-flash in local acceptance on 2026-10-17.
  function deepSeekCandidate(overrides: Record<string, unknown>[] = []) {
    const questions: Record<string, unknown>[] = [
      { ...question('q1'), type: 'single_choice', correctAnswer: 'A' },
      {
        ...question('q2'),
        type: 'multiple_choice',
        options: [
          { label: 'Velocity changes', value: 'A' },
          { label: 'Color changes', value: 'B' },
          { label: 'Acceleration is non-zero', value: 'C' },
        ],
        correctAnswer: ['A', 'C'],
      },
      {
        id: 'q3',
        type: 'short_answer',
        prompt: 'What is the net force when forces are balanced?',
        correctAnswer: '0',
        scoringGuide: 'Reference answer: zero. Award 2 points for zero net force.',
        explanation: 'Balanced forces cancel.',
        maxScore: 2,
        conceptId: 'force',
        sourceRefs: ['scene:scene-1'],
      },
    ];
    overrides.forEach((override, index) => Object.assign(questions[index]!, override));
    const json = JSON.stringify({
      questionSetId: 'deepseek-set',
      scoringVersion: LEARNING_SCORING_VERSION,
      coverageNote: 'Checks the provided force evidence.',
      questions,
    });
    return '```json\n' + json + '\n```';
  }

  it('normalises equivalent DeepSeek spellings and still runs independent review', async () => {
    mocks.complete
      .mockResolvedValueOnce({ text: deepSeekCandidate() })
      .mockResolvedValueOnce({ text: '```json\n{"status":"passed","notes":["grounded"]}\n```' });
    const response = await POST(
      request({ requestId: 'request-deepseek', scope: 'course', snapshot: snapshot() }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.questionSet.questions).toEqual([
      expect.objectContaining({ id: 'q1', type: 'single', correctAnswer: ['A'] }),
      expect.objectContaining({ id: 'q2', type: 'multiple', correctAnswer: ['A', 'C'] }),
      expect.objectContaining({ id: 'q3', type: 'short_answer' }),
    ]);
    expect(body.questionSet.questions[2]).not.toHaveProperty('correctAnswer');
    expect(body.questionSet.questions[2]).not.toHaveProperty('options');
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    const reviewPayload = mocks.complete.mock.calls[1]![1].messages[0].content as string;
    expect(reviewPayload).toContain('"type":"single","prompt":"Question q1"');
    expect(reviewPayload).not.toContain('single_choice');
  });

  it.each([
    ['an unknown question type', { type: 'true_false' }],
    ['a bare-string answer that is an option label, not a value', { correctAnswer: 'Motion' }],
    ['a comma-joined answer string', { correctAnswer: 'A,B' }],
    ['an answer key outside the options', { correctAnswer: ['C'] }],
    ['two answers for a single-choice question', { correctAnswer: ['A', 'B'] }],
    ['an empty answer key', { correctAnswer: [] }],
    [
      'duplicate option values',
      {
        options: [
          { label: 'x', value: 'A' },
          { label: 'y', value: 'A' },
        ],
      },
    ],
    ['a fractional maxScore', { maxScore: 0.5 }],
    ['a string maxScore', { maxScore: '1' }],
    ['an empty scoringGuide', { scoringGuide: '' }],
    ['a missing conceptId', { conceptId: undefined }],
    ['an uncited question', { sourceRefs: [] }],
    ['evidence outside the snapshot', { sourceRefs: ['scene:invented'] }],
  ])('still rejects DeepSeek-style output with %s before review', async (_label, override) => {
    mocks.complete.mockResolvedValueOnce({ text: deepSeekCandidate([override]) });
    const response = await POST(
      request({ requestId: 'request-deepseek', scope: 'course', snapshot: snapshot() }),
    );
    expect(response.status).toBe(502);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it('still rejects a wrong scoringVersion and more than two short answers', async () => {
    const shortAnswer = {
      id: 'sa',
      type: 'short_answer',
      prompt: 'Explain balanced forces.',
      scoringGuide: 'Reference answer: zero net force.',
      explanation: 'Balanced forces cancel.',
      maxScore: 2,
      conceptId: 'force',
      sourceRefs: ['scene:scene-1'],
    };
    mocks.complete
      .mockResolvedValueOnce({
        text: JSON.stringify({
          questionSetId: 'set',
          scoringVersion: 'v1',
          coverageNote: 'note',
          questions: [question('q1'), question('q2'), question('q3')],
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          questionSetId: 'set',
          scoringVersion: LEARNING_SCORING_VERSION,
          coverageNote: 'note',
          questions: ['s1', 's2', 's3'].map((id) => ({ ...shortAnswer, id })),
        }),
      });
    for (const requestId of ['request-version', 'request-short']) {
      const response = await POST(request({ requestId, scope: 'course', snapshot: snapshot() }));
      expect(response.status).toBe(502);
    }
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it('rejects a reviewer reply that does not follow the review schema', async () => {
    mocks.complete
      .mockResolvedValueOnce({ text: candidate() })
      .mockResolvedValueOnce({ text: '{"result":"pass","notes":"looks fine"}' });
    const response = await POST(
      request({ requestId: 'request-1', scope: 'course', snapshot: snapshot() }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty('questionSet');
  });
});

describe('normalizeLearningCheckCandidate', () => {
  it('maps choice-type aliases and wraps a bare option value', () => {
    const normalized = normalizeLearningCheckCandidate({
      questions: [
        { ...question('q1'), type: 'Single-Choice', correctAnswer: 'B' },
        { ...question('q2'), type: 'multiple_choice', correctAnswer: 'A' },
      ],
    }) as { questions: Record<string, unknown>[] };
    expect(normalized.questions[0]).toMatchObject({ type: 'single', correctAnswer: ['B'] });
    expect(normalized.questions[1]).toMatchObject({ type: 'multiple', correctAnswer: ['A'] });
  });

  it('drops answer keys and empty options from short answers only', () => {
    const normalized = normalizeLearningCheckCandidate({
      questions: [
        { id: 'q1', type: 'short_answer', options: [], correctAnswer: '4' },
        { id: 'q2', type: 'short_answer', options: null, correctAnswer: null },
        { id: 'q3', type: 'short_answer', options: [{ label: 'a', value: 'a' }] },
      ],
    }) as { questions: Record<string, unknown>[] };
    expect(normalized.questions[0]).toEqual({ id: 'q1', type: 'short_answer' });
    expect(normalized.questions[1]).toEqual({ id: 'q2', type: 'short_answer' });
    expect(normalized.questions[2]).toHaveProperty('options');
  });

  it('keeps a short answer reference answer in the scoring guide instead of dropping it', () => {
    const normalized = normalizeLearningCheckCandidate({
      questions: [
        {
          id: 'q1',
          type: 'short_answer',
          scoringGuide: 'Award 2 points.',
          correctAnswer: 'y=2x-1',
        },
        { id: 'q2', type: 'short_answer', scoringGuide: 'Answer y=2x-1.', correctAnswer: 'y=2x-1' },
        { id: 'q3', type: 'short_answer', scoringGuide: 'x'.repeat(1990), correctAnswer: 'y=2x-1' },
        { id: 'q4', type: 'short_answer', scoringGuide: 'Guide.', correctAnswer: ['a', 'b'] },
      ],
    }) as { questions: Record<string, unknown>[] };
    expect(normalized.questions[0]).toEqual({
      id: 'q1',
      type: 'short_answer',
      scoringGuide: 'Award 2 points.\nReference answer: y=2x-1',
    });
    expect(normalized.questions[1]!.scoringGuide).toBe('Answer y=2x-1.');
    // Too long to merge: the guide stays as it was.
    expect(normalized.questions[2]!.scoringGuide).toBe('x'.repeat(1990));
    expect(normalized.questions[3]).toEqual({
      id: 'q4',
      type: 'short_answer',
      scoringGuide: 'Guide.\nReference answer: a; b',
    });
  });

  it('leaves values it cannot map unambiguously for strict validation to reject', () => {
    const normalized = normalizeLearningCheckCandidate({
      questions: [
        { ...question('q1'), type: 'true_false' },
        { ...question('q2'), correctAnswer: 'Motion' },
        { ...question('q3'), correctAnswer: 'A,B' },
        { ...question('q4'), options: undefined, correctAnswer: 'A' },
      ],
    }) as { questions: Record<string, unknown>[] };
    expect(normalized.questions[0]!.type).toBe('true_false');
    expect(normalized.questions[1]!.correctAnswer).toBe('Motion');
    expect(normalized.questions[2]!.correctAnswer).toBe('A,B');
    expect(normalized.questions[3]!.correctAnswer).toBe('A');
    expect(normalizeLearningCheckCandidate('not an object')).toBe('not an object');
  });
});
