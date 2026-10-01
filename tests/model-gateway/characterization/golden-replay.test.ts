/**
 * P2-5 (part 2): replay every P0-3 golden case through the real path
 * "selection → resolveBinding → gateway → fake server" and compare the
 * semantic request fields with the legacy payload. This is the main evidence
 * for the provider (3.6) and thinking (3.7) mappings.
 *
 * Every difference must be explained in golden-allowlist.json (which fields,
 * which cases, why); stale entries fail. Set GOLDEN_REPLAY_REPORT=<file> to
 * dump all mismatches.
 *
 * Bindings are rerouted to the fake server with the original host recorded,
 * so official, operator and user endpoints are all exercised offline.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const operator = vi.hoisted(() => ({ providers: new Set<string>(), key: '' }));

vi.mock('@/lib/server/provider-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/provider-config')>();
  return {
    ...actual,
    isServerConfiguredProvider: (_section: string, id: string) => operator.providers.has(id),
    resolveApiKey: (id: string) => (operator.providers.has(id) ? operator.key : ''),
    resolveBaseUrl: () => undefined,
    resolveProxy: () => undefined,
  };
});

import { createBinding, getCredentialHandle } from '@/lib/model-gateway/credentials/handles';
import { FETCHLESS_APIS } from '@/lib/model-gateway/runtime/fetchless';
import { toPiToolSchema } from '@/lib/model-gateway/runtime/pi-registry';
import { assistantText, toolResult, userContent, userText } from '@/lib/model-gateway/messages';
import {
  getBindingResolutionError,
  resolveBinding,
} from '@/lib/model-gateway/selection/resolve-binding';
import { upgradeLegacyModelParams } from '@/lib/model-gateway/selection/schema';
import {
  startFakeModelServer,
  type FakeModelServer,
} from '@/lib/model-gateway/testing/fake-openai-server';
import type { GatewayMessage, GatewayTool, ModelBinding } from '@/lib/model-gateway/types';
import { testGateway } from '../helpers';
import type { Conversation, GoldenEntry, LegacyCaseInput } from './legacy-payloads.test';
import { sortKeys } from './matrix';
import { GOLDEN_DIR, thinkingFields } from './thinking-equivalence';

const ALLOWLIST_FILE = path.join(__dirname, 'golden-allowlist.json');
const REPORT = process.env.GOLDEN_REPLAY_REPORT;
const SYSTEM = 'You are a characterization test.';
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TOOLS: GatewayTool[] = [
  {
    name: 'lookup',
    description: 'Look up a fact.',
    parameters: toPiToolSchema({
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look up' } },
      required: ['query'],
      additionalProperties: false,
    }),
  },
];

// ---------------------------------------------------------------------------
// Semantic projection of one request
// ---------------------------------------------------------------------------

type Record_ = Record<string, unknown>;

function authScheme(headers: Record<string, string>): string {
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  if (names.includes('x-goog-api-key')) return 'x-goog-api-key';
  if (names.includes('api-key')) return 'api-key';
  if (names.includes('x-api-key')) return 'x-api-key';
  if (/^bearer /i.test(lower.authorization ?? '')) return 'bearer';
  if (names.includes('authorization')) return 'authorization';
  return 'none';
}

function roles(body: Record_): string[] | undefined {
  const list = (body.messages ?? body.input ?? body.contents) as Record_[] | undefined;
  if (!Array.isArray(list)) return undefined;
  return list.map((item) => String(item.role ?? item.type ?? '?'));
}

/** What a replayed assistant turn carried besides text (reasoning, tool calls). */
function replayShape(body: Record_): string[] {
  const out = new Set<string>();
  const list = (body.messages ?? body.input ?? body.contents) as Record_[] | undefined;
  for (const item of Array.isArray(list) ? list : []) {
    const role = item.role ?? item.type;
    if (role !== 'assistant' && role !== 'model' && item.type !== 'reasoning') continue;
    if (item.type === 'reasoning') out.add('reasoning-item');
    for (const key of ['reasoning_content', 'reasoning', 'tool_calls']) {
      if (item[key] !== undefined && item[key] !== null && item[key] !== '') out.add(key);
    }
    const content = Array.isArray(item.content)
      ? (item.content as Record_[])
      : Array.isArray(item.parts)
        ? (item.parts as Record_[])
        : [];
    for (const part of content) {
      if (part.type === 'thinking' || part.type === 'reasoning' || part.thought === true) {
        out.add('thinking-block');
      }
      if (part.type === 'tool_use' || part.functionCall || part.toolUse) out.add('tool-call');
    }
  }
  return [...out].sort();
}

function imageCount(body: Record_): number {
  return (JSON.stringify(body).match(/iVBORw0KGgo/g) ?? []).length;
}

function maxTokens(body: Record_): string | undefined {
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    if (body[key] !== undefined) return `${key}=${String(body[key])}`;
  }
  const generation = body.generationConfig as Record_ | undefined;
  if (generation?.maxOutputTokens !== undefined) {
    return `maxOutputTokens=${String(generation.maxOutputTokens)}`;
  }
  const inference = body.inferenceConfig as Record_ | undefined;
  if (inference?.maxTokens !== undefined) return `maxTokens=${String(inference.maxTokens)}`;
  return undefined;
}

/**
 * Gemini thinking config. Level enums are case-insensitive on the wire, and
 * pi always asks for thought summaries (`includeThoughts`) when thinking is
 * on so the UI can show them; neither changes what the model does.
 */
function googleThinking(body: Record_): Record_ {
  const generation = body.generationConfig as Record_ | undefined;
  const thinking = generation?.thinkingConfig as Record_ | undefined;
  if (!thinking) return {};
  const { includeThoughts: _include, thinkingLevel, ...rest } = thinking;
  return {
    googleThinking: sortKeys({
      ...rest,
      ...(typeof thinkingLevel === 'string' ? { thinkingLevel: thinkingLevel.toLowerCase() } : {}),
    }),
  };
}

function bedrockThinking(body: Record_): Record_ {
  const extra = body.additionalModelRequestFields as Record_ | undefined;
  return extra ? { bedrockFields: sortKeys(extra) } : {};
}

function toolNames(body: Record_): string[] | undefined {
  const tools = body.tools as Record_[] | undefined;
  const config = (body.toolConfig as Record_ | undefined)?.tools as Record_[] | undefined;
  const list = tools ?? config;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list
    .flatMap((tool) => {
      const declarations = tool.functionDeclarations as Record_[] | undefined;
      if (declarations) return declarations.map((entry) => String(entry.name));
      const fn = (tool.function ?? tool.toolSpec ?? tool) as Record_;
      return [String(fn.name)];
    })
    .sort();
}

export function semantic(request: {
  host: string;
  path: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
  body: unknown;
}): Record_ {
  const body = (request.body ?? {}) as Record_;
  const out: Record_ = {
    host: request.host,
    path: request.path,
    auth: authScheme(request.headers),
    ...thinkingFields(body, request.path),
    ...googleThinking(body),
    ...bedrockThinking(body),
  };
  // Claude 5: the effective effort is the last mid-conversation control entry.
  const list = Array.isArray(body.messages) ? (body.messages as Record_[]) : [];
  const control = [...list]
    .reverse()
    .find(
      (message) =>
        message.role === 'system' && Array.isArray(message.content) && message.output_config,
    );
  if (control) {
    out.effort = (control.output_config as Record_).effort;
    out.effortControl = 'mid-conversation';
  }
  const tokens = maxTokens(body);
  if (tokens) out.maxTokens = tokens;
  const tools = toolNames(body);
  if (tools) out.tools = tools;
  if (body.tool_choice !== undefined) out.toolChoice = JSON.stringify(body.tool_choice);
  if (body.stream_options !== undefined) out.streamUsage = true;
  const messageRoles = roles(body);
  if (messageRoles) out.roles = messageRoles;
  const replay = replayShape(body);
  if (replay.length > 0) out.replay = replay;
  const images = imageCount(body);
  if (images > 0) out.images = images;
  if (request.query && Object.keys(request.query).length > 0) out.query = sortKeys(request.query);
  return out;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function conversation(kind: Conversation, binding: ModelBinding): GatewayMessage[] {
  const origin = {
    api: binding.model.api,
    provider: binding.model.provider,
    model: binding.model.id,
  };
  // A turn pi produced from an OpenAI-compatible stream records the field the
  // reasoning arrived in, so it can be replayed there.
  const thinking = (text: string) => ({
    type: 'thinking' as const,
    thinking: text,
    ...(binding.model.api === 'openai-completions'
      ? { thinkingSignature: 'reasoning_content' }
      : {}),
  });
  switch (kind) {
    case 'single':
      return [userText('Hello', 1)];
    case 'image':
      return [userContent('Describe the image.', [PNG_1X1], 1)];
    case 'reasoning-replay': {
      const answer = assistantText('4', origin, 2);
      answer.content.unshift(thinking('Add the two numbers.'));
      return [userText('What is 2+2?', 1), answer, userText('And 3+3?', 3)];
    }
    case 'tool-replay': {
      const call = {
        type: 'toolCall' as const,
        id: 'call_1',
        name: 'lookup',
        arguments: { query: 'X' },
      };
      const turn = assistantText('', { ...origin, toolCalls: [call] }, 2);
      turn.content.unshift(thinking('I need the lookup tool.'));
      return [
        userText('Look up X.', 1),
        turn,
        toolResult(call, JSON.stringify({ answer: '42' }), { timestamp: 3 }),
        userText('Summarize.', 4),
      ];
    }
  }
}

/** Point a binding at the fake server, keeping the path and remembering the host. */
function reroute(binding: ModelBinding, origin: string): { binding: ModelBinding; host: string } {
  const real = new URL(binding.model.baseUrl);
  const { fingerprint: _f, credentialReady: _r, ...fields } = binding;
  const pathname = real.pathname.replace(/\/+$/, '');
  // The AWS SDK speaks HTTP/2 by default; the fake server is HTTP/1.1.
  const requestEnv =
    binding.model.api === 'bedrock-converse-stream'
      ? { ...binding.requestEnv, AWS_BEDROCK_FORCE_HTTP1: '1' }
      : binding.requestEnv;
  return {
    host: real.host,
    binding: createBinding(
      {
        ...fields,
        model: { ...binding.model, baseUrl: `${origin}${pathname}` },
        // Fetch-less SDK transports may only reach official / operator endpoints;
        // the fake server stands in for an operator-configured one.
        ...(FETCHLESS_APIS.has(binding.model.api) ? { endpoint: 'operator' as const } : {}),
        ...(requestEnv ? { requestEnv } : {}),
      },
      getCredentialHandle(binding),
    ),
  };
}

async function replay(
  server: FakeModelServer,
  group: string,
  input: LegacyCaseInput,
): Promise<Record_> {
  const operatorManaged = group === 'bedrock';
  operator.providers = new Set(operatorManaged ? [input.providerId] : []);
  operator.key = input.apiKey;
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(input.env ?? {})) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    let binding: ModelBinding;
    try {
      const selection = upgradeLegacyModelParams({
        modelString: `${input.providerId}:${input.modelId}`,
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        providerType: input.providerType,
        api: input.api,
        source: operatorManaged ? undefined : 'user',
        thinkingConfig: input.thinking,
      });
      binding = await resolveBinding({ selection });
    } catch (error) {
      const known = getBindingResolutionError(error);
      return { error: known ? known.code : `throw: ${(error as Error).message}` };
    }
    const rerouted = reroute(binding, server.origin);
    const before = server.requests.length;
    const { gateway } = testGateway();
    await gateway
      .complete(
        rerouted.binding,
        {
          system: SYSTEM,
          messages: conversation(input.conversation, rerouted.binding),
          ...(input.tools ? { tools: TOOLS, toolChoice: 'auto' as const } : {}),
          maxOutputTokens: input.maxOutputTokens ?? 'omit',
        },
        { source: 'golden-replay', retry: 'none' },
      )
      .catch(() => undefined);
    const request = server.requests[before];
    if (!request) return { error: 'no request was sent' };
    return semantic({
      host: rerouted.host,
      path: request.path,
      headers: request.headers,
      query: request.query,
      body: request.body ?? request.rawBody,
    });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function legacySemantic(entry: GoldenEntry): Record_ {
  const request = entry.request;
  if ('error' in request) return { error: 'legacy: ' + request.error };
  return semantic(request);
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

interface AllowEntry {
  /** Golden group, or "*" for every group. */
  group: string;
  /** Exact case id, or a regular expression when it starts with `^`. */
  case: string;
  /** Fields that may differ ("*" = the whole request). */
  fields: string[];
  reason: string;
}

interface Mismatch {
  group: string;
  caseId: string;
  fields: string[];
  legacy: Record_;
  gateway: Record_;
}

function differingFields(a: Record_, b: Record_): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys]
    .filter((key) => JSON.stringify(sortKeys(a[key])) !== JSON.stringify(sortKeys(b[key])))
    .sort();
}

const groups = readdirSync(GOLDEN_DIR)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .sort();

let server: FakeModelServer;
beforeAll(async () => {
  process.env.ALLOW_LOCAL_NETWORKS = 'true';
  server = await startFakeModelServer();
});
afterAll(async () => {
  delete process.env.ALLOW_LOCAL_NETWORKS;
  await server?.close();
});

describe('golden replay through bindings (P2-5)', () => {
  it(
    'matches the legacy request semantics or an allowlisted difference',
    { timeout: 600_000 },
    async () => {
      const mismatches: Mismatch[] = [];
      let total = 0;
      for (const group of groups) {
        const golden = (
          JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${group}.json`), 'utf8')) as {
            cases: Record<string, GoldenEntry>;
          }
        ).cases;
        for (const [caseId, entry] of Object.entries(golden)) {
          total += 1;
          const legacy = legacySemantic(entry);
          const current = await replay(server, group, entry.input);
          const fields = differingFields(legacy, current);
          if (fields.length > 0) {
            mismatches.push({ group, caseId, fields, legacy, gateway: current });
          }
        }
      }
      expect(total).toBeGreaterThan(1500);
      if (REPORT) writeFileSync(REPORT, JSON.stringify(mismatches, null, 2));

      const allow = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8')) as AllowEntry[];
      const applies = (entry: AllowEntry, mismatch: Mismatch) =>
        (entry.group === '*' || entry.group === mismatch.group) &&
        (entry.case.startsWith('^')
          ? new RegExp(entry.case).test(mismatch.caseId)
          : entry.case === mismatch.caseId);
      const used = new Set<AllowEntry>();
      const unexplained = mismatches.filter((mismatch) => {
        const entries = allow.filter((entry) => applies(entry, mismatch));
        const covered = new Set(entries.flatMap((entry) => entry.fields));
        const ok = covered.has('*') || mismatch.fields.every((field) => covered.has(field));
        if (ok) {
          for (const entry of entries) {
            if (
              entry.fields.includes('*') ||
              entry.fields.some((f) => mismatch.fields.includes(f))
            ) {
              used.add(entry);
            }
          }
        }
        return !ok;
      });
      const stale = allow.filter((entry) => !used.has(entry));
      expect(
        unexplained.map(({ group, caseId, fields }) => `${group} ${caseId}: ${fields.join(',')}`),
      ).toEqual([]);
      expect(stale).toEqual([]);
    },
  );
});
