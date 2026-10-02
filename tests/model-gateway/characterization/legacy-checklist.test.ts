/**
 * Gateway-era coverage for behavior-checklist items (README.md) whose legacy
 * source tests are deleted in P3-6: request shaping not covered by the golden
 * replay, stream parsing through pi's native reasoning fields, and usage
 * attribution.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveParamsBinding, userText } from '@/lib/model-gateway';
import { planThinking } from '@/lib/model-gateway/runtime/thinking';
import {
  startFakeModelServer,
  type FakeModelServer,
} from '@/lib/model-gateway/testing/fake-openai-server';
import { bindingFor, testGateway } from '../helpers';

let server: FakeModelServer;
beforeAll(async () => {
  server = await startFakeModelServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => server.reset());

const request = { messages: [userText('Hello', 0)] };

describe('request shaping (RQ)', () => {
  it('RQ-06: Azure portal endpoint forms normalize to one resource base; the deployment is the model', async () => {
    const bases = await Promise.all(
      [
        'https://example.openai.azure.com',
        'https://example.openai.azure.com/openai',
        'https://example.openai.azure.com/openai/v1/chat/completions?api-version=v1',
        'https://example.openai.azure.com/openai/deployments/course-generation/chat/completions',
      ].map(async (baseUrl) => {
        const binding = await resolveParamsBinding({
          source: 'user',
          modelString: 'azure:course-generation',
          apiKey: 'azure-key',
          baseUrl,
        });
        expect(binding.model.id).toBe('course-generation');
        return binding.model.baseUrl;
      }),
    );
    expect(new Set(bases)).toEqual(new Set(['https://example.openai.azure.com/openai/v1']));

    const foundry = await resolveParamsBinding({
      source: 'user',
      modelString: 'azure:course-generation',
      apiKey: 'azure-key',
      baseUrl: 'https://fast-ai-resource.services.ai.azure.com/openai/v1/chat/completions',
    });
    expect(foundry.model.baseUrl).toBe('https://fast-ai-resource.services.ai.azure.com/openai/v1');
  });

  it('RQ-11: the GPT-5.6 Sol alias resolves through the canonical entry and keeps max effort', async () => {
    const binding = await resolveParamsBinding({
      source: 'user',
      modelString: 'openai:gpt-5.6-sol',
      apiKey: 'k',
      thinkingConfig: { mode: 'enabled', effort: 'max' },
    });
    expect(binding.capabilities.knownModel).toBe(true);
    expect(binding.model.api).toBe('openai-responses');
    expect(planThinking(binding).reasoning).toBe('max');
  });

  it('RQ-18: Bedrock is operator-only — user selections are refused before any request', async () => {
    await expect(
      resolveParamsBinding({
        source: 'user',
        modelString: 'bedrock:anthropic.claude-sonnet-4-5',
        apiKey: 'bearer',
      }),
    ).rejects.toMatchObject({ name: 'GatewayError', code: 'MODEL_CONFIGURATION' });
  });
});

describe('stream parsing (RS)', () => {
  it('RS-01/03/04: reasoning_content deltas become reasoning, separate from clean text', async () => {
    server.setHandler(() => ({
      kind: 'auto',
      reasoning: 'thinking it over',
      text: 'final answer',
      textChunks: 4,
    }));
    const harness = testGateway();
    const binding = await bindingFor('deepseek', 'deepseek-flash', server.origin);
    const result = await harness.gateway.complete(binding, request, { source: 'test' });
    expect(result.reasoningText).toBe('thinking it over');
    expect(result.text).toBe('final answer');
    expect(result.message.content.map((block) => block.type)).toEqual(['thinking', 'text']);
  });

  it('RS-02: SSE framing split across reads still yields the whole text', async () => {
    server.setHandler(() => ({ kind: 'auto', text: 'a fairly long answer', textChunks: 12 }));
    const harness = testGateway();
    const binding = await bindingFor('deepseek', 'deepseek-flash', server.origin);
    const result = await harness.gateway.complete(binding, request, { source: 'test' });
    expect(result.text).toBe('a fairly long answer');
  });

  it('RS-05: an error frame inside a 200 stream surfaces as a classified error', async () => {
    server.setHandler(() => ({
      kind: 'raw',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'data: {"error":{"message":"overloaded","type":"server_error","code":500}}\n\n',
    }));
    const harness = testGateway();
    const binding = await bindingFor('deepseek', 'deepseek-flash', server.origin);
    await expect(
      harness.gateway.complete(binding, request, { source: 'test', retry: 'none' }),
    ).rejects.toMatchObject({ name: 'GatewayError' });
  });
});

describe('usage attribution (US)', () => {
  it('US-01: usage is recorded under the canonical model id', async () => {
    server.setHandler(() => ({ kind: 'auto', text: 'ok', usage: { input: 3, output: 2 } }));
    const harness = testGateway();
    const base = await bindingFor('deepseek', 'deepseek-flash', server.origin);
    const { createBinding, getCredentialHandle } =
      await import('@/lib/model-gateway/credentials/handles');
    const { fingerprint: _f, credentialReady: _r, ...fields } = base;
    const aliased = createBinding(
      {
        ...fields,
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        modelString: 'openai:gpt-5.6-sol',
      },
      getCredentialHandle(base),
    );
    await harness.gateway.complete(aliased, request, { source: 'test' });
    expect(harness.usage).toEqual([
      expect.objectContaining({
        providerId: 'openai',
        modelId: 'gpt-5.6',
        modelString: 'openai:gpt-5.6',
      }),
    ]);
  });

  it('US-02: usage is attributed to the application provider id, not the pi provider', async () => {
    server.setHandler(() => ({ kind: 'auto', text: 'ok' }));
    const harness = testGateway();
    const binding = await bindingFor('deepseek', 'deepseek-flash', server.origin, {
      providerId: 'atlascloud',
      modelString: 'atlascloud:deepseek-flash',
    });
    await harness.gateway.complete(binding, request, { source: 'test' });
    expect(harness.usage[0]).toMatchObject({ providerId: 'atlascloud' });
  });
});
