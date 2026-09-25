import { afterEach, describe, expect, it, vi } from 'vitest';

import { decideDocumentAccess, parseDocumentAction } from '@/lib/persistence/document-access';

describe('document access', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses document reads without treating media extensions as public', () => {
    expect(parseDocumentAction('GET', '/documents/stage-1')).toEqual({
      kind: 'read',
      stageId: 'stage-1',
    });
  });

  it('hides foreign stages when hosted auth is on', async () => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    const access = await decideDocumentAccess(
      { kind: 'read', stageId: 'stage-1' },
      'user:11111111-1111-4111-8111-111111111111',
      async () => ({
        stageId: 'stage-1',
        ownerId: 'user:22222222-2222-4222-8222-222222222222',
        isPublic: false,
        publishedAt: null,
        generationComplete: false,
        deletedAt: null,
      }),
      async () => true,
    );
    expect(access).toBe('not-found');
  });

  it('hides foreign stages for a user: owner even when AUTH_MODE is unset', async () => {
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    const access = await decideDocumentAccess(
      { kind: 'read', stageId: 'stage-1' },
      'user:11111111-1111-4111-8111-111111111111',
      async () => ({
        stageId: 'stage-1',
        ownerId: 'user:22222222-2222-4222-8222-222222222222',
        isPublic: false,
        publishedAt: null,
        generationComplete: false,
        deletedAt: null,
      }),
      async () => true,
    );
    expect(access).toBe('not-found');
  });

  it('still allows anonymous owners to read unmatched stages in legacy mode', async () => {
    vi.stubEnv('AUTH_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    const access = await decideDocumentAccess(
      { kind: 'read', stageId: 'stage-1' },
      'anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      async () => ({
        stageId: 'stage-1',
        ownerId: 'anon:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        isPublic: false,
        publishedAt: null,
        generationComplete: false,
        deletedAt: null,
      }),
      async () => true,
    );
    expect(access).toBe('allow');
  });

  it('still allows a matching hosted owner to read', async () => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'supabase');
    const ownerId = 'user:11111111-1111-4111-8111-111111111111';
    const access = await decideDocumentAccess(
      { kind: 'read', stageId: 'stage-1' },
      ownerId,
      async () => ({
        stageId: 'stage-1',
        ownerId,
        isPublic: false,
        publishedAt: null,
        generationComplete: false,
        deletedAt: null,
      }),
      async () => true,
    );
    expect(access).toBe('allow');
  });
});
