import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelGateway, ThinkingConfig } from '@/lib/model-gateway';
import {
  createFauxGateway,
  fauxAssistantMessage,
  type FauxGateway,
} from '@/lib/model-gateway/testing/faux-gateway';

/**
 * #1003: the PBL v2 runtime reaches the model only through the gateway, and
 * holds no thinking opinion of its own.
 *
 * The runtime used to force thinking off on the teaching turns through a
 * hand-rolled helper. That is gone: the agents call the gateway with the
 * resolved binding, and what the request / stage route asked for (the
 * binding's thinking) is what the provider sees.
 *
 * Asserted at the provider boundary (pi's faux provider, behind the real
 * gateway pipeline), where a regression would actually bite:
 *
 *   1. an incoming thinking config arrives as the provider reasoning level,
 *   2. NO config means NO reasoning level — nothing in the runtime substitutes
 *      one, which is the property a re-added policy constant would break,
 *   3. the turn is accounted for under its own usage source.
 *
 * The global kill switch (LLM_THINKING_DISABLED) is a gateway rule, covered in
 * tests/model-gateway/thinking-default-mode.test.ts.
 */
const holder = vi.hoisted(() => ({ gateway: undefined as unknown as ModelGateway }));

vi.mock('@/lib/model-gateway', async (importOriginal) =>
  (await import('@/tests/helpers/model-gateway-mock')).mockGatewayModule(await importOriginal(), {
    delegate: () => holder.gateway,
  }),
);

import { runTaskEvaluation } from '@/lib/pbl/v2/agents/evaluator';
import { runSimulatorTurn } from '@/lib/pbl/v2/agents/simulator';
import { addSubmission } from '@/lib/pbl/v2/operations/runtime/submission';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';

const NOT_CAPTURED = Symbol('provider was never invoked');

/** A faux binding for an effort-controlled reasoning model, with the given thinking. */
function effortBinding(faux: FauxGateway, thinking?: ThinkingConfig) {
  const base = faux.binding();
  return faux.binding({
    capabilities: {
      ...base.capabilities,
      thinking: { control: 'effort', effortValues: ['none', 'low', 'medium', 'high'] },
    },
    ...(thinking ? { thinking } : {}),
  });
}

/** A faux gateway whose every response records the reasoning level it saw. */
function scriptedGateway(text: string, seen: unknown[]): FauxGateway {
  const faux = createFauxGateway();
  const respond = (_context: unknown, options: { reasoning?: unknown } | undefined) => {
    seen.push(options?.reasoning);
    return fauxAssistantMessage(text);
  };
  faux.faux.setResponses([respond, respond, respond, respond]);
  holder.gateway = faux.gateway;
  return faux;
}

function mkProject(): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 't',
    description: 'd',
    proficiency: 'intermediate',
    language: 'zh-CN',
    tags: [],
    status: 'active',
    roles: [],
    milestones: [
      {
        id: 'ms1',
        title: 'M1',
        status: 'completed',
        order: 0,
        microtasks: [
          {
            id: 't1',
            title: 'T1',
            status: 'completed',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
        documents: [],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: 'ts',
    updatedAt: 'ts',
  };
}

/** SCENARIO fixture, trimmed from simulator.test.ts — enough for one roleplay
 *  turn, which fires BOTH simulator provider calls (character line + narrator). */
function scenarioProject(): PBLProjectV2 {
  return {
    language: 'zh-CN',
    roles: [{ id: 'role-i', type: 'instructor', name: '教练' }],
    threads: [{ agentId: 'role-i', messages: [] }],
    updatedAt: 'ts',
    scenario: {
      setting: '校园咖啡馆的午后',
      goal: '练习倾听与共情',
      learnerRole: '你是林夏的好朋友',
      characters: [{ id: 'c1', name: '林夏', persona: '内向', situation: '情绪低落' }],
    },
    milestones: [
      {
        id: 'ms-rp',
        title: '和林夏聊一聊',
        status: 'active',
        order: 0,
        documents: [],
        scenarioStage: 'roleplay',
        briefing: '你坐在咖啡馆里。',
        microtasks: [
          {
            id: 'beat-1',
            title: 'beat',
            status: 'in_progress',
            assignee: 'user',
            hints: [],
            order: 0,
            description: '林夏坐在你对面。',
            narration: '你们走进了一家安静的咖啡馆。',
          },
        ],
      },
    ],
    evaluations: [],
    engagementEvents: [],
  } as unknown as PBLProjectV2;
}

async function runEvaluation(
  thinking?: ThinkingConfig,
): Promise<{ seenThinking: unknown; faux: FauxGateway }> {
  const project = mkProject();
  addSubmission(project, {
    microtaskId: 't1',
    milestoneId: 'ms1',
    kind: 'text',
    content: 'submission',
  });

  const seen: unknown[] = [];
  const faux = scriptedGateway('{"feedback":"ok","score":80}', seen);

  const events: PBLSSEEvent[] = [];
  for await (const ev of runTaskEvaluation({
    project,
    milestoneId: 'ms1',
    microtaskId: 't1',
    binding: effortBinding(faux, thinking),
  })) {
    events.push(ev);
  }

  // Guard the guard: an evaluation that errored out before calling the model
  // would make every assertion below vacuous.
  expect(seen.length).toBe(1);
  expect(events.at(-1)?.type).toBe('done');
  return { seenThinking: seen[0] ?? NOT_CAPTURED, faux };
}

describe('PBL v2 runtime goes through the model gateway (#1003)', () => {
  beforeEach(() => {
    delete process.env.LLM_THINKING_DISABLED;
  });

  it('passes an incoming thinking config through to the provider', async () => {
    const { seenThinking } = await runEvaluation({ mode: 'enabled', effort: 'low' });
    expect(seenThinking).toBe('low');
  });

  it('substitutes nothing when the request carries no thinking config', async () => {
    // The runtime holds no policy of its own. A re-added hardcoded constant
    // would show up right here as a reasoning level the caller never asked for.
    const { seenThinking } = await runEvaluation();
    expect(seenThinking).toBe(NOT_CAPTURED);
  });

  it('accounts for the turn under its own usage source', async () => {
    const { faux } = await runEvaluation();
    expect(faux.usage).toEqual([expect.objectContaining({ source: 'pbl-v2-evaluator-task' })]);
  });
});

/**
 * The simulator turn makes TWO provider calls — the streamed character line and
 * the non-streamed director-narrator pass. The narrator was the last site still
 * dropping the resolved config (caught in review on #1006); with the config on
 * the binding, both passes now share it by construction.
 */
describe('PBL v2 simulator turn — both provider calls see the resolved config', () => {
  async function runSimulator(thinking?: ThinkingConfig) {
    const seen: unknown[] = [];
    const faux = scriptedGateway('嗯……你来了。', seen);

    const events: PBLSSEEvent[] = [];
    for await (const ev of runSimulatorTurn({
      project: scenarioProject(),
      userMessage: '',
      phase: 'greeting',
      binding: effortBinding(faux, thinking),
    })) {
      events.push(ev);
    }
    expect(events.at(-1)?.type).toBe('done');
    return { seen, faux };
  }

  it('forwards an incoming config to the character line AND the narrator', async () => {
    const { seen } = await runSimulator({ mode: 'enabled', effort: 'low' });
    // Both passes must have run, or this test would silently cover only one.
    expect(seen).toEqual(['low', 'low']);
  });

  it('substitutes nothing on either call when the request carries no config', async () => {
    const { seen } = await runSimulator();
    expect(seen).toEqual([undefined, undefined]);
  });

  it('accounts for both passes under their own usage sources', async () => {
    const { faux } = await runSimulator();
    expect(faux.usage.map((event) => event.source).sort()).toEqual([
      'pbl-v2-simulator',
      'pbl-v2-simulator-narrator',
    ]);
  });
});
