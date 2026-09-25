import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as authApi from '@/lib/auth/api';
import * as stageGate from '@/lib/auth/stage-owner-gate';
import { createPrincipal } from '@/lib/auth/principal';
import { getProviderQuotaOwner } from '@/lib/server/generation-jobs/provider-call-context';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  resolveModel: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
  getModelResolutionError: () => undefined,
}));

import { POST } from '@/app/api/learning/teach-back/route';
import type { TeachBackSource } from '@/lib/learning/teach-back/contracts';

const source: TeachBackSource = {
  stageId: 'stage-1',
  sceneId: 'scene-1',
  sceneType: 'slide',
  title: 'Energy',
  courseTitle: 'Physics',
  snapshotAlgorithmVersion: 'learning-content-v1',
  sourceRevision: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  fragments: [
    {
      id: 'scene:scene-1',
      digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      text: 'Plants store captured energy in glucose after photosynthesis converts light into chemical energy.',
    },
  ],
  coverageLimited: false,
};

const peer = {
  id: 'default-2',
  name: 'Zhiwei',
  role: 'assistant',
  persona: 'helper',
  avatar: '/a.png',
  color: '#10b981',
};

function makeRequest(overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/learning/teach-back', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      learning: {
        operation: 'prepare',
        activityId: 'act-1',
        requestId: 'req-1',
        source,
        topic: 'Stored energy',
        peer,
      },
      model: 'openai/test-model',
      apiKey: 'client-key',
      ...overrides,
    }),
  });
}

describe('teach-back API route', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_TEACH_BACK_ENABLED', 'true');
    mocks.resolveModel.mockResolvedValue({
      model: 'openai/test-model',
      thinkingConfig: undefined,
    });
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({
        topic: 'Stored energy',
        criteria: [
          {
            criterionId: 'criterion-1',
            description: 'Where captured energy is stored',
            quote: 'Plants store captured energy in glucose',
            fragmentId: 'scene:scene-1',
          },
        ],
        openingQuestion: {
          questionId: 'question-open',
          text: 'Where do plants store the captured energy?',
          criterionId: 'criterion-1',
        },
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.callLLM.mockReset();
    mocks.resolveModel.mockReset();
  });

  it('returns 404 and does not call the model when the flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_TEACH_BACK_ENABLED', 'false');
    const response = await POST(makeRequest());
    expect(response.status).toBe(404);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('prepares a valid plan with a single model call', async () => {
    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.plan.openingQuestion.text).toContain('energy');
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.callLLM.mock.calls[0][0].maxRetries).toBe(0);
  });

  it('binds provider quota to the verified principal rather than a submitted owner', async () => {
    const principal = createPrincipal({
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'user',
      sessionId: 'verified-session',
      email: 'quota@example.test',
    });
    const auth = vi.spyOn(authApi, 'requirePrincipalIfHosted').mockResolvedValue(principal);
    const stage = vi.spyOn(stageGate, 'refuseForeignStagePost').mockResolvedValue(null);
    const original = mocks.callLLM.getMockImplementation()!;
    mocks.callLLM.mockImplementation((...args) => {
      expect(getProviderQuotaOwner()).toBe(principal.ownerId);
      return original(...args);
    });
    try {
      const response = await POST(makeRequest({ ownerId: 'user:attacker-supplied' }));
      expect(response.status).toBe(200);
      expect(mocks.callLLM).toHaveBeenCalledTimes(1);
      expect(getProviderQuotaOwner()).toBeUndefined();
    } finally {
      auth.mockRestore();
      stage.mockRestore();
    }
  });

  it('keeps a correct first-turn evaluation when the model cites the current answer', async () => {
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({
        turnId: 'turn-1',
        criteria: [
          {
            criterionId: 'criterion-1',
            status: 'explained',
            reason: 'Said glucose',
            citation: { turnId: 'turn-1', excerpt: 'stored in glucose' },
          },
        ],
        nextQuestion: {
          questionId: 'q-2',
          text: 'What else is stored?',
          criterionId: 'criterion-1',
        },
        suggestion: 'Yes — energy is stored in glucose.',
      }),
    });
    const plan = {
      topic: 'Stored energy',
      criteria: [
        {
          criterionId: 'criterion-1',
          description: 'Where captured energy is stored',
          quote: 'Plants store captured energy in glucose',
          fragmentId: 'scene:scene-1',
        },
      ],
      peer,
      openingQuestion: {
        questionId: 'question-open',
        text: 'Where is energy stored?',
        criterionId: 'criterion-1',
      },
    };
    const response = await POST(
      makeRequest({
        learning: {
          operation: 'evaluate',
          activityId: 'act-1',
          requestId: 'req-2',
          source,
          plan,
          explanations: [
            {
              turnId: 'turn-1',
              turnIndex: 1,
              text: 'Energy is stored in glucose.',
              submittedAt: '2026-09-19T00:00:00.000Z',
              questionId: 'question-open',
            },
          ],
          priorResults: [],
          turnId: 'turn-1',
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.result.nextQuestion).toBeUndefined();
    expect(body.result.endReason).toBe('all_explained');
    expect(body.result.criteria[0].citation).toEqual({
      turnId: 'turn-1',
      excerpt: 'stored in glucose',
    });
  });

  it('accepts a third-turn result even if the model still asks another question', async () => {
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({
        turnId: 'turn-3',
        criteria: [
          {
            criterionId: 'criterion-1',
            status: 'needs_supplement',
            reason: 'Still missing where energy is stored.',
          },
        ],
        nextQuestion: {
          questionId: 'q-4',
          text: 'Where is the energy stored?',
          criterionId: 'criterion-1',
        },
        suggestion: 'The course says plants store captured energy in glucose.',
      }),
    });
    const plan = {
      topic: 'Stored energy',
      criteria: [
        {
          criterionId: 'criterion-1',
          description: 'Where captured energy is stored',
          quote: 'Plants store captured energy in glucose',
          fragmentId: 'scene:scene-1',
        },
      ],
      peer,
      openingQuestion: {
        questionId: 'question-open',
        text: 'Where is energy stored?',
        criterionId: 'criterion-1',
      },
    };
    const response = await POST(
      makeRequest({
        learning: {
          operation: 'evaluate',
          activityId: 'act-1',
          requestId: 'req-3b',
          source,
          plan,
          explanations: [1, 2, 3].map((turn) => ({
            turnId: `turn-${turn}`,
            turnIndex: turn,
            text: `answer ${turn}`,
            submittedAt: '2026-09-19T00:00:00.000Z',
            questionId: 'question-open',
          })),
          priorResults: [],
          turnId: 'turn-3',
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.nextQuestion).toBeUndefined();
    expect(body.result.endReason).toBe('max_turns');
    expect(body.result.suggestion).toContain('glucose');
  });

  it('rejects a fourth-round evaluate before calling the model', async () => {
    const plan = {
      topic: 'Stored energy',
      criteria: [
        {
          criterionId: 'criterion-1',
          description: 'Where captured energy is stored',
          quote: 'Plants store captured energy in glucose',
          fragmentId: 'scene:scene-1',
        },
      ],
      peer,
      openingQuestion: {
        questionId: 'question-open',
        text: 'Where is energy stored?',
        criterionId: 'criterion-1',
      },
    };
    const response = await POST(
      makeRequest({
        learning: {
          operation: 'evaluate',
          activityId: 'act-1',
          requestId: 'req-3',
          source,
          plan,
          explanations: [1, 2, 3, 4].map((turn) => ({
            turnId: `turn-${turn}`,
            turnIndex: turn,
            text: `answer ${turn}`,
            submittedAt: '2026-09-19T00:00:00.000Z',
            questionId: 'question-open',
          })),
          priorResults: [],
          turnId: 'turn-4',
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('rejects unusable source without calling the model', async () => {
    const response = await POST(
      makeRequest({
        learning: {
          operation: 'prepare',
          activityId: 'act-1',
          requestId: 'req-empty',
          source: { ...source, fragments: [] },
          topic: 'Stored energy',
          peer,
        },
      }),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe('insufficient_source');
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });
});
