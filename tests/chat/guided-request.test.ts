import { describe, expect, it, vi } from 'vitest';
import { runGuidedSingleRequest } from '@/lib/chat/guided-request';

const outcome = {
  schemaVersion: 1 as const,
  requestId: 'request-1',
  phase: 'wait_student' as const,
  published: { explanation: 'Stored energy.', reviewNote: 'Checked against scene evidence.' },
  checkPrompt: 'Where is it stored?',
  review: { verdict: 'no_issue_found' as const, evidenceRefs: ['scene#body'] },
  budget: { callsUsed: 2, callLimit: 4 as const, stopReason: 'completed' as const },
  usage: { status: 'unknown' as const },
};

function responseFor(events: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    }),
  );
}

const validEvents = [
  {
    type: 'agent_start',
    data: { messageId: 'teacher-1', agentId: 'default-1', agentName: 'Teacher' },
  },
  { type: 'text_delta', data: { messageId: 'teacher-1', content: 'Stored energy.' } },
  { type: 'agent_end', data: { messageId: 'teacher-1', agentId: 'default-1' } },
  { type: 'cue_user', data: { fromAgentId: 'default-1', prompt: 'Where is it stored?' } },
  {
    type: 'done',
    data: {
      totalActions: 0,
      totalAgents: 1,
      agentHadContent: true,
      cueUserReceived: true,
      learningOutcome: outcome,
    },
  },
];

describe('runGuidedSingleRequest', () => {
  it('forwards one valid published turn and returns its validated public outcome', async () => {
    const onEvent = vi.fn();
    const onIterationEnd = vi.fn(async () => ({
      totalAgents: 1,
      agentHadContent: true,
      cueUserReceived: true,
    }));
    const fetchFn = vi.fn(async () => responseFor(validEvents));

    const result = await runGuidedSingleRequest(
      { learningContext: { evidence: [{ ref: 'scene#body' }] } },
      new AbortController(),
      () => ({ onEvent, onIterationEnd }),
      fetchFn,
    );

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'agent_start',
      'text_delta',
      'agent_end',
      'cue_user',
      'done',
    ]);
    expect(onIterationEnd).toHaveBeenCalledOnce();
    expect(result).toEqual(outcome);
  });

  it.each([
    ['forbidden action', [...validEvents.slice(0, 2), { type: 'action', data: {} }]],
    ['duplicate cue', [...validEvents.slice(0, 4), validEvents[3], validEvents[4]]],
    ['done before cue', [...validEvents.slice(0, 3), validEvents[4]]],
    ['unexpected EOF', validEvents.slice(0, 4)],
  ])('rejects %s without retrying', async (_name, events) => {
    const fetchFn = vi.fn(async () => responseFor(events));

    await expect(
      runGuidedSingleRequest(
        { learningContext: { evidence: [{ ref: 'scene#body' }] } },
        new AbortController(),
        () => ({ onEvent: vi.fn(), onIterationEnd: vi.fn(async () => null) }),
        fetchFn,
      ),
    ).rejects.toThrow('guided stream');

    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('drops a response that arrives after the shared request is aborted', async () => {
    const controller = new AbortController();
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const onEvent = vi.fn();
    const request = runGuidedSingleRequest(
      { learningContext: { evidence: [{ ref: 'scene#body' }] } },
      controller,
      () => ({ onEvent, onIterationEnd: vi.fn(async () => null) }),
      fetchFn,
    );

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    controller.abort();
    resolveResponse?.(responseFor(validEvents));

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('drops a response when its stage or source producer is no longer current', async () => {
    const onEvent = vi.fn();
    const onIterationEnd = vi.fn(async () => null);
    const onResponseAccepted = vi.fn();

    await expect(
      runGuidedSingleRequest(
        { learningContext: { evidence: [{ ref: 'scene#body' }] } },
        new AbortController(),
        () => ({ onEvent, onIterationEnd }),
        vi.fn(async () => responseFor(validEvents)),
        onResponseAccepted,
        () => false,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(onResponseAccepted).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onIterationEnd).not.toHaveBeenCalled();
  });
});
