import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/lib/utils/model-config', () => ({ refreshPlatformModelConfig: refresh }));
import {
  syncProModelConnection,
  revokeProModelConnection,
} from '@/lib/workbench/pro-model-connection-client';

const config = { modelString: 'openai:gpt-4o', apiKey: 'private-key' };
const ref = { id: 'connection-a', revision: 1 };
let saved: Map<string, string>;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  refresh.mockReset();
  saved = new Map();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => saved.get(key) || null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    },
  });
  request = vi.fn();
  vi.stubGlobal('fetch', request);
});
afterEach(() => vi.unstubAllGlobals());

describe('Home connection synchronization', () => {
  it('stores only the public ref and sends the current configuration directly to its owner API', async () => {
    request.mockResolvedValue(Response.json({ ref }));
    expect(await syncProModelConnection(config)).toEqual(ref);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
      selection: {
        source: 'legacy-managed',
        providerId: 'openai',
        modelId: 'gpt-4o',
        connection: { auth: 'api-key', apiKey: 'private-key' },
      },
    });
    expect([...saved.values()].join()).not.toContain('private-key');
  });
  it('sends a platform connection as a stable reference without local provider details', async () => {
    request.mockResolvedValue(Response.json({ ref }));
    await syncProModelConnection({
      source: 'platform',
      defaultId: 'zhiyu-default-text',
      revision: 'text-r1',
      modelString: 'deepseek:must-not-leak-model',
      apiKey: 'must-not-leak-key',
      baseUrl: 'https://must-not-leak.example.com',
      thinkingConfig: { mode: 'disabled', effort: 'none' },
    });
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
      selection: {
        source: 'platform',
        defaultId: 'zhiyu-default-text',
        revision: 'text-r1',
        thinking: { mode: 'disabled', effort: 'none' },
      },
    });
  });
  it('recovers a stale ref once by syncing the current Home config as a new connection', async () => {
    saved.set('openmaic:pro-model-ref', JSON.stringify(ref));
    request.mockResolvedValueOnce(
      Response.json({ error: 'PRO_MODEL_CONNECTION_UNAVAILABLE' }, { status: 409 }),
    );
    request.mockResolvedValueOnce(Response.json({ ref: { ...ref, id: 'connection-b' } }));
    await syncProModelConnection(config);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.calls[0][1].body).ref).toEqual(ref);
    expect(JSON.parse(request.mock.calls[1][1].body).ref).toBeUndefined();
  });
  it('refreshes an obsolete platform catalog once without clearing the connection reference', async () => {
    const platform = {
      source: 'platform' as const,
      defaultId: 'zhiyu-default-text' as const,
      revision: 'old',
    };
    saved.set('openmaic:pro-model-ref', JSON.stringify(ref));
    refresh.mockResolvedValue({ ...platform, revision: 'new' });
    request.mockResolvedValueOnce(
      Response.json({ error: 'PRO_MODEL_CONNECTION_STALE' }, { status: 409 }),
    );
    request.mockResolvedValueOnce(Response.json({ ref }));

    await expect(syncProModelConnection(platform)).resolves.toEqual(ref);

    expect(refresh).toHaveBeenCalledExactlyOnceWith(platform);
    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({
      selection: { revision: 'new' },
      ref,
    });
  });
  it('does not retry a platform connection conflict when the catalog has not changed', async () => {
    const platform = {
      source: 'platform' as const,
      defaultId: 'zhiyu-default-text' as const,
      revision: 'current',
    };
    saved.set('openmaic:pro-model-ref', JSON.stringify(ref));
    refresh.mockResolvedValue(undefined);
    request.mockResolvedValue(
      Response.json({ error: 'PRO_MODEL_CONNECTION_STALE' }, { status: 409 }),
    );

    await expect(syncProModelConnection(platform)).rejects.toThrow('模型配置版本已更新');

    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(saved.get('openmaic:pro-model-ref')!)).toEqual(ref);
  });
  it('does not echo an arbitrary upstream body or retry an authentication failure', async () => {
    request.mockResolvedValue(
      Response.json({ error: 'provider echoed private-key' }, { status: 401 }),
    );
    await expect(syncProModelConnection(config)).rejects.not.toThrow('private-key');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['INVALID_GENERATION_SESSION', 401, '会话验证已失效'],
    ['GENERATION_SESSION_REQUIRED', 401, '会话验证已失效'],
    ['PRO_MODEL_CONNECTION_STALE', 409, '模型配置版本已更新'],
    ['PRO_MODEL_DATABASE_UNAVAILABLE', 503, '服务暂时不可用'],
    ['PRO_MODEL_CONNECTION_UNAVAILABLE', 503, '服务暂时不可用'],
  ])(
    'shows actionable %s errors without replacing the cached reference',
    async (code, status, hint) => {
      saved.set('openmaic:pro-model-ref', JSON.stringify(ref));
      request.mockResolvedValue(Response.json({ error: code }, { status }));

      await expect(syncProModelConnection(config)).rejects.toThrow(hint);

      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.parse(saved.get('openmaic:pro-model-ref')!)).toEqual(ref);
    },
  );
  it('blocks new sends until a failed settings revocation has succeeded', async () => {
    request.mockResolvedValue(Response.json({}, { status: 503 }));
    await expect(revokeProModelConnection()).rejects.toThrow();
    expect(saved.get('openmaic:pro-model-revoke-pending')).toBe('1');
    await expect(syncProModelConnection(config)).rejects.toThrow();
    expect(request.mock.calls.every((call) => call[1].method === 'DELETE')).toBe(true);
    request.mockResolvedValueOnce(Response.json({ revoked: true }));
    request.mockResolvedValueOnce(Response.json({ ref }));
    await expect(syncProModelConnection(config)).resolves.toEqual(ref);
    expect(saved.has('openmaic:pro-model-revoke-pending')).toBe(false);
  });
});
