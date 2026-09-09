import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationInput, GenerationLease } from '@/lib/server/generation-jobs/contracts';
import type { GenerationSearchSnapshotContent } from '@/lib/server/generation-search-snapshots';
import {
  PipelineExecution,
  type CheckpointRepository,
} from '@/lib/server/generation-pipeline/execution';
import { GenerationServices } from '@/lib/server/generation-pipeline/services';
import { resolveGenerationSearchConfig } from '@/lib/server/generation-pipeline/search';

const mocks = vi.hoisted(() => ({
  managed: {} as Record<string, { apiKey: string; baseUrl?: string; models?: string[] }>,
  disabled: new Set<string>(),
  search: vi.fn(),
}));
vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: (_section: string, id: string) => !!mocks.managed[id],
  isServerProviderDisabled: (_section: string, id: string) => mocks.disabled.has(id),
  resolveServerWebSearchProviderId: () => Object.keys(mocks.managed)[0],
  resolveWebSearchApiKey: (id: string, key?: string) => mocks.managed[id]?.apiKey ?? key ?? '',
  resolveWebSearchBaseUrl: (id: string, url?: string) => mocks.managed[id]?.baseUrl ?? url,
  resolveWebSearchModel: (id: string, model?: string) => mocks.managed[id]?.models?.[0] ?? model,
}));
vi.mock('@/lib/web-search', () => ({
  searchWeb: mocks.search,
  formatSearchResultsAsContext: () => 'Verified search context',
}));

const snapshot: GenerationSearchSnapshotContent = {
  version: 1,
  providerId: 'bocha',
  apiKey: 'owner-search-secret',
  baseUrl: 'https://api.bocha.cn/v1',
};
const input: GenerationInput = {
  version: 1,
  requirements: { requirement: '学习布迪厄的思想', webSearch: true },
  review: { mode: 'manual' },
  webSearch: { providerId: 'bocha' },
  searchConfigRef: { id: '933e566a-7707-43d2-9347-bfce1b79a489', revision: 1 },
  source: { kind: 'home' },
};

function service(value = input, config: GenerationSearchSnapshotContent | undefined = snapshot) {
  const persisted: unknown[] = [];
  const repository: CheckpointRepository = {
    skipStepWithWarning: async () => {},
    beginStep: async (_lease, step) => {
      persisted.push(step);
      return {
        stepId: step.key,
        attemptId: step.key,
        requestKey: step.key,
        status: step.key === 'research:query' ? 'succeeded' : 'running',
        result: { query: '布迪厄 场域 惯习 资本' },
      };
    },
    commitCheckpoint: async (_lease, checkpoint) => {
      persisted.push(checkpoint);
    },
    failStep: async (_lease, failure) => {
      persisted.push(failure);
    },
  };
  const lease: GenerationLease = {
    jobId: 'job-search',
    stageId: 'stage-search',
    ownerId: 'owner-a',
    workerId: 'worker',
    leaseEpoch: 1,
    ownershipEpoch: 1,
    planRevision: 1,
    input: value,
  };
  const execution = new PipelineExecution(repository, lease, new AbortController().signal, {
    run: (_kind, _group, _signal, work) => work(),
  });
  const assets = {
    read: async () => ({ bytes: new Uint8Array(), mimeType: 'text/plain' }),
    write: async () => 'unused',
  };
  return {
    services: new GenerationServices(execution, value, assets, undefined, config),
    persisted,
  };
}

describe('background generation search snapshot consumption', () => {
  beforeEach(() => {
    mocks.managed = {};
    mocks.disabled.clear();
    mocks.search.mockReset().mockResolvedValue({ results: [] });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('uses the owner snapshot for ordinary-mode research without persisting search credentials', async () => {
    const { services, persisted } = service();
    await expect(services.research()).resolves.toBe('Verified search context');
    expect(mocks.search).toHaveBeenCalledWith({
      providerId: 'bocha',
      apiKey: 'owner-search-secret',
      baseUrl: 'https://api.bocha.cn/v1',
      query: '布迪厄 场域 惯习 资本',
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify({ input, persisted })).not.toContain('owner-search-secret');
    expect(JSON.stringify(persisted)).not.toContain('https://api.bocha.cn');
  });

  it('continues ordinary course generation with empty context on an optional search rejection', async () => {
    mocks.search.mockRejectedValue(new Error('Brave Search error (429): Too Many Requests'));
    const { services, persisted } = service();
    await expect(services.research()).resolves.toBe('');
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(persisted).toContainEqual({ stepKey: 'research:search', result: '' });
    expect(JSON.stringify(persisted)).not.toContain('uncertain');
  });

  it('keeps Pro search failures on their original failure path', async () => {
    mocks.managed.bocha = { apiKey: 'server-key' };
    mocks.search.mockRejectedValue(new Error('Search failed'));
    const { services } = service({ ...input, searchConfigRef: undefined, source: { kind: 'pro' } });
    await expect(services.research()).rejects.toThrow('EXTERNAL_RESULT_UNKNOWN');
    expect(mocks.search).toHaveBeenCalledTimes(1);
  });

  it.each([
    new DOMException('Cancelled', 'AbortError'),
    { name: 'AbortError', message: 'Cancelled' },
  ])('never converts search cancellation to a successful empty context (%j)', async (error) => {
    mocks.search.mockRejectedValue(error);
    const { services, persisted } = service();
    await expect(services.research()).rejects.toThrow('EXTERNAL_RESULT_UNKNOWN');
    expect(persisted).not.toContainEqual({ stepKey: 'research:search', result: '' });
  });

  it('ignores client credentials and endpoint for a server-managed provider', async () => {
    mocks.managed.bocha = { apiKey: 'operator-key', baseUrl: 'http://operator-search.internal' };
    const { services } = service(input, { ...snapshot, baseUrl: 'http://127.0.0.1/private' });
    await services.research();
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'operator-key',
        baseUrl: 'http://operator-search.internal',
      }),
    );
  });

  it('rejects missing snapshots, changed selection and operator-disabled providers before searching', async () => {
    expect(() => resolveGenerationSearchConfig(input)).toThrow('WEB_SEARCH_NOT_CONFIGURED');
    for (const changed of [
      { ...snapshot, providerId: 'brave' as const },
      { ...snapshot, modelId: 'different-model' },
    ]) {
      await expect(service(input, changed).services.research()).rejects.toThrow(
        'WEB_SEARCH_NOT_CONFIGURED',
      );
    }
    mocks.disabled.add('bocha');
    mocks.managed.brave = { apiKey: '' };
    await expect(service().services.research()).rejects.toThrow('WEB_SEARCH_NOT_CONFIGURED');
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('preserves Baidu sources and Claude model selection while honoring the server model pin', () => {
    const baiduSubSources = { webSearch: false, baike: true, scholar: true };
    expect(
      resolveGenerationSearchConfig(
        { ...input, webSearch: { providerId: 'baidu' } },
        { version: 1, providerId: 'baidu', apiKey: 'baidu-key', baiduSubSources },
      ),
    ).toMatchObject({ providerId: 'baidu', baiduSubSources });
    const claudeInput = {
      ...input,
      webSearch: { providerId: 'claude', modelId: 'claude-selected' },
    };
    const claudeSnapshot = {
      version: 1 as const,
      providerId: 'claude' as const,
      modelId: 'claude-selected',
      apiKey: 'claude-key',
    };
    expect(resolveGenerationSearchConfig(claudeInput, claudeSnapshot).claudeModelId).toBe(
      'claude-selected',
    );
    mocks.managed.claude = { apiKey: 'server-claude', models: ['claude-pinned'] };
    expect(resolveGenerationSearchConfig(claudeInput, claudeSnapshot).claudeModelId).toBe(
      'claude-pinned',
    );
  });

  it('does not consult search configuration or providers for offline and pre-researched courses', async () => {
    const offline = { ...input, requirements: { requirement: 'test' }, searchConfigRef: undefined };
    await expect(service(offline).services.research()).resolves.toBe('');
    await expect(
      service({ ...input, researchContext: 'Already researched' }).services.research(),
    ).resolves.toBe('Already researched');
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
