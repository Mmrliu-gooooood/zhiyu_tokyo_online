import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  syncProModelConnection,
  revokeProModelConnection,
} from '@/lib/workbench/pro-model-connection-client';

const config = { modelString: 'openai:gpt-4o', apiKey: 'private-key' };
const ref = { id: 'connection-a', revision: 1 };
let saved: Map<string, string>;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
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
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual(config);
    expect([...saved.values()].join()).not.toContain('private-key');
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
  it('does not echo an arbitrary upstream body or retry an authentication failure', async () => {
    request.mockResolvedValue(
      Response.json({ error: 'provider echoed private-key' }, { status: 401 }),
    );
    await expect(syncProModelConnection(config)).rejects.not.toThrow('private-key');
    expect(request).toHaveBeenCalledTimes(1);
  });
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
