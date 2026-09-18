import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop, type AgentLoopStoreState } from '@/lib/chat/agent-loop';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const state: AgentLoopStoreState = {
  stage: null,
  scenes: [],
  currentSceneId: null,
  mode: 'playback',
  whiteboardOpen: false,
};

describe('agent loop async store state', () => {
  it('awaits the fresh state before starting the request', async () => {
    const pending = deferred<AgentLoopStoreState>();
    const fetchChat = vi.fn(async () => new Response(''));
    const running = runAgentLoop(
      { config: { agentIds: [] }, apiKey: '' },
      {
        getStoreState: () => pending.promise,
        getMessages: () => [],
        fetchChat,
        onEvent: vi.fn(),
        onIterationEnd: async () => null,
      },
      new AbortController().signal,
    );

    await Promise.resolve();
    expect(fetchChat).not.toHaveBeenCalled();
    pending.resolve(state);
    await expect(running).resolves.toMatchObject({ reason: 'no_done' });
    expect(fetchChat).toHaveBeenCalledWith(
      expect.objectContaining({ storeState: state }),
      expect.any(AbortSignal),
    );
  });

  it('does not fetch after teardown aborts a pending state read', async () => {
    const pending = deferred<AgentLoopStoreState>();
    const controller = new AbortController();
    const fetchChat = vi.fn(async () => new Response(''));
    const running = runAgentLoop(
      { config: { agentIds: [] }, apiKey: '' },
      {
        getStoreState: () => pending.promise,
        getMessages: () => [],
        fetchChat,
        onEvent: vi.fn(),
        onIterationEnd: async () => null,
      },
      controller.signal,
    );

    controller.abort();

    await expect(
      Promise.race([
        running,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('abort remained blocked on store state')), 50),
        ),
      ]),
    ).resolves.toMatchObject({ reason: 'aborted' });
    expect(fetchChat).not.toHaveBeenCalled();
  });

  it('does not publish events from a response that arrives after teardown aborts', async () => {
    const pendingResponse = deferred<Response>();
    const controller = new AbortController();
    const onEvent = vi.fn();
    const fetchChat = vi.fn(() => pendingResponse.promise);
    const running = runAgentLoop(
      { config: { agentIds: [] }, apiKey: '' },
      {
        getStoreState: () => state,
        getMessages: () => [],
        fetchChat,
        onEvent,
        onIterationEnd: async () => null,
      },
      controller.signal,
    );

    await vi.waitFor(() => expect(fetchChat).toHaveBeenCalledOnce());
    controller.abort();
    pendingResponse.resolve(
      new Response(
        `data: ${JSON.stringify({
          type: 'cue_user',
          data: { fromAgentId: 'teacher', prompt: 'stale prompt' },
        })}\n\n`,
      ),
    );

    await expect(running).resolves.toMatchObject({ reason: 'aborted' });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('does not publish a stream chunk that arrives after teardown aborts', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
    );
    const controller = new AbortController();
    const onEvent = vi.fn();
    const fetchChat = vi.fn(async () => response);
    const running = runAgentLoop(
      { config: { agentIds: [] }, apiKey: '' },
      {
        getStoreState: () => state,
        getMessages: () => [],
        fetchChat,
        onEvent,
        onIterationEnd: async () => null,
      },
      controller.signal,
    );

    await vi.waitFor(() => expect(fetchChat).toHaveBeenCalledOnce());
    controller.abort();
    streamController.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({
          type: 'cue_user',
          data: { fromAgentId: 'teacher', prompt: 'late stream prompt' },
        })}\n\n`,
      ),
    );
    streamController.close();

    await expect(running).resolves.toMatchObject({ reason: 'aborted' });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('does not remain blocked when teardown aborts a pending buffer drain', async () => {
    const pendingDrain = deferred<null>();
    const controller = new AbortController();
    const onIterationEnd = vi.fn(() => pendingDrain.promise);
    const running = runAgentLoop(
      { config: { agentIds: [] }, apiKey: '' },
      {
        getStoreState: () => state,
        getMessages: () => [],
        fetchChat: async () => new Response(''),
        onEvent: vi.fn(),
        onIterationEnd,
      },
      controller.signal,
    );

    await vi.waitFor(() => expect(onIterationEnd).toHaveBeenCalledOnce());
    controller.abort();

    await expect(
      Promise.race([
        running,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('abort remained blocked on buffer drain')), 50),
        ),
      ]),
    ).resolves.toMatchObject({ reason: 'aborted' });
  });
});
