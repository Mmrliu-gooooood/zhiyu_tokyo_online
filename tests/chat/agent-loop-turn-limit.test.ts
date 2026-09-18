import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop, type AgentLoopStoreState } from '@/lib/chat/agent-loop';

const state: AgentLoopStoreState = {
  stage: null,
  scenes: [],
  currentSceneId: null,
  mode: 'playback',
  whiteboardOpen: false,
};

describe('automatic classroom replies per user message', () => {
  it.each([
    { previous: '明白了', current: '为什么会这样？', count: 2, reason: 'turn_limit' },
    { previous: '为什么会这样？', current: '明白了', count: 1, reason: 'end' },
  ])(
    'uses the new user input while the reused session ref still contains $previous',
    async ({ previous, current, count, reason }) => {
      const fetchChat = vi.fn(async () => new Response(''));
      const outcome = await runAgentLoop(
        {
          messages: [{ role: 'user', content: current }],
          config: { agentIds: ['teacher'], sessionType: 'qa' },
          apiKey: '',
        },
        {
          getStoreState: () => state,
          getMessages: () => [{ role: 'user', content: previous }],
          fetchChat,
          onEvent: vi.fn(),
          onIterationEnd: async () => ({
            totalAgents: 1,
            agentHadContent: true,
            cueUserReceived: false,
          }),
        },
        new AbortController().signal,
      );
      expect(fetchChat).toHaveBeenCalledTimes(count);
      expect(outcome.reason).toBe(reason);
    },
  );
  it('reports an empty acknowledgment reply as failure instead of completing the session', async () => {
    const fetchChat = vi.fn(async () => new Response(''));
    const outcome = await runAgentLoop(
      { config: { agentIds: ['teacher'], sessionType: 'qa' }, apiKey: '' },
      {
        getStoreState: () => state,
        getMessages: () => [{ role: 'user', content: '明白了' }],
        fetchChat,
        onEvent: vi.fn(),
        onIterationEnd: async () => ({
          totalAgents: 1,
          agentHadContent: false,
          cueUserReceived: false,
        }),
      },
      new AbortController().signal,
    );
    expect(outcome.reason).toBe('empty_turns');
    expect(fetchChat).toHaveBeenCalledOnce();
  });
  it.each([
    { sessionType: 'qa', limit: 2, message: 'Explain this concept.' },
    { sessionType: 'discussion', limit: 2, message: 'Explain this concept.' },
    { sessionType: 'discussion', limit: 1, message: '明白了' },
    { sessionType: 'qa', limit: 1, message: '对' },
    { sessionType: 'qa', limit: 2, message: '对吗？' },
    { sessionType: 'qa', limit: 2, message: '明白了，但还有一个问题' },
    { sessionType: 'discussion', limit: 3, message: '请深入讨论这一点' },
    { sessionType: 'discussion', limit: 6, message: '' },
  ])(
    'yields after $limit $sessionType replies even if the director keeps speaking',
    async ({ sessionType, limit, message }) => {
      const fetchChat = vi.fn(async () => new Response(''));
      let completed = 0;
      const outcome = await runAgentLoop(
        { config: { agentIds: ['teacher', 'student'], sessionType }, apiKey: '' },
        {
          getStoreState: () => state,
          getMessages: () =>
            message ? [{ role: 'user', parts: [{ type: 'text', text: message }] }] : [],
          fetchChat,
          onEvent: vi.fn(),
          onIterationEnd: async () => {
            completed += 1;
            // An eventual END keeps the broken implementation deterministic;
            // the application must yield before this extra response is fetched.
            return {
              // A stale server counter cannot reset the local reply budget.
              directorState: { turnCount: 0, agentResponses: [], whiteboardLedger: [] },
              totalAgents: completed <= limit ? 1 : 0,
              agentHadContent: true,
              cueUserReceived: false,
            };
          },
        },
        new AbortController().signal,
      );

      expect(fetchChat).toHaveBeenCalledTimes(limit);
      expect(outcome).toMatchObject({
        reason: limit === 1 ? 'end' : 'turn_limit',
        turnCount: limit,
      });
    },
  );

  it.each([
    { reason: 'cue_user', totalAgents: 1, agentHadContent: true, cueUserReceived: true, calls: 1 },
    { reason: 'end', totalAgents: 0, agentHadContent: false, cueUserReceived: false, calls: 1 },
    {
      reason: 'empty_turns',
      totalAgents: 1,
      agentHadContent: false,
      cueUserReceived: false,
      calls: 2,
    },
  ])('preserves early termination for $reason', async ({ reason, calls, ...iteration }) => {
    const fetchChat = vi.fn(async () => new Response(''));
    const outcome = await runAgentLoop(
      { config: { agentIds: ['teacher'] }, apiKey: '' },
      {
        getStoreState: () => state,
        getMessages: () => [],
        fetchChat,
        onEvent: vi.fn(),
        onIterationEnd: async () => iteration,
      },
      new AbortController().signal,
    );
    expect(outcome.reason).toBe(reason);
    expect(fetchChat).toHaveBeenCalledTimes(calls);
  });

  it('honors manual cancellation while the final reply drains', async () => {
    const controller = new AbortController();
    const fetchChat = vi.fn(async () => new Response(''));
    const outcome = await runAgentLoop(
      { config: { agentIds: ['teacher'] }, apiKey: '' },
      {
        getStoreState: () => state,
        getMessages: () => [],
        fetchChat,
        onEvent: vi.fn(),
        onIterationEnd: async () => {
          controller.abort();
          return { totalAgents: 1, agentHadContent: true, cueUserReceived: false };
        },
      },
      controller.signal,
    );
    expect(outcome.reason).toBe('aborted');
    expect(fetchChat).toHaveBeenCalledOnce();
  });
});
