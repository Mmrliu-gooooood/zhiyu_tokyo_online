/**
 * P1-4: replay the golden thinking matrix (single turn, no tools, streaming)
 * through runtime/thinking.ts with temporary pi model objects and compare the
 * thinking-related request fields with the legacy payloads. Every difference
 * must be listed in thinking-allowlist.json with a reason; stale entries fail.
 *
 * Descriptors (P2-2) replace the temporary models; P2-5 re-runs the full
 * golden set through real bindings.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROVIDERS } from '@/lib/model-gateway/catalog/client-catalog';
import { loadPiProvider } from '@/lib/model-gateway/runtime/pi-registry';
import {
  startFakeModelServer,
  type FakeModelServer,
} from '@/lib/model-gateway/testing/fake-openai-server';
import type { PiModel, ThinkingCapability } from '@/lib/model-gateway/types';
import { UNKNOWN_MODEL_ID } from './matrix';
import {
  capturePayload,
  equivalenceBinding,
  loadGolden,
  sameFields,
  thinkingFields,
  type Mismatch,
} from './thinking-equivalence';

const ALLOWLIST_FILE = path.join(__dirname, 'thinking-allowlist.json');
const REPORT = process.env.THINKING_EQUIVALENCE_REPORT;

interface AllowEntry {
  group: string;
  /** Exact case id, or a regular expression when it starts with `^`. */
  case: string;
  reason: string;
}

async function fromPi(
  piProviderId: string,
  modelId: string,
  fallbackId?: string,
): Promise<PiModel> {
  const models = (await loadPiProvider(piProviderId)).getModels();
  const found = models.find((model) => model.id === modelId);
  if (found) return found;
  const template = models.find((model) => model.id === fallbackId) ?? models[0]!;
  // Hand-typed / unknown model ids are not assumed to reason.
  return {
    ...template,
    id: modelId,
    name: modelId,
    reasoning: modelId !== UNKNOWN_MODEL_ID && template.reasoning,
  };
}

function customCompletions(
  provider: string,
  modelId: string,
  compat: Record<string, unknown>,
): PiModel {
  return {
    reasoning: modelId !== UNKNOWN_MODEL_ID,
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider,
    baseUrl: '',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat,
  } as PiModel;
}

/** Temporary upstream models per legacy provider (until descriptors exist). */
const TEMP_MODELS: Record<
  string,
  (modelId: string) => Promise<{ model: PiModel; upstream: 'pi' | 'custom' }>
> = {
  deepseek: async (id) => ({
    model: await fromPi('deepseek', id, 'deepseek-flash'),
    upstream: 'pi',
  }),
  anthropic: async (id) => ({
    model: await fromPi('anthropic', id, 'claude-sonnet-4-5'),
    upstream: 'pi',
  }),
  openai: async (id) => ({ model: await fromPi('openai', id, 'gpt-5.4'), upstream: 'pi' }),
  kimi: async (id) => ({ model: await fromPi('moonshotai-cn', id, 'kimi-k2.6'), upstream: 'pi' }),
  xiaomi: async (id) => ({ model: await fromPi('xiaomi', id, 'mimo-v2.5-pro'), upstream: 'pi' }),
  grok: async (id) => ({ model: await fromPi('xai', id, 'grok-4.6'), upstream: 'pi' }),
  glm: async (id) => ({
    model: customCompletions('glm', id, { thinkingFormat: 'zai', supportsReasoningEffort: true }),
    upstream: 'custom',
  }),
  qwen: async (id) => ({
    model: customCompletions('qwen', id, {
      thinkingFormat: 'qwen',
      thinkingTokenBudgetField: 'thinking_budget',
      supportsReasoningEffort: false,
    }),
    upstream: 'custom',
  }),
};

/**
 * What P2 overlays will add: levels the reviewed capability allows beyond pi's
 * defaults (xhigh / max are opt-in in pi), and compat corrections.
 */
function withReviewedData(
  model: PiModel,
  _group: string,
  capability?: ThinkingCapability,
): PiModel {
  const map = { ...(model.thinkingLevelMap ?? {}) } as Record<string, string | null>;
  for (const level of ['minimal', 'xhigh', 'max'] as const) {
    if (capability?.effortValues?.includes(level)) map[level] = level;
  }
  const compat = { ...((model.compat as Record<string, unknown> | undefined) ?? {}) };
  // Toggle / budget capabilities never sent an effort (legacy GLM 5.1, MiMo, …).
  if (
    model.api === 'openai-completions' &&
    capability?.control &&
    capability.control !== 'effort'
  ) {
    compat.supportsReasoningEffort = false;
  }
  return { ...model, thinkingLevelMap: map, compat } as PiModel;
}

let server: FakeModelServer;
beforeAll(async () => {
  server = await startFakeModelServer();
});
afterAll(async () => {
  await server.close();
});

describe('thinking mapping vs legacy goldens (temporary models)', () => {
  it(
    'matches the legacy thinking fields or an allowlisted difference',
    { timeout: 120_000 },
    async () => {
      const mismatches: Mismatch[] = [];
      for (const [group, temp] of Object.entries(TEMP_MODELS)) {
        const golden = loadGolden(group);
        const catalog = PROVIDERS[group as keyof typeof PROVIDERS].models;
        for (const [caseId, entry] of Object.entries(golden)) {
          const input = entry.input;
          if (
            input.conversation !== 'single' ||
            input.tools ||
            !input.stream ||
            input.env ||
            input.baseUrl ||
            input.api
          )
            continue;
          if (!('body' in entry.request)) continue;
          const info = catalog.find((model) => model.id === input.modelId);
          const temporary = await temp(input.modelId);
          const upstream = temporary.upstream;
          const model = withReviewedData(temporary.model, group, info?.capabilities?.thinking);
          const binding = equivalenceBinding(
            {
              model,
              upstream,
              capability: info?.capabilities?.thinking,
              thinking: input.thinking,
              knownModel: !!info,
            },
            server.origin,
          );
          const captured = await capturePayload(server, binding);
          const legacy = thinkingFields(entry.request.body, entry.request.path);
          const current = captured
            ? thinkingFields(captured.body, captured.path)
            : { error: 'no request' };
          if (!sameFields(legacy, current))
            mismatches.push({ group, caseId, legacy, gateway: current });
        }
      }

      if (REPORT) writeFileSync(REPORT, JSON.stringify(mismatches, null, 2));
      const allow = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8')) as AllowEntry[];
      const matches = (entry: AllowEntry, mismatch: Mismatch) =>
        entry.group === mismatch.group &&
        (entry.case.startsWith('^')
          ? new RegExp(entry.case).test(mismatch.caseId)
          : entry.case === mismatch.caseId);
      const unexplained = mismatches.filter(
        (mismatch) => !allow.some((entry) => matches(entry, mismatch)),
      );
      const stale = allow.filter(
        (entry) => !mismatches.some((mismatch) => matches(entry, mismatch)),
      );
      expect(unexplained).toEqual([]);
      expect(stale).toEqual([]);
    },
  );
});
