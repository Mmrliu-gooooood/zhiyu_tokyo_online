/**
 * Classmate speaking rules in live classroom chat (learning plan B04): the
 * server reads each classmate's rule and role from its stored revision,
 * filters the roster before either director runs, and both directors call a
 * named classmate first. Requests without classmates never reach the
 * database; a lookup failure leaves the roster as sent.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildDirectorPrompt } from '@/lib/chat/pi/prompts';
import { createOrchestrationGraph, buildInitialState } from '@/lib/orchestration/director-graph';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  applyClassmateSpeechRules,
  type ClassmateSpeechDeps,
} from '@/lib/server/study/classmates/speech-policy';
import type { ClassmateSnapshot } from '@/lib/study/classmates/contracts';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { ModelBinding } from '@/lib/model-gateway';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QUIET = 'cm-0123456789abcdef-r2';
const ACTIVE = 'cm-fedcba9876543210-r1';

const snapshot = (overrides: Partial<ClassmateSnapshot>): ClassmateSnapshot => ({
  name: '小林',
  role: 'student',
  persona: '',
  learningStyle: 'peer',
  speechPolicy: 'on_demand',
  avatar: '/avatars/curious.png',
  color: '#10b981',
  voice: null,
  ...overrides,
});

function agentConfig(id: string, name: string, role: string, priority: number) {
  return {
    id,
    name,
    role,
    persona: `${name} persona`,
    avatar: '',
    color: '#000000',
    allowedActions: role === 'teacher' ? ['spotlight', 'wb_open'] : ['spotlight', 'laser'],
    priority,
    isGenerated: true,
  };
}

function body(
  text: string,
  extra: Partial<StatelessChatRequest['config']> = {},
): StatelessChatRequest {
  return {
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }],
    storeState: {
      stage: { id: 'stage-1', name: 'Calculus' },
      scenes: [],
      currentSceneId: null,
      mode: 'playback',
      whiteboardOpen: false,
    },
    config: {
      agentIds: ['default-1', QUIET, ACTIVE],
      agentConfigs: [
        agentConfig(QUIET, '小林', 'student', 5),
        agentConfig(ACTIVE, 'Ada', 'assistant', 7),
      ],
      sessionType: 'qa',
      ...extra,
    },
    apiKey: '',
  } as unknown as StatelessChatRequest;
}

function deps(overrides: Partial<ClassmateSpeechDeps> = {}): ClassmateSpeechDeps {
  return {
    enabled: () => true,
    resolveOwnerId: async () => OWNER,
    readRevisions: vi.fn(
      async () =>
        new Map([
          [QUIET, snapshot({})],
          [ACTIVE, snapshot({ name: 'Ada', role: 'assistant', speechPolicy: 'active' })],
        ]),
    ),
    ...overrides,
  };
}

const req = new Request('http://localhost/api/chat', { method: 'POST' });

describe('applyClassmateSpeechRules', () => {
  it('drops an unnamed on-demand classmate and resets classmate actions from the snapshot', async () => {
    const request = body('为什么这里要换元？', { addressedAgentId: 'default-1' });
    const injected = deps();
    await applyClassmateSpeechRules(req, request, injected);
    expect(request.config.agentIds).toEqual(['default-1', ACTIVE]);
    expect(request.config.addressedAgentId).toBeUndefined();
    expect(injected.readRevisions).toHaveBeenCalledWith(OWNER, [
      { classmateId: 'cm-0123456789abcdef', revision: 2 },
      { classmateId: 'cm-fedcba9876543210', revision: 1 },
    ]);
    const ada = request.config.agentConfigs!.find((agent) => agent.id === ACTIVE)!;
    expect(ada.role).toBe('assistant');
    expect(ada.allowedActions).not.toContain('spotlight');
  });

  it('keeps and addresses the classmate the student names', async () => {
    const request = body('小林，你来试试这道题');
    await applyClassmateSpeechRules(req, request, deps());
    expect(request.config.agentIds).toEqual(['default-1', QUIET, ACTIVE]);
    expect(request.config.addressedAgentId).toBe(QUIET);
  });

  it('never queries without classmate agents, and fails open', async () => {
    const plain = body('hi');
    plain.config.agentIds = ['default-1', 'default-2'];
    plain.config.addressedAgentId = 'default-2';
    const injected = deps();
    await applyClassmateSpeechRules(req, plain, injected);
    expect(injected.readRevisions).not.toHaveBeenCalled();
    expect(plain.config.addressedAgentId).toBeUndefined();

    const failing = body('为什么？');
    await applyClassmateSpeechRules(
      req,
      failing,
      deps({ readRevisions: async () => Promise.reject(new Error('db down')) }),
    );
    expect(failing.config.agentIds).toEqual(['default-1', QUIET, ACTIVE]);

    const signedOut = body('为什么？');
    await applyClassmateSpeechRules(
      req,
      signedOut,
      deps({ resolveOwnerId: async () => undefined }),
    );
    expect(signedOut.config.agentIds).toHaveLength(3);
  });
});

const teacher: AgentConfig = {
  id: 'default-1',
  name: '启衡',
  role: 'teacher',
  persona: 'Lead teacher.',
  avatar: '',
  color: '#3366ff',
  allowedActions: [],
  priority: 10,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  isDefault: true,
};

describe('directors call a named classmate first', () => {
  it('Pi: the director prompt says who was addressed', () => {
    const request = body('小林，你来试试');
    const quiet = {
      ...agentConfig(QUIET, '小林', 'student', 5),
      isDefault: false,
    } as unknown as AgentConfig;
    const plain = buildDirectorPrompt(request, [teacher, quiet], 2);
    expect(plain).not.toContain('addressed 小林');
    request.config.addressedAgentId = QUIET;
    expect(buildDirectorPrompt(request, [teacher, quiet], 2)).toContain(
      'The student addressed 小林 by name',
    );
  });

  it('LangGraph: the first turn of a student message goes to the addressed classmate', async () => {
    const request = body('小林，你来试试');
    request.config.agentIds = ['default-1', QUIET];
    request.config.addressedAgentId = QUIET;
    const binding = {
      modelString: 'fake:model',
      model: { api: 'openai-completions', provider: 'fake', id: 'model' },
      credentialReady: false,
    } as unknown as ModelBinding;
    const state = buildInitialState(request, binding);
    expect(state.addressedAgentId).toBe(QUIET);
    const events: StatelessEvent[] = [];
    const controller = new AbortController();
    try {
      const stream = await createOrchestrationGraph().stream(state, {
        streamMode: 'custom' as never,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        const event = chunk as StatelessEvent;
        events.push(event);
        if (event.type === 'thinking' && event.data.stage === 'agent_loading') {
          controller.abort();
          break;
        }
      }
    } catch {
      // The fake binding cannot generate; only the director's choice matters here.
    }
    const loading = events.find(
      (event) => event.type === 'thinking' && event.data.stage === 'agent_loading',
    ) as Extract<StatelessEvent, { type: 'thinking' }> | undefined;
    expect(loading?.data.agentId).toBe(QUIET);
  });
});
