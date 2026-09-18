import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
  getModelResolutionError: () => undefined,
}));

import { POST } from '@/app/api/learning/check/route';
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
    mocks.resolveModelFromRequest.mockResolvedValue({
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
    expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('rejects more than 128 KiB of raw JSON before parsing or calling a model', async () => {
    const response = await POST(
      request(`{"requestId":"request-1","padding":"${'x'.repeat(131_072)}"}`),
    );
    expect(response.status).toBe(413);
    expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
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
    expect(mocks.resolveModelFromRequest).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('uses exactly one generation and one independent review call with retries disabled', async () => {
    mocks.callLLM
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
    expect(mocks.resolveModelFromRequest).toHaveBeenCalledWith(
      expect.any(NextRequest),
      body,
      'quiz-grade',
    );
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    for (const [params] of mocks.callLLM.mock.calls) {
      expect(params).toMatchObject({ maxRetries: 0, maxOutputTokens: 4_000 });
      expect(params.abortSignal).toBeInstanceOf(AbortSignal);
    }
    expect(mocks.callLLM.mock.calls[0]![1]).toBe('learning-check-generation');
    expect(mocks.callLLM.mock.calls[1]![1]).toBe('learning-check-review');
  });

  it('binds question-set identity to each request instead of trusting a repeated model id', async () => {
    mocks.callLLM
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
    mocks.callLLM
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
    mocks.callLLM.mockResolvedValueOnce({
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
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it('binds a remediation question to the frozen concept and requires a new prompt', async () => {
    mocks.callLLM
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

    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    expect(responseBody.questionSet.questionSetId).toBe(
      'learning-question-set:remediation:request-remediation-1',
    );
    const generationPrompt = mocks.callLLM.mock.calls[0]![0].prompt as string;
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
    mocks.callLLM.mockResolvedValueOnce({
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
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });
});
