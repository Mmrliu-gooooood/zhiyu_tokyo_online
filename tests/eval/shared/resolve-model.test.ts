import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const BINDING = {
  modelString: 'resolved:model',
  capabilities: { knownModel: true, maxOutputTokens: 8_192, contextWindow: 128_000 },
};

describe('resolveEvalModel', () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIG_ENV };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIG_ENV;
    vi.restoreAllMocks();
  });

  it('throws a helpful error when env var is unset and no fallback is given', async () => {
    delete process.env.EVAL_FOO_MODEL;
    vi.doMock('@/lib/model-gateway', () => ({ resolveParamsBinding: vi.fn() }));
    const { resolveEvalModel } = await import('@/eval/shared/resolve-model');
    await expect(resolveEvalModel('EVAL_FOO_MODEL')).rejects.toThrow(/EVAL_FOO_MODEL/);
  });

  it('uses the env var when set', async () => {
    process.env.EVAL_FOO_MODEL = 'openai:gpt-4.1';
    const resolveModel = vi.fn().mockResolvedValue(BINDING);
    vi.doMock('@/lib/model-gateway', () => ({ resolveParamsBinding: resolveModel }));
    const { resolveEvalModel } = await import('@/eval/shared/resolve-model');
    await resolveEvalModel('EVAL_FOO_MODEL');
    expect(resolveModel).toHaveBeenCalledWith({ modelString: 'openai:gpt-4.1' });
  });

  it('uses the explicit fallback when env var is unset', async () => {
    delete process.env.EVAL_FOO_MODEL;
    const resolveModel = vi.fn().mockResolvedValue(BINDING);
    vi.doMock('@/lib/model-gateway', () => ({ resolveParamsBinding: resolveModel }));
    const { resolveEvalModel } = await import('@/eval/shared/resolve-model');
    await resolveEvalModel('EVAL_FOO_MODEL', 'google:gemini-2.5-flash');
    expect(resolveModel).toHaveBeenCalledWith({ modelString: 'google:gemini-2.5-flash' });
  });

  it('env var takes precedence over fallback', async () => {
    process.env.EVAL_FOO_MODEL = 'anthropic:claude-haiku-4-5';
    const resolveModel = vi.fn().mockResolvedValue(BINDING);
    vi.doMock('@/lib/model-gateway', () => ({ resolveParamsBinding: resolveModel }));
    const { resolveEvalModel } = await import('@/eval/shared/resolve-model');
    await resolveEvalModel('EVAL_FOO_MODEL', 'google:gemini-2.5-flash');
    expect(resolveModel).toHaveBeenCalledWith({ modelString: 'anthropic:claude-haiku-4-5' });
  });
});
