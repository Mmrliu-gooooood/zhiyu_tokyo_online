import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from '@/tests/helpers/signed-owner-request';

import {
  decideStagePostAccess,
  refuseForeignStagePost,
  stageIdFromStoreState,
  stagePostMeta,
} from '@/lib/auth/stage-owner-gate';

const OWNER_A = 'user:09ee0532-7110-4bd4-ae73-e95f4d5126b0';
const OWNER_B = 'user:fdef1b67-298d-40c9-bc60-d778816ea1c6';
const ANON_A = 'anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANON_B = 'anon:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mocks = vi.hoisted(() => ({
  ownerId: undefined as string | undefined,
  resolveModel: vi.fn(),
}));

function principalFor(ownerId: string) {
  return {
    userId: ownerId.slice('user:'.length),
    ownerId,
    learnerKey: ownerId,
    assetPrincipal: ownerId,
    role: 'user' as const,
    sessionId: '22222222-2222-4222-8222-222222222222',
    email: 'isolation@example.com',
    status: 'active' as const,
  };
}

vi.mock('@/lib/auth/session', () => ({
  tryPrincipal: async () => (mocks.ownerId ? principalFor(mocks.ownerId) : undefined),
  requirePrincipal: async () => {
    throw new Error('requirePrincipal should not run in dual-mode chat tests');
  },
}));

vi.mock('@/lib/model-gateway', async (importOriginal) =>
  (await import('@/tests/helpers/model-gateway-mock')).mockGatewayModule(await importOriginal(), {
    resolveParamsBinding: mocks.resolveModel,
  }),
);

vi.mock('@/lib/orchestration/stateless-generate', () => ({
  statelessGenerate: vi.fn(),
}));

import { POST as postChat } from '@/app/api/chat/route';

function meta(ownerId: string, deletedAt: Date | null = null) {
  return {
    stageId: 'stage-1',
    ownerId,
    isPublic: false,
    publishedAt: null,
    generationComplete: false,
    deletedAt,
  };
}

function chatRequest(stageId: string) {
  return new NextRequest('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      storeState: {
        stage: { id: stageId },
        scenes: [],
        currentSceneId: null,
        mode: 'preview',
        whiteboardOpen: false,
      },
      config: { agentIds: ['default-1'] },
    }),
  });
}

describe('chat/agent stage POST owner gate', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.ownerId = undefined;
    mocks.resolveModel.mockReset();
    mocks.resolveModel.mockResolvedValue({
      modelString: 'openai:gpt-test',
      providerId: 'openai',
      credentialReady: true,
      thinking: { mode: 'disabled' },
    });
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://lzomhnjyymalupgvcato.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    vi.stubEnv('GENERATION_SESSION_SECRET', 'unit-test-signed-owner-secret-32-bytes-long');
    vi.spyOn(stagePostMeta, 'read').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('extracts a stage id from storeState and ignores empty values', () => {
    expect(stageIdFromStoreState({ stage: { id: ' stage-1 ' } })).toBe('stage-1');
    expect(stageIdFromStoreState({ stage: null })).toBeUndefined();
    expect(stageIdFromStoreState({ stage: { id: '  ' } })).toBeUndefined();
  });

  it('hides a foreign user stage and the unsigned library from a signed-in user', () => {
    expect(decideStagePostAccess({ callerOwnerId: OWNER_B, stageOwnerId: OWNER_A })).toBe(
      'not-found',
    );
    expect(decideStagePostAccess({ callerOwnerId: OWNER_B, stageOwnerId: ANON_A })).toBe(
      'not-found',
    );
    expect(decideStagePostAccess({ callerOwnerId: OWNER_A, stageOwnerId: OWNER_A })).toBe('allow');
  });

  it('keeps the unsigned shared library chatable and hides user stages from unsigned traffic', () => {
    expect(decideStagePostAccess({ callerOwnerId: undefined, stageOwnerId: ANON_A })).toBe('allow');
    expect(decideStagePostAccess({ callerOwnerId: ANON_B, stageOwnerId: ANON_A })).toBe('allow');
    expect(decideStagePostAccess({ callerOwnerId: undefined, stageOwnerId: OWNER_A })).toBe(
      'not-found',
    );
    expect(decideStagePostAccess({ callerOwnerId: ANON_A, stageOwnerId: OWNER_A })).toBe(
      'not-found',
    );
  });

  it('requires an existing course to be present when attaching, and hides missing ids from signed-in callers', () => {
    expect(
      decideStagePostAccess({
        callerOwnerId: OWNER_A,
        stageOwnerId: undefined,
        requireExisting: true,
      }),
    ).toBe('not-found');
    expect(
      decideStagePostAccess({
        callerOwnerId: OWNER_A,
        stageOwnerId: undefined,
        requireExisting: false,
      }),
    ).toBe('not-found');
    expect(
      decideStagePostAccess({
        callerOwnerId: ANON_A,
        stageOwnerId: undefined,
        requireExisting: false,
      }),
    ).toBe('allow');
    expect(
      decideStagePostAccess({
        callerOwnerId: OWNER_A,
        stageOwnerId: OWNER_A,
        deleted: true,
        requireExisting: true,
      }),
    ).toBe('not-found');
  });

  it('answers 404 for a signed-in caller posting against a foreign stage', async () => {
    const response = await refuseForeignStagePost(
      new Request('http://localhost:3000/api/chat', { method: 'POST' }),
      'stage-1',
      { ownerId: OWNER_B, readMeta: async () => meta(OWNER_A) },
    );
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe('Not found');
  });

  it('allows unsigned traffic against an anon library stage', async () => {
    const response = await refuseForeignStagePost(
      new Request('http://localhost:3000/api/chat', { method: 'POST' }),
      'stage-1',
      { readMeta: async () => meta(ANON_A) },
    );
    expect(response).toBeNull();
  });

  it('resolves the chat model when the owner posts against their own stage', async () => {
    // Positive control for the "does not call the chat model" cases below.
    mocks.ownerId = OWNER_A;
    vi.mocked(stagePostMeta.read).mockResolvedValue(meta(OWNER_A));
    const response = await postChat(chatRequest('stage-a'));
    expect(response.status).toBe(200);
    expect(mocks.resolveModel).toHaveBeenCalledWith(expect.anything(), 'chat-adapter');
  });

  it('does not call the chat model when B posts against A stage', async () => {
    mocks.ownerId = OWNER_B;
    vi.mocked(stagePostMeta.read).mockResolvedValue(meta(OWNER_A));
    const response = await postChat(chatRequest('stage-a'));
    expect(response.status).toBe(404);
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });

  it('does not call the chat model when B posts against an unsigned library stage', async () => {
    mocks.ownerId = OWNER_B;
    vi.mocked(stagePostMeta.read).mockResolvedValue(meta(ANON_A));
    const response = await postChat(chatRequest('stage-shared'));
    expect(response.status).toBe(404);
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });

  it('answers 404 when hosted RLS hides a foreign stage instead of falling through to 400', async () => {
    mocks.ownerId = OWNER_B;
    vi.mocked(stagePostMeta.read).mockResolvedValue(null);
    const response = await postChat(chatRequest('stage-a'));
    expect(response.status).toBe(404);
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });

  it('answers 404 for a foreign stage id even when the chat body is otherwise incomplete', async () => {
    mocks.ownerId = OWNER_B;
    vi.mocked(stagePostMeta.read).mockResolvedValue(null);
    const response = await postChat(
      new NextRequest('http://localhost:3000/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storeState: { stage: { id: 'stage-a' } } }),
      }),
    );
    expect(response.status).toBe(404);
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });
});
