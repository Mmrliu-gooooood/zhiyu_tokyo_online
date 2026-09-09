import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), preflight: vi.fn() }));
vi.mock('@/lib/server/agent-runtime/model-connections', () => ({
  parseProModelRef: (ref: unknown) =>
    ref && typeof ref === 'object' && 'id' in ref && 'revision' in ref ? ref : undefined,
  resolveProModelContext: mocks.resolve,
}));
vi.mock('@/lib/server/agent-runtime/model-preflight', () => ({
  preflightProModel: mocks.preflight,
}));
import { validateSessionModelBinding } from '@/lib/server/agent-runtime/session-model-binding';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ modelString: 'openai:gpt-4o', apiKey: 'secret' });
  mocks.preflight.mockResolvedValue({ chatReady: true, generationReady: true });
});
describe('PRO queue preflight', () => {
  const ref = { id: 'connection', revision: 2 };
  it('loads the reference with the authenticated owner and returns only the reference', async () => {
    expect(await validateSessionModelBinding('owner-a', ref)).toEqual(ref);
    expect(mocks.resolve).toHaveBeenCalledWith('owner-a', ref);
  });
  it('resolves the durable session binding when the browser did not replace it', async () => {
    expect(await validateSessionModelBinding('owner-a', undefined, ref)).toEqual(ref);
  });
  it('rejects invalid references before consulting models', async () => {
    await expect(validateSessionModelBinding('owner-a', 'invalid')).rejects.toThrow(
      'PRO_MODEL_CONFIGURATION_REQUIRED',
    );
    expect(mocks.preflight).not.toHaveBeenCalled();
  });
  it('does not fall back after an owner mismatch or revocation', async () => {
    mocks.resolve.mockRejectedValue(new Error('PRO_MODEL_NOT_FOUND'));
    await expect(validateSessionModelBinding('owner-b', ref)).rejects.toThrow(
      'PRO_MODEL_NOT_FOUND',
    );
    expect(mocks.preflight).not.toHaveBeenCalled();
  });
  it('rejects a chat-only connection before accepting a course request', async () => {
    mocks.preflight.mockResolvedValue({ chatReady: true, generationReady: false });
    await expect(validateSessionModelBinding('owner-a', ref)).rejects.toThrow(
      'PRO_MODEL_CONFIGURATION_REQUIRED',
    );
  });
  it('keeps explicit server routes available for an unbound old session', async () => {
    expect(await validateSessionModelBinding('owner-a', undefined)).toBeUndefined();
    expect(mocks.preflight).toHaveBeenCalledWith(undefined);
  });
});
