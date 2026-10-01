/**
 * Shared harness: replay golden cases through the gateway (fake server) and
 * compare only the thinking-related request fields with the legacy payload.
 * P1-4 drives it with temporary pi model objects; P2-5 with real descriptors.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createBinding } from '@/lib/model-gateway/credentials/handles';
import type { FakeModelServer } from '@/lib/model-gateway/testing/fake-openai-server';
import type {
  ModelBinding,
  PiModel,
  ThinkingCapability,
  ThinkingConfig,
} from '@/lib/model-gateway/types';
import { userText } from '@/lib/model-gateway/messages';
import { testGateway } from '../helpers';
import type { GoldenEntry } from './legacy-payloads.test';
import { sortKeys } from './matrix';

export const GOLDEN_DIR = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'model-gateway',
  'legacy-payloads',
);

export function loadGolden(group: string): Record<string, GoldenEntry> {
  return (
    JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${group}.json`), 'utf8')) as {
      cases: Record<string, GoldenEntry>;
    }
  ).cases;
}

const COMPLETIONS_FIELDS = [
  'thinking',
  'reasoning_effort',
  'reasoning',
  'enable_thinking',
  'thinking_budget',
  'chat_template_kwargs',
] as const;

/**
 * Thinking-related fields of a request body, normalized across protocols so a
 * provider that changed wire protocol (e.g. grok chat → responses) compares
 * by meaning: `effort` is the reasoning effort wherever it is carried.
 */
export function thinkingFields(body: unknown, path: string): Record<string, unknown> {
  const record = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (path.endsWith('/messages')) {
    const thinking = record.thinking as Record<string, unknown> | undefined;
    if (thinking) {
      out.thinking = thinking.type;
      if (thinking.budget_tokens !== undefined) out.budget = thinking.budget_tokens;
    }
    const effort = (record.output_config as Record<string, unknown> | undefined)?.effort;
    if (effort !== undefined) out.effort = effort;
    return out;
  }
  if (path.endsWith('/responses')) {
    const effort = (record.reasoning as Record<string, unknown> | undefined)?.effort;
    if (effort !== undefined) out.effort = effort;
    return out;
  }
  for (const key of COMPLETIONS_FIELDS) {
    if (record[key] === undefined) continue;
    if (key === 'reasoning_effort') out.effort = record[key];
    else out[key] = record[key];
  }
  return out;
}

export interface CaseBindingInput {
  model: PiModel;
  upstream: 'pi' | 'custom';
  capability?: ThinkingCapability;
  thinking?: ThinkingConfig;
  knownModel: boolean;
}

export function equivalenceBinding(input: CaseBindingInput, origin: string): ModelBinding {
  return createBinding(
    {
      source: 'user',
      providerId: input.model.provider,
      modelId: input.model.id,
      modelString: `${input.model.provider}:${input.model.id}`,
      model: { ...input.model, baseUrl: origin },
      upstream: input.upstream,
      capabilities: {
        tools: true,
        vision: false,
        reasoning: input.model.reasoning,
        contextWindow: input.model.contextWindow,
        maxOutputTokens: input.model.maxTokens,
        knownModel: input.knownModel,
        thinking: input.capability,
      },
      transforms: { inlineThinkTags: false, payloadPatches: [] },
      thinking: input.thinking,
      funding: { kind: 'byok' },
      endpoint: 'official',
    },
    { kind: 'inline-key', apiKey: 'sk-equivalence' },
  );
}

export async function capturePayload(
  server: FakeModelServer,
  binding: ModelBinding,
): Promise<{ body: unknown; path: string } | undefined> {
  const before = server.requests.length;
  const { gateway } = testGateway();
  await gateway
    .complete(
      binding,
      { system: 'You are a characterization test.', messages: [userText('Hello', 0)] },
      { source: 'equivalence', retry: 'none' },
    )
    .catch(() => undefined);
  const request = server.requests[before];
  return request ? { body: request.body, path: request.path } : undefined;
}

export interface Mismatch {
  group: string;
  caseId: string;
  legacy: Record<string, unknown>;
  gateway: Record<string, unknown>;
}

export function sameFields(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
