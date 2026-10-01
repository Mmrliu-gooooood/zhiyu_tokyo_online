import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  resolveParamsBinding: vi.fn(),
}));

vi.mock('@/lib/model-gateway', async (importOriginal) =>
  (await import('@/tests/helpers/model-gateway-mock')).mockGatewayModule(
    await importOriginal(),
    mocks,
  ),
);

import { POST } from '@/app/api/learning/coach/route';

const currentScene = {
  id: 'scene-2',
  stageId: 'stage-1',
  order: 0,
  title: 'Energy',
  type: 'slide',
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-2',
      elements: [
        { id: 'text-1', type: 'text', content: 'Plants store captured energy in glucose.' },
      ],
    },
  },
};

const context = {
  schemaVersion: 1,
  requestId: 'request-1',
  chatSessionId: 'session-1',
  stageId: 'stage-1',
  contentRevision: 'content-7',
  scopedRevision: 'sha256:0b5384130fa848394382bcecc8f6122514f9f9be2762b9d0c92c9344b8672215',
  phase: 'explain',
  source: { kind: 'scene', sceneId: 'scene-2' },
  evidence: [{ ref: 'scene#body', content: 'Plants store captured energy in glucose.' }],
};

function makeRequest(overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/learning/coach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'session-1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Where is captured energy stored?' }],
        },
      ],
      storeState: {
        stage: { id: 'stage-1', name: 'Physics' },
        scenes: [currentScene],
        currentSceneId: 'scene-2',
        mode: 'playback',
        whiteboardOpen: false,
      },
      config: { agentIds: ['default-1'], sessionType: 'qa' },
      learningContext: context,
      apiKey: 'client-key',
      baseUrl: 'https://provider.example/v1',
      model: 'openai/test-model',
      providerType: 'openai',
      modelSource: 'user',
      ...overrides,
    }),
  });
}

async function readEvents(response: Response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as { type: string; data: Record<string, unknown> });
}

describe('learning coach route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_GUIDED_LEARNING_ENABLED', 'true');
    mocks.resolveParamsBinding.mockResolvedValue({ modelString: 'resolved-model' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('emits only the public checked answer followed by exactly one cue and done', async () => {
    mocks.complete
      .mockResolvedValueOnce({
        text: JSON.stringify({
          explanation: 'PRIVATE CANDIDATE: Energy is stored in glucose.',
          checkPrompt: 'Where is it stored?',
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          verdict: 'issue_found',
          reviewNote: 'Remove the private marker.',
          evidenceRefs: ['scene#body'],
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          explanation: 'Energy is stored in glucose.',
          checkPrompt: 'Where is it stored?',
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          verdict: 'no_issue_found',
          reviewNote: 'Consistent with the supplied scene.',
          evidenceRefs: ['scene#body'],
        }),
      });

    const response = await POST(makeRequest());
    const events = await readEvents(response);

    expect(response.status).toBe(200);
    expect(
      events.every((event) =>
        ['agent_start', 'text_delta', 'agent_end', 'cue_user', 'done', 'error'].includes(
          event.type,
        ),
      ),
    ).toBe(true);
    expect(events.filter(({ type }) => type === 'cue_user')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'done')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('PRIVATE CANDIDATE');
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      data: { agentHadContent: true, cueUserReceived: true },
    });
    expect(mocks.complete).toHaveBeenCalledTimes(4);
    expect(mocks.complete.mock.calls.every(([, , opts]) => opts.retry === 'none')).toBe(true);
    expect(mocks.complete.mock.calls.every(([, req]) => req.tools === undefined)).toBe(true);
  });

  it('preserves the selected chat model binding when resolving guided requests', async () => {
    mocks.complete
      .mockResolvedValueOnce({
        text: JSON.stringify({ explanation: 'Stored in glucose.', checkPrompt: 'Where?' }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          verdict: 'no_issue_found',
          reviewNote: 'Matches evidence.',
          evidenceRefs: ['scene#body'],
        }),
      });

    await POST(makeRequest());

    expect(mocks.resolveParamsBinding).toHaveBeenCalledWith(
      {
        modelString: 'openai/test-model',
        apiKey: 'client-key',
        baseUrl: 'https://provider.example/v1',
        providerType: 'openai',
        source: 'user',
        platformDefaultId: undefined,
        thinkingConfig: undefined,
      },
      'chat-adapter',
    );
  });

  it('rejects disabled, malformed, or mismatched contexts before any model call', async () => {
    vi.stubEnv('NEXT_PUBLIC_GUIDED_LEARNING_ENABLED', 'false');
    const disabled = await POST(makeRequest());
    expect(disabled.status).toBe(404);

    vi.stubEnv('NEXT_PUBLIC_GUIDED_LEARNING_ENABLED', 'true');
    const mismatched = await POST(
      makeRequest({ learningContext: { ...context, chatSessionId: 'another-session' } }),
    );
    expect(mismatched.status).toBe(400);

    const contentRevision = `sha256:${'a'.repeat(64)}`;
    const substitutedAttempt = await POST(
      makeRequest({
        learningContext: {
          ...context,
          contentRevision,
          scopedRevision: `${contentRevision}:learning_attempt:attempt-1:another-question`,
          source: {
            kind: 'learning_attempt',
            attemptId: 'attempt-1',
            questionId: 'q1',
          },
          evidence: [
            {
              ref: 'remediation:learning_attempt:attempt-1:q1',
              content: JSON.stringify({
                prompt: 'What does net force change?',
                grading: { status: 'pending', interpretation: 'needs_verification' },
              }),
            },
          ],
        },
      }),
    );
    expect(substitutedAttempt.status).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.resolveParamsBinding).not.toHaveBeenCalled();
  });

  it('rejects an oversized chat envelope before model resolution', async () => {
    const response = await POST(
      makeRequest({
        messages: [
          {
            role: 'user',
            parts: [{ type: 'text', text: 'x'.repeat(140_000) }],
          },
        ],
      }),
    );

    expect(response.status).toBe(413);
    expect(mocks.resolveParamsBinding).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('rejects stale scene evidence before resolving or calling the model', async () => {
    const response = await POST(
      makeRequest({
        storeState: {
          stage: { id: 'stage-1', name: 'Physics' },
          scenes: [
            {
              ...currentScene,
              content: {
                ...currentScene.content,
                canvas: {
                  ...currentScene.content.canvas,
                  elements: [
                    {
                      id: 'text-1',
                      type: 'text',
                      content: 'Plants now store captured energy in a revised molecule.',
                    },
                  ],
                },
              },
            },
          ],
          currentSceneId: 'scene-2',
          mode: 'playback',
          whiteboardOpen: false,
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.resolveParamsBinding).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('rejects an oversized Content-Length before reading or resolving the model', async () => {
    const request = makeRequest();
    const body = request.body;
    expect(body).not.toBeNull();
    const response = await POST(
      new NextRequest(request.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(128 * 1024 + 1),
        },
        body,
        duplex: 'half',
      }),
    );

    expect(response.status).toBe(413);
    expect(mocks.resolveParamsBinding).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
