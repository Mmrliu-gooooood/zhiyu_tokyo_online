/**
 * Classmate answer-model policy (learning plan B05): a custom choice is
 * checked every time it is used (ownership, availability, credential
 * readiness, tool support) and never falls back to another model; the
 * classroom chat routes give a usable classmate its own binding and leave an
 * unusable one out with a notice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vaultGet = vi.fn();
vi.mock('@/lib/model-gateway/credentials/vault', () => ({
  CredentialVault: class {
    get = vaultGet;
    list = vi.fn(async () => []);
  },
}));
vi.mock('@/lib/model-gateway/credentials/vault-auth', () => ({
  defaultCredentialDatabase: vi.fn(async () => ({})),
}));
const platformAvailable = { value: true };
const serverProviders = new Set<string>(['deepseek']);
vi.mock('@/lib/server/provider-config', () => {
  class PlatformDefaultModelError extends Error {}
  return {
    PlatformDefaultModelError,
    getPlatformDefaultCatalog: () => ({
      version: 2,
      entries: [
        {
          defaultId: 'zhiyu-default-text',
          capability: 'text',
          displayName: 'DeepSeek Flash',
          available: platformAvailable.value,
        },
      ],
    }),
    getServerProviders: () => ({ deepseek: { models: ['deepseek-chat'] } }),
    isPlatformDefaultBackingProvider: () => false,
    isServerConfiguredProvider: (_section: string, providerId: string) =>
      serverProviders.has(providerId),
    resolvePlatformDefault: () => {
      if (!platformAvailable.value) throw new PlatformDefaultModelError('off');
      return { defaultId: 'zhiyu-default-text' };
    },
  };
});

import type { ModelBinding } from '@/lib/model-gateway';
import {
  resolveClassmateModelChoice,
  resolveClassmateModelPolicy,
} from '@/lib/server/study/companion/model-policy';
import {
  resolveClassroomClassmateModels,
  type ClassroomModelDeps,
} from '@/lib/server/study/companion/classroom-models';
import { StudyError } from '@/lib/server/study/spaces/repository';
import type { ClassmateModelPolicy } from '@/lib/study/classmates/contracts';
import type { StatelessChatRequest } from '@/lib/types/chat';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CREDENTIAL = '11111111-1111-4111-8111-111111111111';

const binding = (overrides: Partial<ModelBinding> = {}): ModelBinding =>
  ({
    modelString: 'openrouter:deepseek/deepseek-chat',
    credentialReady: true,
    capabilities: { tools: true },
    ...overrides,
  }) as unknown as ModelBinding;

async function reason(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof StudyError ? error.details?.reason : error;
  }
}

beforeEach(() => {
  vaultGet.mockReset();
  platformAvailable.value = true;
});

describe('resolveClassmateModelChoice', () => {
  const credential = {
    kind: 'credential' as const,
    credentialId: CREDENTIAL,
    providerId: 'openrouter',
    modelId: 'deepseek/deepseek-chat',
  };

  it('accepts an active account of the owner and the matching provider', async () => {
    vaultGet.mockResolvedValue({ status: 'active', providerId: 'openrouter' });
    const resolve = vi.fn(async () => binding());
    await expect(
      resolveClassmateModelChoice(OWNER, credential, 'study-companion', {}, { resolve }),
    ).resolves.toMatchObject({ credentialReady: true });
    expect(resolve).toHaveBeenCalledWith({
      selection: {
        source: 'user',
        providerId: 'openrouter',
        modelId: 'deepseek/deepseek-chat',
        connection: { auth: 'credential', credentialId: CREDENTIAL },
      },
      stage: 'study-companion',
      ownerId: OWNER,
    });
  });

  it('refuses a missing, signed-out or mismatched account without trying another model', async () => {
    const resolve = vi.fn(async () => binding());
    vaultGet.mockResolvedValue(undefined);
    expect(
      await reason(resolveClassmateModelChoice(OWNER, credential, 'chat-adapter', {}, { resolve })),
    ).toBe('credential_missing');
    vaultGet.mockResolvedValue({ status: 'reauth_required', providerId: 'openrouter' });
    expect(
      await reason(resolveClassmateModelChoice(OWNER, credential, 'chat-adapter', {}, { resolve })),
    ).toBe('credential_reauth_required');
    vaultGet.mockResolvedValue({ status: 'active', providerId: 'openai' });
    expect(
      await reason(resolveClassmateModelChoice(OWNER, credential, 'chat-adapter', {}, { resolve })),
    ).toBe('credential_provider_mismatch');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('checks platform defaults and server providers are still served', async () => {
    const resolve = vi.fn(async () => binding());
    platformAvailable.value = false;
    expect(
      await reason(
        resolveClassmateModelChoice(
          OWNER,
          { kind: 'platform', defaultId: 'zhiyu-default-text' },
          'chat-adapter',
          {},
          { resolve },
        ),
      ),
    ).toBe('platform_unavailable');
    expect(
      await reason(
        resolveClassmateModelChoice(
          OWNER,
          { kind: 'server', providerId: 'gone', modelId: 'x' },
          'chat-adapter',
          {},
          { resolve },
        ),
      ),
    ).toBe('server_provider_unavailable');
  });

  it('requires a ready credential and, for chats, tool support', async () => {
    const choice = { kind: 'server' as const, providerId: 'deepseek', modelId: 'deepseek-chat' };
    expect(
      await reason(
        resolveClassmateModelChoice(
          OWNER,
          choice,
          'chat-adapter',
          {},
          {
            resolve: async () => binding({ credentialReady: false }),
          },
        ),
      ),
    ).toBe('credential_not_ready');
    expect(
      await reason(
        resolveClassmateModelChoice(
          OWNER,
          choice,
          'study-companion',
          { requireTools: true },
          {
            resolve: async () => binding({ capabilities: { tools: false } } as never),
          },
        ),
      ),
    ).toBe('tools_unsupported');
  });

  it('inherit resolves to no binding of its own', async () => {
    await expect(
      resolveClassmateModelPolicy(OWNER, { mode: 'inherit' }, 'chat-adapter'),
    ).resolves.toBeUndefined();
  });
});

describe('classroom classmate models', () => {
  const body = (agentIds: string[]): StatelessChatRequest =>
    ({
      messages: [],
      storeState: {},
      config: {
        agentIds,
        addressedAgentId: agentIds.at(-1),
        agentConfigs: agentIds.map((id) => ({ id, name: id === 'default-1' ? '老师' : '小林' })),
      },
    }) as unknown as StatelessChatRequest;

  const deps = (
    policies: Record<string, ClassmateModelPolicy>,
    resolveChoice: ClassroomModelDeps['resolveChoice'],
  ): ClassroomModelDeps => ({
    enabled: () => true,
    resolveOwnerId: async () => OWNER,
    readPolicies: async () => new Map(Object.entries(policies)),
    resolveChoice,
  });

  const custom: ClassmateModelPolicy = {
    mode: 'custom',
    model: { kind: 'server', providerId: 'deepseek', modelId: 'deepseek-chat' },
  };

  it('binds a classmate with a usable own model and leaves inherit alone', async () => {
    const request = body(['default-1', 'cm-0123456789abcdef-r2', 'cm-fedcba9876543210-r1']);
    const result = await resolveClassroomClassmateModels(
      new Request('http://x'),
      request,
      deps(
        { 'cm-0123456789abcdef': custom, 'cm-fedcba9876543210': { mode: 'inherit' } },
        // Already carries a thinking setting, so it is used as is.
        async () => binding({ thinking: { mode: 'disabled' } } as never),
      ),
    );
    expect(Object.keys(result.agentBindings)).toEqual(['cm-0123456789abcdef-r2']);
    expect(result.notices).toEqual([]);
    expect(request.config.agentIds).toHaveLength(3);
  });

  it('drops a classmate whose own model is unavailable and says so', async () => {
    const request = body(['default-1', 'cm-0123456789abcdef-r2']);
    const result = await resolveClassroomClassmateModels(
      new Request('http://x'),
      request,
      deps({ 'cm-0123456789abcdef': custom }, async () => {
        throw new StudyError('STUDY_CLASSMATE_MODEL_UNAVAILABLE', { reason: 'credential_missing' });
      }),
    );
    expect(request.config.agentIds).toEqual(['default-1']);
    expect(request.config.addressedAgentId).toBeUndefined();
    expect(result.notices).toEqual([
      {
        type: 'notice',
        data: {
          code: 'CLASSMATE_MODEL_UNAVAILABLE',
          agentId: 'cm-0123456789abcdef-r2',
          agentName: '小林',
        },
      },
    ]);
    expect(result.nothingToRun).toBe(false);
  });

  it('answers nothing when the unavailable classmate was the only agent', async () => {
    const request = body(['cm-0123456789abcdef-r2']);
    const result = await resolveClassroomClassmateModels(
      new Request('http://x'),
      request,
      deps({ 'cm-0123456789abcdef': custom }, async () => {
        throw new StudyError('STUDY_CLASSMATE_MODEL_UNAVAILABLE', { reason: 'x' });
      }),
    );
    expect(result.nothingToRun).toBe(true);
  });

  it('never touches the database without classmate agents or with the feature off', async () => {
    const readPolicies = vi.fn();
    const base = { resolveOwnerId: async () => OWNER, readPolicies, resolveChoice: vi.fn() };
    await resolveClassroomClassmateModels(new Request('http://x'), body(['default-1']), {
      ...base,
      enabled: () => true,
    } as never);
    await resolveClassroomClassmateModels(
      new Request('http://x'),
      body(['cm-0123456789abcdef-r2']),
      { ...base, enabled: () => false } as never,
    );
    expect(readPolicies).not.toHaveBeenCalled();
  });
});
